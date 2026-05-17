import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { Accessor } from "solid-js";
import { emit } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { ProjectNotesPanel } from "./ProjectNotesPanel";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import { TranscriptModal } from "./TranscriptModal";
import {
  bytesToBase64,
  detectClaudeSessionsForCwd,
  listPersistedTerminals,
  markActive,
  onMenuEvent,
  onRescanRequest,
  peekSessionTranscript,
  persistProjectTerminals,
  registerTerminal,
  unregisterTerminal,
  writeTerminal,
} from "../lib/ipc";

interface Tab {
  id: string;
  cwd: string;
  projectPath: string;
  projectId: number;
}

// Recorded against a suspended tab so the user (or our auto-resume path) can
// later inject `claude --resume <uuid>` into a freshly-spawned PTY. The cwd is
// snapshotted so we don't risk reading a stale Tab.cwd after the user has
// re-pointed the same tab elsewhere via shell `cd` between suspend and resume.
interface SuspendedInfo {
  claudeSessionId: string;
  cwd: string;
}

// D1 — auto-suspend tuning. Hardcoded for v1; settings layer deferred (we
// only ship these once we know the defaults feel right in real use).
const AUTO_SUSPEND_MIN = 20;
// One walk per minute is enough — the suspend boundary is N minutes, so a
// 60s sampling rate adds at most ~1 min of slack before suspension fires.
const AUTO_SUSPEND_INTERVAL_MS = 60_000;
// Below this since last PTY output, assume Claude is mid-response. Suspending
// here would cut off a streaming reply. 30 s covers typical inference bursts.
const MID_RESPONSE_THRESHOLD_MS = 30_000;

let tabCounter = 0;
const newTabId = () => `tab-${++tabCounter}`;

export interface TerminalsViewProps {
  cwd: string;
  projectPath: string;
  projectId: number;
  zoom?: Accessor<number>;
  accent?: Accessor<string | null>;
}

