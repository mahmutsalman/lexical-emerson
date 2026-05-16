import {
  Component,
  createEffect,
  createMemo,
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
import {
  bytesToBase64,
  listPersistedTerminals,
  markActive,
  onMenuEvent,
  onRescanRequest,
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
    setAllTabs((prev) => [...prev, tab]);
    setActiveForCurrent(tab.id);
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
        for (let i = 0; i < list.length; i++) {
          postSpawn[newTabs[i].id] = buildResumeCommand(
            list[i].claude_session_id,
          );
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

    onCleanup(() => {
      unlistens.forEach((u) => u());
      ro.disconnect();
      stackEl.removeEventListener("wheel", onWheel);
    });
  });

  return (
    <div class={`terminals-view ${is3d() ? "is-3d" : ""}`}>
      <div class="terminal-tabs">
        <For each={projectTabs()}>
          {(tab, idx) => (
            <button
              type="button"
              class={`terminal-tab ${tab.id === activeId() ? "active" : ""}`}
              onClick={() => setActiveForCurrent(tab.id)}
              title={tab.cwd}
            >
              <span class="tab-label">
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
                  <TerminalPane
                    cwd={tab.cwd}
                    projectId={tab.projectId}
                    projectPath={tab.projectPath}
                    onReady={(h) => handles.set(tab.id, h)}
                    onActivity={markActivityForCurrent}
                    onSpawned={(sid) => handlePaneSpawned(tab.id, sid)}
                    zoom={props.zoom}
                    accent={props.accent}
                  />
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