export const TerminalsView: Component<TerminalsViewProps> = (props) => {
  // All terminals across all visited projects. xterm instances and their
  // backing PTYs stay alive as long as the entry stays in this array — the
  // user owns the lifecycle by closing tabs explicitly.
  const [allTabs, setAllTabs] = createSignal<Tab[]>([]);
  // PTY session id per Tab.id. Kept OUT of the Tab object on purpose:
  // mutating Tab post-creation would replace its reference, which makes
  // Solid's <For> reconcile it as remove+insert and tear down + recreate
  // the underlying TerminalPane (xterm + PTY). Keeping ids in a sidecar
  // signal lets us record the session id without touching Tab identity.
  const [sessionIdByTab, setSessionIdByTab] = createSignal<
    Record<string, string>
  >({});
  // One-shot shell command to write to a tab's PTY ~250 ms after it spawns.
  // Used by the session-restore path to inject `claude --resume <uuid>` once
  // zsh has printed its prompt. Cleared as soon as the command is dispatched.
  const [postSpawnByTab, setPostSpawnByTab] = createSignal<
    Record<string, string>
  >({});
  const [activeByProject, setActiveByProject] = createSignal<
    Record<string, string>
  >({});
  const [is3dByProject, setIs3dByProject] = createSignal<
    Record<string, boolean>
  >({});
  // D1 — suspended tabs. When an entry is present here, the corresponding
  // Tab in allTabs stays in the array (preserving order + tab title chrome)
  // but its TerminalPane is unmounted (xterm + PTY torn down). The
  // SuspendedPlaceholder renders in its place; clicking it triggers resume.
  const [suspendedByTab, setSuspendedByTab] = createSignal<
    Record<string, SuspendedInfo>
  >({});
  // Per-tab activity timestamps fed by TerminalPane's onInput/onOutput
  // callbacks. Read by the idle-check tick to decide suspend candidates.
  // Default-undefined entries are read as "use mountTsByTab as the baseline."
  const [lastInputAtByTab, setLastInputAtByTab] = createSignal<
    Record<string, number>
  >({});
  const [lastOutputAtByTab, setLastOutputAtByTab] = createSignal<
    Record<string, number>
  >({});
  // Plain Map (not reactive) — only read inside the idle tick and on
  // resume. Keeps a Date.now() per tab id from the moment a tab mounts
  // so a tab with no input AND no output yet is still treated as having
  // a finite "since when have we been idle?" baseline rather than NaN.
  const mountTsByTab = new Map<string, number>();
  const [panelWidth, setPanelWidth] = createSignal(800);
  // True while we're checking SQLite for persisted tabs for this project.
  // Default true so the "ensure ≥1 tab" effect doesn't auto-spawn a stray
  // empty terminal before restoration has a chance to seed the list.
  const [restoring, setRestoring] = createSignal(true);

  let stackEl!: HTMLDivElement;
  const handles = new Map<string, TerminalHandle>();

  const projectTabs = createMemo(() =>
    allTabs().filter((t) => t.projectPath === props.projectPath),
  );

  const activeId = () => activeByProject()[props.projectPath] ?? "";

  // 3D arc layout. Standard CSS-3D carousel math, adapted so the active
  // terminal sits at ~70% size in the centre and the immediate neighbours
  // peek in from the margins. Geometry:
  //
  //   wrapper:  translateZ(-(R + D)) rotateY(-α_active)
  //   face_i:   rotateY(α_i) translateZ(R)
  //
  //   With wrapper undoing α_active and translating back by R+D, the active
  //   face lands at world z = -D (slightly behind the screen plane), which
  //   shrinks it to roughly P/(P+D) of its layout size. The wrapper's extra
  //   translateZ(-D) on top of -R is THE key — without it, the active face
  //   ends up at z = +R, often past the perspective distance, and the whole
  //   scene either clips or implodes.
  const is3d = () =>
    (is3dByProject()[props.projectPath] ?? false) && projectTabs().length >= 2;
  // 45° per slot keeps adjacent neighbours readable while still letting up to
  // 5 terminals fit in front of the viewer (180° arc). For N ≥ 6 the slots
  // pack tighter to stay inside that 180° front-arc.
  const arcDeg = (n: number) => Math.min(180, Math.max(n - 1, 1) * 45);
  const slotAngleDeg = (n: number) => arcDeg(n) / Math.max(n - 1, 1);
  const slotOffsetDeg = (i: number, n: number) =>
    -arcDeg(n) / 2 + i * slotAngleDeg(n);
  // Inscribed cylinder — adjacent faces touch at z = 0 in the cylinder frame
  // (before the wrapper's translateZ pulls everything back). Uses the
  // narrowed face width (62% of viewport), matching `.terminal-host.is-3d`'s
  // width: 62% rule in CSS.
  const FACE_WIDTH_FRAC = 0.62;
  // Notes face occupies slot 0; terminal i occupies slot i+1. So total slot
  // count = terminals + 1, and every cylinder calculation that used to take
  // `projectTabs().length` takes slotCount() instead.
  const slotCount = () => projectTabs().length + 1;
  const radius = () => {
    const n = slotCount();
    if (n < 2) return 0;
    const halfSlotRad = (slotAngleDeg(n) * Math.PI) / 180 / 2;
    return (panelWidth() * FACE_WIDTH_FRAC) / 2 / Math.tan(halfSlotRad);
  };
  const perspectivePx = () => Math.max(panelWidth() * 1.2, 1000);
  const activeIdx = () =>
    projectTabs().findIndex((t) => t.id === activeId());
  // Auto-centre the active terminal: its world angle becomes 0°, facing the
  // viewer straight-on. ⌘K / ⌘⇧K and ⌘⌥→ / ⌘⌥← all cycle the active
  // terminal and let this formula re-centre the cylinder. The active
  // terminal lives at slot (activeIdx + 1) since notes occupies slot 0.
  const wrapperRotation = () => {
    const n = slotCount();
    if (n < 2) return 0;
    const idx = activeIdx();
    if (idx < 0) return 0;
    return -slotOffsetDeg(idx + 1, n);
  };
  // Angle of the notes face — always slot 0 (leftmost), so it sits one slot
  // to the left of whichever terminal is currently centred.
  const notesAngleDeg = () => {
    const n = slotCount();
    if (n < 2) return 0;
    return slotOffsetDeg(0, n);
  };

  const setActiveForCurrent = (id: string) => {
    setActiveByProject((prev) => ({ ...prev, [props.projectPath]: id }));
  };

  const addTerminal = (cwd?: string) => {
    const tab: Tab = {
      id: newTabId(),
      cwd: cwd ?? props.cwd,
      projectPath: props.projectPath,
      projectId: props.projectId,
    };
    mountTsByTab.set(tab.id, Date.now());
    setAllTabs((prev) => [...prev, tab]);
    setActiveForCurrent(tab.id);
  };

  // D1 activity tracking — wired into TerminalPane's onInput/onOutput.
  const handleTabInput = (tabId: string) => {
    setLastInputAtByTab((prev) => ({ ...prev, [tabId]: Date.now() }));
  };
  const handleTabOutput = (tabId: string) => {
    setLastOutputAtByTab((prev) => ({ ...prev, [tabId]: Date.now() }));
  };

  // Suspend a tab: detect its current Claude session UUID, kill the PTY,
  // and mark the tab so the next render swaps TerminalPane for a placeholder.
  // No-op when no Claude session is detectable in the cwd — we wouldn't
  // know what UUID to resume with, so we leave the PTY alive. The act of
  // setting suspendedByTab will trigger Solid to unmount the TerminalPane,
  // and TerminalPane's onCleanup calls closeTerminal(sid) for us. We still
  // call unregisterTerminal first so the global registry never briefly
  // points at a soon-to-die PTY for a tab whose UI is already gone.
  const suspendTab = async (tabId: string) => {
    const tab = allTabs().find((t) => t.id === tabId);
    if (!tab) return;
    if (suspendedByTab()[tabId]) return;
    let uuid: string | undefined;
    try {
      const uuids = await detectClaudeSessionsForCwd(tab.cwd);
      uuid = uuids[0];
    } catch (err) {
      console.warn("[suspend] detect failed:", err);
      return;
    }
    if (!uuid) {
      console.info("[suspend] no Claude session in cwd, skip:", tab.cwd);
      return;
    }
    const sid = sessionIdByTab()[tabId];
    if (sid) {
      unregisterTerminal(sid).catch(() => {});
    }
    handles.delete(tabId);
    setSessionIdByTab((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setSuspendedByTab((prev) => ({
      ...prev,
      [tabId]: { claudeSessionId: uuid, cwd: tab.cwd },
    }));
    console.info("[suspend] tab", tabId, "→ paused", { uuid, cwd: tab.cwd });
  };

  // Resume: queue the post-spawn `claude --resume <uuid>` command BEFORE
  // unsetting the suspended flag, so the moment Solid mounts a fresh
  // TerminalPane and handlePaneSpawned runs, the resume command is waiting
  // in postSpawnByTab[tabId] ready to inject. Reset the activity stamps
  // and mount-baseline to "now" so the just-resumed tab isn't immediately
  // a suspend candidate again on the next idle-check tick.
  const resumeTab = (tabId: string) => {
    const info = suspendedByTab()[tabId];
    if (!info) return;
    setPostSpawnByTab((prev) => ({
      ...prev,
      [tabId]: `claude --resume ${info.claudeSessionId}\n`,
    }));
    setSuspendedByTab((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    const now = Date.now();
    setLastOutputAtByTab((prev) => ({ ...prev, [tabId]: now }));
    setLastInputAtByTab((prev) => ({ ...prev, [tabId]: now }));
    mountTsByTab.set(tabId, now);
    console.info("[resume] tab", tabId, "→ resuming", info);
  };

  // Idle walk: one tick = one scan of this window's tabs against the
  // suspend rule. Protection: never suspend the active tab when its
  // window is focused (the user might be about to type). Mid-response
  // guard: never suspend a tab that emitted PTY output in the last
  // MID_RESPONSE_THRESHOLD_MS (Claude is likely streaming a reply).
  const idleCheckTick = () => {
    const now = Date.now();
    const windowFocused = document.hasFocus();
    const active = activeId();
    for (const tab of projectTabs()) {
      if (suspendedByTab()[tab.id]) continue;
      if (windowFocused && tab.id === active) continue;
      const baseline = mountTsByTab.get(tab.id) ?? now;
      const lastIn = lastInputAtByTab()[tab.id] ?? baseline;
      const lastOut = lastOutputAtByTab()[tab.id] ?? baseline;
      const lastTouch = Math.max(lastIn, lastOut);
      const idleMin = (now - lastTouch) / 60_000;
      if (idleMin < AUTO_SUSPEND_MIN) continue;
      if (now - lastOut < MID_RESPONSE_THRESHOLD_MS) continue;
      void suspendTab(tab.id);
    }
  };

  // Called by TerminalPane once a fresh PTY spawns. Records the session id
  // in a sidecar signal (NOT in the Tab object — see comment on
  // sessionIdByTab above) and registers it with the global terminal
  // registry so other windows (the Bucket Workspace) can discover it.
  const handlePaneSpawned = (tabId: string, sessionId: string) => {
    setSessionIdByTab((prev) => ({ ...prev, [tabId]: sessionId }));
    const tab = allTabs().find((t) => t.id === tabId);
    if (!tab) {
      console.warn("[TerminalsView] handlePaneSpawned: tab not found", tabId);
      return;
    }
    console.info("[TerminalsView] registering", {
      sessionId,
      projectId: tab.projectId,
      projectPath: tab.projectPath,
    });
    registerTerminal(sessionId, tab.projectId, tab.projectPath, null)
      .then(() => console.info("[TerminalsView] register OK", sessionId))
      .catch((err) =>
        console.warn("[TerminalsView] registerTerminal failed:", err),
      );

    // Restore path: a queued shell command (typically `claude --resume <uuid>`)
    // waits for zsh to print its prompt and is then injected once. Delay is
    // a deliberate ~250 ms — short enough to feel snappy, long enough that
    // the prompt has appeared so the command lands on a fresh line.
    const cmd = postSpawnByTab()[tabId];
    if (cmd) {
      setPostSpawnByTab((prev) => {
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      window.setTimeout(() => {
        const bytes = new TextEncoder().encode(cmd);
        writeTerminal(sessionId, bytesToBase64(bytes)).catch((err) =>
          console.warn("post-spawn write failed:", err),
        );
      }, 250);
    }
  };

  // Build the shell command injected after a restored tab's PTY spawns.
  // Rust's `list_persisted_terminals` already nulled out claude_session_id
  // if the .jsonl is gone, so a non-null uuid implies the transcript exists
  // (modulo a tiny race window). The fallback path runs bare `claude`.
  const buildResumeCommand = (claudeSessionId: string | null): string =>
    claudeSessionId
      ? `claude --resume ${claudeSessionId}\n`
      : "claude\n";

  const closeTerminal = (id: string) => {
    const tab = allTabs().find((t) => t.id === id);
    if (!tab) return;
    handles.delete(id);
    const sid = sessionIdByTab()[id];
    if (sid) {
      // Unregister first so the global registry doesn't briefly point at a
      // PTY whose UI is already gone. PtyMessage::Exit will re-emit but the
      // remove is idempotent. TerminalPane's onCleanup calls closeTerminal
      // RPC for us, so we don't need to kill the PTY directly here.
      unregisterTerminal(sid).catch(() => {});
    }
    setSessionIdByTab((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setPostSpawnByTab((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // D1 cleanup — a tab being explicitly closed shouldn't leave its
    // suspend sidecar behind to bloat the records over time.
    setSuspendedByTab((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setLastInputAtByTab((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setLastOutputAtByTab((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    mountTsByTab.delete(id);
    setAllTabs((prev) => prev.filter((t) => t.id !== id));

    // Re-select within the project the closed tab belonged to.
    if (id === activeByProject()[tab.projectPath]) {
      const remaining = allTabs().filter(
        (t) => t.projectPath === tab.projectPath && t.id !== id,
      );
      if (remaining.length > 0) {
        setActiveByProject((prev) => ({
          ...prev,
          [tab.projectPath]: remaining[remaining.length - 1].id,
        }));
      } else if (tab.projectPath === props.projectPath) {
        // Last terminal in the *current* project: spawn a fresh one so the
        // user is never left looking at an empty terminal stack.
        addTerminal();
      } else {
        // Last terminal in a non-active project: just clear the active mark.
        setActiveByProject((prev) => {
          const next = { ...prev };
          delete next[tab.projectPath];
          return next;
        });
      }
    }
  };

  const cycleTerminal = (delta: number) => {
    const arr = projectTabs();
    if (arr.length < 2) return;
    const idx = arr.findIndex((t) => t.id === activeId());
    if (idx === -1) return;
    const next = (idx + delta + arr.length) % arr.length;
    setActiveForCurrent(arr[next].id);
  };

  // Whenever the project changes (or on first mount), ensure this project
  // has at least one terminal and a valid active id. Suspended while the
  // restore lookup is in flight so we don't spawn an empty terminal that
  // gets immediately superseded by restored tabs.
  createEffect(() => {
    if (restoring()) return;
    const path = props.projectPath;
    const ptabs = projectTabs();
    const current = activeByProject()[path];
    if (ptabs.length === 0) {
      addTerminal();
    } else if (!current || !ptabs.find((t) => t.id === current)) {
      setActiveByProject((prev) => ({ ...prev, [path]: ptabs[0].id }));
    }
  });

  // Focus the active tab whenever it changes. Belt + suspenders: macOS menu
  // accelerators (⌘K, ⌘⌥3, ⌘⌥←/→) capture the keystroke and seem to
  // restore focus AFTER our microtask runs, parking it back on the previous
  // active. The setTimeout backup re-focuses on a later turn, beating the
  // OS focus restoration.
  const focusActive = () => {
    const id = activeId();
    if (!id) return;
    queueMicrotask(() => handles.get(id)?.focus());
    setTimeout(() => handles.get(id)?.focus(), 50);
  };
  createEffect(() => {
    activeId();
    focusActive();
  });
  // Same belt-and-suspenders on 3D toggle — the accelerator that triggered
  // it stole the textarea's focus.
  createEffect(() => {
    is3d();
    focusActive();
  });

  // 30s-debounced project-activity ping.
  let lastMarked = 0;
  const markActivityForCurrent = () => {
    const now = Date.now();
    if (now - lastMarked < 30_000) return;
    lastMarked = now;
    const path = props.projectPath;
    markActive(path).catch((err) =>
      console.warn("mark_active failed:", err),
    );
  };

  onMount(async () => {
    // Session restore: seed tabs from SQLite BEFORE the auto-spawn effect
    // unblocks. Rust applies the per-bucket gate; if the project isn't in
    // any auto-restore bucket the list comes back empty.
    try {
      const list = await listPersistedTerminals(props.projectId);
      if (list.length > 0) {
        const newTabs: Tab[] = list.map((entry) => ({
          id: newTabId(),
          cwd: entry.cwd,
          projectPath: props.projectPath,
          projectId: props.projectId,
        }));
        const postSpawn: Record<string, string> = {};
        const now = Date.now();
        for (let i = 0; i < list.length; i++) {
          postSpawn[newTabs[i].id] = buildResumeCommand(
            list[i].claude_session_id,
          );
          // D1 — restored tabs need a mount baseline too so the idle-check
          // doesn't immediately treat them as 20 min old.
          mountTsByTab.set(newTabs[i].id, now);
        }
        setPostSpawnByTab((prev) => ({ ...prev, ...postSpawn }));
        setAllTabs((prev) => [...prev, ...newTabs]);
        setActiveForCurrent(newTabs[newTabs.length - 1].id);
      }
    } catch (err) {
      console.warn("listPersistedTerminals failed:", err);
    } finally {
      setRestoring(false);
    }

    // Persist on window close: take a snapshot of the project's ordered cwds
    // and ship it to Rust before the window destroys itself. Rust applies
    // the per-bucket gate and runs Claude-session detection; if the gate is
    // closed, prior rows are cleaned up so they don't auto-restore later.
    const win = getCurrentWebviewWindow();
    const unlistenClose = await win.onCloseRequested(async (event) => {
      event.preventDefault();
      // Persist is best-effort: if Rust hangs (mutex contention, slow FS),
      // we still need to destroy the window so the user isn't stuck staring
      // at a window that won't close. 1.5s is the upper bound on a healthy
      // persist call (a few SQLite writes + a dir scan).
      const PERSIST_TIMEOUT_MS = 1500;
      console.info("[close] persist starting", { projectId: props.projectId });
      try {
        const cwds = projectTabs().map((t) => t.cwd);
        await Promise.race([
          persistProjectTerminals(props.projectId, cwds).then(() =>
            console.info("[close] persist resolved"),
          ),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("persist timeout")),
              PERSIST_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (err) {
        console.warn("[close] persistProjectTerminals failed/timeout:", err);
      }
      console.info("[close] destroying window");
      await win.destroy();
    });

    const unlistens: UnlistenFn[] = await Promise.all([
      onMenuEvent("terminal-new", () => addTerminal()),
      onMenuEvent("terminal-close", () => {
        const id = activeId();
        if (id) closeTerminal(id);
      }),
      onMenuEvent("terminal-next", () => cycleTerminal(1)),
      onMenuEvent("terminal-prev", () => cycleTerminal(-1)),
      onMenuEvent("terminal-toggle-3d", () => {
        // No-op with fewer than 2 terminals — nothing to fan out.
        if (projectTabs().length < 2) return;
        setIs3dByProject((prev) => ({
          ...prev,
          [props.projectPath]: !prev[props.projectPath],
        }));
      }),
      // When the workspace asks every window to re-register their PTYs,
      // walk our own session map and re-call registerTerminal. Catches
      // terminals that were spawned before the registry shipped, or that
      // missed registration for any other reason.
      onRescanRequest(() => {
        const sids = sessionIdByTab();
        for (const tab of allTabs()) {
          const sid = sids[tab.id];
          if (!sid) continue;
          registerTerminal(sid, tab.projectId, tab.projectPath, null).catch(
            (err) => console.warn("rescan register failed:", err),
          );
        }
      }),
    ]);
    unlistens.push(unlistenClose);

    // When the window regains focus (e.g. via ⌘J / ⌘⇧J cycling), force a fit
    // on the visible terminal. Without this, xterm's Canvas renderer keeps
    // a stale viewport from before the WKWebView was occluded — rows render
    // overlapped or off-by-cell. fitNow() always runs term.resize() which
    // internally triggers a full canvas repaint even if cols/rows match.
    const unlistenFocus = await win.onFocusChanged((event) => {
      if (!event.payload) return;
      const id = activeId();
      if (!id) return;
      const handle = handles.get(id);
      handle?.fitNow();
    });
    unlistens.push(unlistenFocus);

    // Prime panelWidth synchronously so the first 3D toggle has correct
    // geometry, even before ResizeObserver gets its first callback.
    if (stackEl?.clientWidth) setPanelWidth(stackEl.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPanelWidth(e.contentRect.width);
    });
    ro.observe(stackEl);

    // WebKit won't route wheel→scroll to overflow:scroll descendants of a
    // 3D-transformed ancestor (the .cylinder), so xterm's native trackpad
    // scrollback dies the moment 3D view turns on. Intercept the wheel here
    // and drive the facing terminal's scrollLines manually. 2D path is
    // untouched — we early-return so xterm keeps its native, momentum-aware
    // scroll behaviour.
    const onWheel = (e: WheelEvent) => {
      if (!is3d()) return;
      if (e.deltaY === 0) return;
      const id = activeId();
      if (!id) return;
      const handle = handles.get(id);
      if (!handle) return;
      const sign = e.deltaY > 0 ? 1 : -1;
      // Trackpad sends ~1–4px per tick; mouse wheels send ~100px. Divide by
      // ~18 (rough cell height at default zoom) and floor to at least 1 line
      // so the smallest trackpad nudge still produces motion.
      const magnitude = Math.max(1, Math.round(Math.abs(e.deltaY) / 18));
      handle.scrollLines(sign * magnitude);
      e.preventDefault();
    };
    stackEl.addEventListener("wheel", onWheel, { passive: false });

    // D1 — start the idle-check loop. window.setInterval returns a number
    // ID; cleared in onCleanup. The tick is cheap (a single signal read +
    // arithmetic per tab, then async suspendTab for each candidate), so
    // running it in every project window is fine.
    const idleInterval = window.setInterval(
      idleCheckTick,
      AUTO_SUSPEND_INTERVAL_MS,
    );

    onCleanup(() => {
      unlistens.forEach((u) => u());
      ro.disconnect();
      stackEl.removeEventListener("wheel", onWheel);
      clearInterval(idleInterval);
    });
  });

  return (
    <div class={`terminals-view ${is3d() ? "is-3d" : ""}`}>
      <div class="terminal-tabs">
        <For each={projectTabs()}>
          {(tab, idx) => (
            <button
              type="button"
              class={`terminal-tab ${tab.id === activeId() ? "active" : ""} ${
                suspendedByTab()[tab.id] ? "suspended" : ""
              }`}
              onClick={() => {
                setActiveForCurrent(tab.id);
                // Click on a suspended tab's title also wakes it — saves a
                // second click through the placeholder for the common case
                // of "I'm focusing this tab to use it again."
                if (suspendedByTab()[tab.id]) resumeTab(tab.id);
              }}
              title={suspendedByTab()[tab.id] ? `${tab.cwd} — suspended (click to resume)` : tab.cwd}
            >
              <span class="tab-label">
                <Show when={suspendedByTab()[tab.id]}>
                  <span class="tab-suspend-glyph" aria-label="suspended">◌</span>{" "}
                </Show>
                {idx() + 1}. {basename(tab.cwd)}
              </span>
              <span
                class="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(tab.id);
                }}
                title="Close terminal"
              >
                ×
              </span>
            </button>
          )}
        </For>
        <button
          type="button"
          class="terminal-tab-add"
          onClick={() => addTerminal()}
          title="New terminal (⌘T)"
        >
          +
        </button>
      </div>
      <div
        class="terminal-stack"
        ref={stackEl}
        style={
          is3d() ? { perspective: `${perspectivePx()}px` } : undefined
        }
      >
        <div
          class={`cylinder ${is3d() ? "is-3d" : ""}`}
          style={
            is3d()
              ? {
                  transform: `translateZ(${-radius()}px) rotateY(${wrapperRotation()}deg)`,
                }
              : undefined
          }
        >
          {/* Notes face — occupies slot 0 of the cylinder so it rotates
              with terminals during ⌘⌥←/→ navigation. Same face dimensions
              (.terminal-host.is-3d) so the rail sits inside the standard
              62% pane box at the same slot angle as the other faces. */}
          <Show when={is3d()}>
            <div
              class="terminal-host is-3d is-notes"
              style={
                {
                  display: "flex",
                  transform: `rotateY(${notesAngleDeg()}deg) translateZ(${radius()}px)`,
                  "--pane-accent": props.accent?.() ?? "",
                } as Record<string, string>
              }
            >
              <ProjectNotesPanel
                projectId={() => props.projectId}
                onOpenEditor={() => void emit("menu-event", "notes-open")}
              />
            </div>
          </Show>
          <For each={allTabs()}>
            {(tab) => {
              const inThisProject = () =>
                tab.projectPath === props.projectPath;
              const tabIdx = () =>
                projectTabs().findIndex((t) => t.id === tab.id);
              const isFacing = () => tab.id === activeId();
              const hostStyle = () => {
                if (!inThisProject()) return { display: "none" };
                if (!is3d()) {
                  return {
                    display: isFacing() ? "flex" : "none",
                  } as Record<string, string>;
                }
                const idx = tabIdx();
                if (idx < 0) return { display: "none" };
                const n = slotCount();
                // Terminal i is at slot i+1 (notes takes slot 0).
                const angle = slotOffsetDeg(idx + 1, n);
                const r = radius();
                return {
                  display: "flex",
                  transform: `rotateY(${angle}deg) translateZ(${r}px)`,
                } as Record<string, string>;
              };
              return (
                <div
                  class={`terminal-host ${is3d() && inThisProject() ? "is-3d" : ""} ${
                    is3d() && isFacing() ? "is-facing" : ""
                  }`}
                  style={hostStyle()}
                >
                  <Show
                    when={!suspendedByTab()[tab.id]}
                    fallback={
                      <SuspendedPlaceholder
                        cwd={tab.cwd}
                        info={suspendedByTab()[tab.id]}
                        onResume={() => resumeTab(tab.id)}
                      />
                    }
                  >
                    <TerminalPane
                      cwd={tab.cwd}
                      projectId={tab.projectId}
                      projectPath={tab.projectPath}
                      onReady={(h) => handles.set(tab.id, h)}
                      onActivity={markActivityForCurrent}
                      onInput={() => handleTabInput(tab.id)}
                      onOutput={() => handleTabOutput(tab.id)}
                      onSpawned={(sid) => handlePaneSpawned(tab.id, sid)}
                      zoom={props.zoom}
                      accent={props.accent}
                    />
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
};

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// Format an ISO timestamp as a short relative-time string ("12m ago",
// "3h ago", "2d ago"). Used for the "last activity" line in the placeholder
// header. Returns "" for null / unparseable input so the caller can
// conditionally render the field.
function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

// Rendered in place of TerminalPane when a tab is suspended (D1 +
// D2 composite). Three layers stacked vertically:
//
//   1. Status row: ◌ glyph + "Suspended (idle)" + last-activity timestamp
//   2. Preview card: first ~220 chars of the most recent assistant text
//      (fetched once via peekSessionTranscript). Gives context so the user
//      remembers what this session was about before deciding.
//   3. Action row: "Read transcript" (opens TranscriptModal) and
//      "Resume session" (existing resumeTab path), side-by-side.
//
// The Resume button is auto-focused on mount so Enter / Space still
// resumes the way D1 did, even now that there are two buttons. Tab
// moves to Read transcript.
const SuspendedPlaceholder: Component<{
  cwd: string;
  info: SuspendedInfo;
  onResume: () => void;
}> = (props) => {
  const [peek] = createResource(
    () => ({ cwd: props.cwd, sessionId: props.info.claudeSessionId }),
    async (k) => {
      try {
        return await peekSessionTranscript(k.cwd, k.sessionId);
      } catch (err) {
        console.warn("[suspended] peek failed:", err);
        return null;
      }
    },
  );
  const [modalOpen, setModalOpen] = createSignal(false);

  let resumeBtnEl!: HTMLButtonElement;
  onMount(() => {
    // Single-frame defer keeps us out of fight-club with the parent
    // window's focus rules during the suspended→placeholder transition.
    // Focus the PRIMARY action so Enter still resumes (matching D1 UX);
    // Tab moves to "Read transcript" for the deliberate-read path.
    queueMicrotask(() => resumeBtnEl?.focus());
  });

  return (
    <>
      <div class="terminal-suspended">
        <div class="terminal-suspended-status">
          <span class="terminal-suspended-glyph" aria-hidden="true">◌</span>
          <div class="terminal-suspended-status-text">
            <div class="terminal-suspended-title">Suspended (idle)</div>
            <Show when={peek()?.last_at}>
              <div class="terminal-suspended-since">
                last activity {formatRelative(peek()?.last_at)}
              </div>
            </Show>
          </div>
        </div>

        <Show
          when={peek() && peek()!.last_assistant_preview}
          fallback={
            <Show
              when={peek.loading}
              fallback={
                <div class="terminal-suspended-preview is-empty">
                  No assistant reply in this session yet.
                </div>
              }
            >
              <div class="terminal-suspended-preview is-loading">
                Loading preview…
              </div>
            </Show>
          }
        >
          <div class="terminal-suspended-preview">
            <div class="terminal-suspended-preview-label">last message</div>
            <p class="terminal-suspended-preview-body">
              {peek()!.last_assistant_preview}
              <span class="terminal-suspended-preview-ellipsis">…</span>
            </p>
          </div>
        </Show>

        <div class="terminal-suspended-actions">
          <button
            type="button"
            class="terminal-suspended-btn is-secondary"
            onClick={() => setModalOpen(true)}
            title="Open the full transcript (read-only)"
          >
            <span aria-hidden="true">📖</span> Read transcript
          </button>
          <button
            type="button"
            class="terminal-suspended-btn is-primary"
            ref={resumeBtnEl}
            onClick={() => props.onResume()}
            title={`claude --resume ${props.info.claudeSessionId}`}
          >
            <span aria-hidden="true">▶</span> Resume session
          </button>
        </div>

        <div class="terminal-suspended-session-id">
          {props.info.claudeSessionId.slice(0, 8)}…
        </div>
      </div>

      <TranscriptModal
        open={modalOpen}
        cwd={props.cwd}
        sessionId={props.info.claudeSessionId}
        onClose={() => setModalOpen(false)}
        onResume={() => props.onResume()}
      />
    </>
  );
};
