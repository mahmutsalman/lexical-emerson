import {
  batch,
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
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  closestCenter,
  DragDropProvider,
  DragDropSensors,
  createSortable,
  SortableProvider,
  transformStyle,
  type DragEvent as SolidDndDragEvent,
} from "@thisbeyond/solid-dnd";

// Tell TS about the `use:sortable` directive — solid-dnd doesn't ship
// this augmentation, and Solid's JSX compiler needs the directive name
// to resolve to a value type in JSX.Directives or TS rejects the
// attribute.
declare module "solid-js" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface Directives {
      sortable: true;
    }
  }
}

import { BucketWorkspaceDebugLog } from "./BucketWorkspaceDebugLog";
import { NotesModal } from "./NotesModal";
import { ProjectNotesPanel } from "./ProjectNotesPanel";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import { TimerModal } from "./TimerModal";
import { TimerRail, dispatchOpenTimer } from "./TimerRail";
import { createTimerStore } from "../lib/timer-store";
import { flashElement, playFinishBell } from "../lib/timer-effects";
import {
  closeTerminal,
  debugInsertFakeRegistryEntry,
  emitMenuEventLocal,
  listAllRegisteredTerminals,
  listBuckets,
  listTerminalsForBucket,
  onBucketsChanged,
  onMenuEvent,
  onTerminalsChanged,
  registerTerminal,
  reorderBucketProjects,
  rescanTerminals,
  unregisterTerminal,
} from "../lib/ipc";
import { isColorTag, PALETTE } from "../lib/palette";
import type { Bucket, Project, PtyTerminalInfo } from "../lib/types";

export interface BucketWorkspaceProps {
  bucketId: number;
}

type WorkspaceMode = "flat" | "3d";

interface WorkspaceTab {
  // Stable local id used for UI keying. NEVER mutated post-creation —
  // mutating any Tab field would change its object reference and force
  // Solid's <For> to unmount + remount the row's TerminalPane, which kills
  // and respawns the PTY in a loop. (Hit this bug on first integration
  // pass. See sessionIdByLocalTab comment in BucketWorkspace below.)
  id: string;
  // Attached tabs (discovered in the registry) ship with their pty_id
  // already known; owned tabs (spawned by this workspace) start undefined
  // and learn their pty_id via TerminalPane.onSpawned. We store the
  // late-bound sessionId in a sidecar signal map keyed by Tab.id so the
  // Tab object stays reference-stable.
  sessionId?: string;
  projectId: number;
  projectPath: string;
  projectName: string;
  cwd: string;
  // True when this workspace spawned the PTY (via its + button). False when
  // we attached to an existing PTY that another window created.
  owned: boolean;
}

let tabCounter = 0;
const newTabId = () => `bw-tab-${++tabCounter}`;

// Sentinel stored in activeByProject when the user has navigated to a
// project's notes face (slot 0 of the per-project cylinder) rather than
// any of its terminals. Chosen to be impossible to collide with the
// `bw-tab-N` ids produced by newTabId().
const NOTES_SENTINEL = "__notes__";

export const BucketWorkspace: Component<BucketWorkspaceProps> = (props) => {
  const [bucketKey, setBucketKey] = createSignal(0);
  const [bucket] = createResource<Bucket | null, number>(
    () => bucketKey(),
    async () => {
      const list = await listBuckets();
      return list.find((b) => b.id === props.bucketId) ?? null;
    },
  );

  const [tabs, setTabs] = createSignal<WorkspaceTab[]>([]);
  // Sidecar map for owned tabs' late-bound sessionIds (set by
  // handlePaneSpawned). See WorkspaceTab.id comment above for why this is
  // kept OUT of the Tab object.
  const [sessionIdByLocalTab, setSessionIdByLocalTab] = createSignal<
    Record<string, string>
  >({});
  const [activeProjectIdx, setActiveProjectIdx] = createSignal(0);
  const [activeByProject, setActiveByProject] = createSignal<
    Record<string, string>
  >({});
  const [mode, setMode] = createSignal<WorkspaceMode>("flat");
  const [panelWidth, setPanelWidth] = createSignal(800);
  // Diagnostic: total registry size (across all projects, all buckets).
  // Surfaced in the header so we can tell at a glance whether per-project
  // windows are populating the registry. Updated by reconcile and the
  // Re-scan button.
  const [registryTotal, setRegistryTotal] = createSignal(0);
  // Diagnostic: full registry contents so the user can see at a glance
  // which PTYs are registered, and to which project_id they map. Used by
  // the debug strip below the header.
  const [registryEntries, setRegistryEntries] = createSignal<PtyTerminalInfo[]>([]);
  const [showDebug, setShowDebug] = createSignal(false);
  // Toggleable click/key/wheel event-capture log. Off by default; ⌘⌥D
  // flips it. Diagnostic for the notes-pane click bug and any future
  // event-routing issues inside the 3D-transformed subtree.
  const [showEventLog, setShowEventLog] = createSignal(false);

  // Lookup effective sessionId for a tab: attached tabs carry it on the
  // Tab object; owned tabs learn it via the sidecar map.
  const effectiveSid = (t: WorkspaceTab): string | undefined =>
    t.sessionId ?? sessionIdByLocalTab()[t.id];

  let stackEl!: HTMLDivElement;
  // Flash overlay used to signal a timer-finish event. Lives inside
  // .bw-stack so the flash is constrained to the workspace area (not the
  // window chrome). Wired up below in onMount via timerStore.onFinish.
  let flashEl: HTMLDivElement | undefined;

  // Per-project focus timer. State is keyed by project path so each ring
  // has its own countdown; the rail at top-right shows the ACTIVE
  // project's countdown. Modal is opened by a window-level CustomEvent
  // dispatched from the rail's click handler.
  const timerStore = createTimerStore();
  onCleanup(() => timerStore.dispose());
  // TerminalPane handles keyed by tab.id. Used to force-fit xterm after a
  // mode change — WebKit doesn't always fire ResizeObserver on the CSS
  // class swaps that 2D ↔ 3D triggers, so we drive a manual fit from
  // here when mode() changes.
  const handles = new Map<string, TerminalHandle>();

  // Park keyboard focus on the workspace container after a 3D navigation
  // (or any other time we need to defensively pull focus off xterm).
  //
  // xterm.js routes keystrokes through an offscreen .xterm-helper-textarea
  // owned by each Terminal instance. When the user ⌘⌥-navigates between
  // rings/terminals in 3D mode, the previously-facing pane gets rotated
  // out of view via CSS transform — but the textarea inside it retains
  // browser focus, so the user's next keystroke still gets delivered to
  // the hidden terminal. The user lived this exact failure: typed
  // "ddsdsdsd…" into what they thought was the facing pane, then
  // navigated and found the keystrokes parked in the next terminal.
  //
  // Calling .blur() on the .xterm host element doesn't always cascade to
  // the inner textarea in WebKit, so we find the focused element via
  // document.activeElement and blur it directly. Then we anchor focus to
  // .bw-stack (tabIndex=-1, outline:none) so the next keystroke is
  // delivered to our window-level onWorkspaceKey handler, which can
  // route correctly.
  const parkFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      try {
        active.blur();
      } catch {
        // ignore — blur should be safe but some custom elements throw
      }
    }
    if (stackEl) {
      try {
        stackEl.focus({ preventScroll: true });
      } catch {
        // ignore — focusing a non-focusable element throws in some
        // browsers; we set tabIndex=-1 to make it focusable, but if the
        // ref isn't bound yet we'd rather no-op than crash.
      }
    }
  };

  const projects = createMemo<Project[]>(() => bucket()?.projects ?? []);

  const activeProject = (): Project | null =>
    projects()[activeProjectIdx()] ?? null;

  // Accent color for the always-visible project chip, derived from the
  // active project's PALETTE entry. As a separate memo so the chip's
  // inline-style update flows from activeProject() reactivity AND the
  // `isColorTag` type guard works without an `as` cast.
  const chipAccent = createMemo<string>(() => {
    const p = activeProject();
    if (!p) return "";
    return isColorTag(p.color) ? PALETTE[p.color].accent : "";
  });

  const tabsForProject = (path: string) =>
    tabs().filter((t) => t.projectPath === path);

  const activeTabId = (): string | null => {
    const p = activeProject();
    if (!p) return null;
    return activeByProject()[p.path] ?? null;
  };

  // Reconcile our local tab list against the live PTY registry. Drops
  // tabs whose PTYs have died (whether owned or attached) and adds new
  // attached tabs for live registry entries we haven't seen yet.
  //
  // We also compute the active-tab-per-project selection here and commit
  // both updates in a single Solid `batch`, so the very first render after
  // a fresh open shows the active pane already at display:flex. Otherwise
  // there's a flash where panes mount at display:none (no active id yet),
  // a follow-up effect populates activeByProject, and the panes flip to
  // display:flex AFTER TerminalPane has already run its initial
  // fitAddon.fit() on a 0×0 host element — leaving xterm stuck at zero
  // dimensions because WebKit doesn't always fire ResizeObserver on a
  // display:none→flex transition.
  const reconcile = async () => {
    try {
      const live: PtyTerminalInfo[] = await listTerminalsForBucket(
        props.bucketId,
      );
      const liveIds = new Set(live.map((t) => t.pty_id));
      const projectNameById = new Map(
        projects().map((p) => [p.id, p.name] as const),
      );

      // Snapshot sidecar map so survivors check matches what handlePaneSpawned
      // would have recorded for owned tabs.
      const sidMap = sessionIdByLocalTab();

      // Build the new tabs array.
      const prev = tabs();
      const survivors = prev.filter((t) => {
        const sid = t.sessionId ?? sidMap[t.id];
        return sid == null || liveIds.has(sid);
      });
      const existingPtyIds = new Set(
        survivors
          .map((t) => t.sessionId ?? sidMap[t.id])
          .filter((s): s is string => s !== undefined),
      );
      const adds: WorkspaceTab[] = [];
      for (const info of live) {
        if (existingPtyIds.has(info.pty_id)) continue;
        adds.push({
          id: newTabId(),
          sessionId: info.pty_id,
          projectId: info.project_id,
          projectPath: info.project_path,
          projectName: projectNameById.get(info.project_id) ?? "",
          cwd: info.project_path,
          owned: false,
        });
      }
      const nextTabs = [...survivors, ...adds];

      // Compute the active-tab-per-project selection from the new tabs.
      // Preserves any existing active selection that's still valid;
      // otherwise picks the last tab of the project (most recently added).
      const prevActive = activeByProject();
      const nextActive: Record<string, string> = { ...prevActive };
      let activeChanged = false;
      const byProject = new Map<string, WorkspaceTab[]>();
      for (const t of nextTabs) {
        const list = byProject.get(t.projectPath) ?? [];
        list.push(t);
        byProject.set(t.projectPath, list);
      }
      // Walk every project (not just those with tabs) so projects with
      // only a notes face (no terminals) still get the sentinel set,
      // making the notes face navigable as the project's "active" slot.
      const projectPaths = new Set<string>();
      for (const p of projects()) {
        projectPaths.add(p.path);
        const arr = byProject.get(p.path) ?? [];
        const current = nextActive[p.path];
        if (current === NOTES_SENTINEL) continue;
        if (arr.length === 0) {
          if (current !== NOTES_SENTINEL) {
            nextActive[p.path] = NOTES_SENTINEL;
            activeChanged = true;
          }
        } else if (!current || !arr.find((t) => t.id === current)) {
          nextActive[p.path] = arr[arr.length - 1].id;
          activeChanged = true;
        }
      }
      // Drop active entries for projects that aren't in the bucket anymore.
      for (const path of Object.keys(prevActive)) {
        if (!projectPaths.has(path)) {
          delete nextActive[path];
          activeChanged = true;
        }
      }

      batch(() => {
        setTabs(nextTabs);
        if (activeChanged) setActiveByProject(nextActive);
      });

      // Prune any handle-map entries whose tabs no longer exist. Each
      // surviving TerminalPane's onCleanup ALSO calls onDeregister for
      // itself, but reconcile can drop a tab without triggering Solid
      // unmount in the same tick (e.g. when an attached tab's PTY dies
      // and registry pruning fires terminals://changed). Belt-and-braces
      // sweep here keeps `handles` aligned with `tabs` regardless of
      // teardown order.
      const surviving = new Set(nextTabs.map((t) => t.id));
      for (const id of Array.from(handles.keys())) {
        if (!surviving.has(id)) handles.delete(id);
      }

      // Surface the total registry size for the diagnostic strip.
      try {
        const all = await listAllRegisteredTerminals();
        setRegistryTotal(all.length);
        setRegistryEntries(all);
      } catch (err) {
        console.warn("listAllRegisteredTerminals failed:", err);
      }
    } catch (err) {
      console.warn("reconcile failed:", err);
    }
  };

  // Diagnostic: directly write a fake entry into pty_registry — proves
  // the read path works in isolation from the spawn path. If after
  // clicking this the entry appears in the debug list, the registry/
  // broadcast is fine and the bug is in open_terminal's project info
  // arrival.
  const handleTestInsert = async () => {
    const proj = projects()[activeProjectIdx()];
    if (!proj) {
      console.warn("no active project to test-insert");
      return;
    }
    try {
      await debugInsertFakeRegistryEntry(proj.id, proj.path);
    } catch (err) {
      console.warn("debugInsertFakeRegistryEntry failed:", err);
    }
  };

  const handleRescan = async () => {
    try {
      await rescanTerminals();
    } catch (err) {
      console.warn("rescanTerminals failed:", err);
    }
  };

  // Add a fresh terminal for the given project; the PTY will be spawned by
  // TerminalPane (spawn mode). handlePaneSpawned upgrades the tab once we
  // know the session id, and registers it with the global registry.
  const addOwnedTerminal = (project: Project) => {
    const tab: WorkspaceTab = {
      id: newTabId(),
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      cwd: project.path,
      owned: true,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveByProject((prev) => ({ ...prev, [project.path]: tab.id }));
    // Make sure the project this tab belongs to is the active row, so the
    // newly-created terminal is visible immediately.
    const idx = projects().findIndex((p) => p.id === project.id);
    if (idx >= 0) setActiveProjectIdx(idx);
  };

  const handlePaneSpawned = (tabId: string, sessionId: string) => {
    setSessionIdByLocalTab((prev) => ({ ...prev, [tabId]: sessionId }));
    const tab = tabs().find((t) => t.id === tabId);
    if (!tab) return;
    registerTerminal(sessionId, tab.projectId, tab.projectPath, null).catch(
      (err) => console.warn("registerTerminal failed:", err),
    );
  };

  // Close the terminal globally — kills the PTY, which broadcasts
  // pty://exit, which prunes the registry, which fires
  // terminals://changed. The reconcile that follows would normally drop
  // this tab from EVERY attached window's view; we also remove it locally
  // first so the UI updates immediately rather than waiting for the round
  // trip.
  const handleCloseTab = async (tab: WorkspaceTab) => {
    const sid = effectiveSid(tab);
    // Optimistically remove from local state so the user sees the tab go
    // away immediately. Reconcile is idempotent if our state's already
    // correct.
    setTabs((prev) => prev.filter((t) => t.id !== tab.id));
    setSessionIdByLocalTab((prev) => {
      const next = { ...prev };
      delete next[tab.id];
      return next;
    });
    handles.delete(tab.id);
    if (!sid) return;
    try {
      await unregisterTerminal(sid);
      await closeTerminal(sid);
    } catch (err) {
      console.warn("closeTerminal failed:", err);
    }
  };

  const setActiveForProject = (projectPath: string, tabId: string) => {
    setActiveByProject((prev) => ({ ...prev, [projectPath]: tabId }));
    const idx = projects().findIndex((p) => p.path === projectPath);
    if (idx >= 0) setActiveProjectIdx(idx);
  };

  const cycleTerminalInActive = (delta: number) => {
    const p = activeProject();
    if (!p) return;
    const arr = tabsForProject(p.path);
    // In 3D mode the cylinder has [notes, t0, t1, ...]; ⌘⌥←/→ cycles
    // through that whole ring so the notes face is reachable. In 2D mode
    // the notes face isn't part of the visible carousel, so we keep the
    // legacy terminals-only cycle to preserve existing muscle memory.
    if (mode() === "3d") {
      const total = arr.length + 1;
      if (total < 2) return;
      const currentId = activeByProject()[p.path];
      let currentIdx: number;
      if (currentId === NOTES_SENTINEL) {
        currentIdx = 0;
      } else {
        const ti = arr.findIndex((t) => t.id === currentId);
        if (ti < 0) return;
        currentIdx = ti + 1;
      }
      const nextIdx = (currentIdx + delta + total) % total;
      const nextId = nextIdx === 0 ? NOTES_SENTINEL : arr[nextIdx - 1].id;
      setActiveForProject(p.path, nextId);
      parkFocus();
      return;
    }
    if (arr.length < 2) return;
    const currentId = activeByProject()[p.path];
    const idx = arr.findIndex((t) => t.id === currentId);
    if (idx === -1) return;
    const next = (idx + delta + arr.length) % arr.length;
    setActiveForProject(p.path, arr[next].id);
  };

  const cycleRing = (delta: number) => {
    const n = projects().length;
    if (n < 2) return;
    setActiveProjectIdx((i) => (i + delta + n) % n);
    // Sync park: the createEffect that watches activeProjectIdx() also
    // parks focus, but it runs on Solid's microtask flush — fast enough
    // for most cases, but a user mashing ⌘⌥↓ ↵ in a single frame can
    // beat it. Calling parkFocus() here makes the focus shift
    // synchronous with the navigation so a same-frame Enter can never
    // land on a stale xterm. parkFocus() is idempotent and a no-op in
    // 2D mode (where there's nothing focusable behind a transformed
    // pane).
    if (mode() === "3d") parkFocus();
  };

  // Commit a drag-reorder: rebuild the project-id list in the desired
  // order and persist it. The buckets://changed broadcast that the
  // command emits will refetch our local bucket signal, so we don't
  // mutate `projects()` ourselves — but we DO keep activeProjectIdx
  // pointed at the same project across the move, so the user's
  // selection follows the row visually.
  //
  // `dstIdx` is the destination index relative to the array AFTER
  // src has been removed (matches Array.prototype.splice semantics
  // when called after a removal splice — see solid-dnd's onDragEnd
  // handler below).
  const reorderProjects = async (srcIdx: number, dstIdx: number) => {
    const arr = projects();
    if (srcIdx === dstIdx) return;
    if (srcIdx < 0 || srcIdx >= arr.length) return;
    if (dstIdx < 0 || dstIdx >= arr.length) return;
    const next = arr.slice();
    const [moved] = next.splice(srcIdx, 1);
    next.splice(dstIdx, 0, moved);
    const activeId = activeProject()?.id ?? null;
    try {
      await reorderBucketProjects(
        props.bucketId,
        next.map((p) => p.id),
      );
    } catch (err) {
      console.warn("reorderBucketProjects failed:", err);
      return;
    }
    if (activeId != null) {
      const newIdx = next.findIndex((p) => p.id === activeId);
      if (newIdx >= 0) setActiveProjectIdx(newIdx);
    }
  };

  // solid-dnd's onDragEnd hands us the draggable and the droppable it
  // landed on. SortableProvider treats every row as both, so we just
  // look up the two indices and forward to reorderProjects.
  const handleSortEnd = (event: SolidDndDragEvent) => {
    const { draggable, droppable } = event;
    if (!draggable || !droppable) return;
    const arr = projects();
    const fromIdx = arr.findIndex((p) => p.id === draggable.id);
    const toIdx = arr.findIndex((p) => p.id === droppable.id);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    void reorderProjects(fromIdx, toIdx);
  };

  // SortableProvider needs a flat id list. Memoised so the provider
  // doesn't see a new identity on every render — solid-dnd snapshots
  // initialIds and a fresh array reference each tick would churn its
  // internal store.
  const projectIds = createMemo(() => projects().map((p) => p.id));

  // Ensure activeByProject has a valid selection per project at all times.
  // When a project has no terminals, default the active slot to the notes
  // sentinel so the per-project notes face is always reachable as the
  // ring's "facing" panel — both for the initial empty state and after
  // the user closes the last terminal. When the user has explicitly
  // selected notes, leave that selection alone even if terminals exist.
  createEffect(() => {
    const all = tabs();
    const next = { ...activeByProject() };
    let changed = false;
    for (const p of projects()) {
      const arr = all.filter((t) => t.projectPath === p.path);
      const current = next[p.path];
      if (current === NOTES_SENTINEL) continue;
      if (arr.length === 0) {
        if (current !== NOTES_SENTINEL) {
          next[p.path] = NOTES_SENTINEL;
          changed = true;
        }
      } else if (!current || !arr.find((t) => t.id === current)) {
        next[p.path] = arr[arr.length - 1].id;
        changed = true;
      }
    }
    if (changed) setActiveByProject(next);
  });

  // Clamp activeProjectIdx to a valid range when projects change (e.g., a
  // project was removed from the bucket).
  createEffect(() => {
    const n = projects().length;
    if (n === 0) return;
    if (activeProjectIdx() >= n) setActiveProjectIdx(n - 1);
  });

  // Force every TerminalPane to remeasure after a mode change OR an
  // active-ring switch. The CSS class swap (2D ↔ 3D) changes the pane
  // box size (display flip, inset:0 → inset:0 19%, etc.) but WebKit
  // doesn't reliably fire ResizeObserver on those transitions, so xterm
  // can be left thinking it's still at the pre-flip size — usually 0×0
  // if it ever briefly mounted hidden, which is why the 3D view looked
  // empty with just a cursor. Activating a different ring brings its
  // previously-hidden panes into view; same problem, same fix.
  createEffect(() => {
    mode();
    activeProjectIdx();
    // Schedule several attempts: WebKit's first relayout often happens
    // before the next frame, but the canvas composite for the new
    // dimensions can lag past the transition end (220–320ms).
    [30, 120, 260, 480].forEach((ms) =>
      setTimeout(() => {
        for (const h of handles.values()) h.fitNow();
      }, ms),
    );
  });

  // Enter-to-focus model (replaces an earlier auto-focus effect):
  // ⌘⌥→ / ⌘⌥↓ rotate the cylinder visually but do NOT move focus.
  // The user presses Enter to "step into" the facing pane, and Esc
  // to "step out". This decouples cylinder rotation from focus, so
  // clicks on the notes pane don't race with an auto-focus on a
  // (possibly WebGL-lost) terminal canvas. Keydown listener is wired
  // in the onMount below alongside the wheel handler and ⌘⌥D toggle.
  //
  // Blur-on-navigate: navigation in 3D reactively drops xterm focus
  // so subsequent keystrokes don't leak into the previously-focused
  // terminal. Without this, the user navigates from a focused
  // terminal A to the notes face, presses Enter (intending only to
  // open the notes modal), and Enter ALSO writes a newline into
  // terminal A's shell because xterm-A still owned focus. We take
  // focus AWAY here; the explicit Enter handler takes focus INTO
  // the new pane. 2D mode is click-driven and naturally moves
  // focus on tab switch, so we skip it.
  createEffect(() => {
    if (mode() !== "3d") return;
    activeTabId();
    activeProjectIdx();
    parkFocus();
  });

  // Also fit any newly-ready pane against the current layout — without
  // this, a tab added DURING 3D mode mounts xterm against the pre-fit-now
  // class-application interval (`display:none → flex`) and stays at 0×0
  // until the next mode toggle. Same root cause as the createEffect
  // above; here we react to the pane signalling readiness rather than to
  // mode/active changes.
  const registerHandle = (tabId: string, h: TerminalHandle) => {
    handles.set(tabId, h);
    setTimeout(() => h.fitNow(), 30);
    setTimeout(() => h.fitNow(), 200);
  };

  onMount(async () => {
    // Register listeners FIRST so menu shortcuts pressed during the brief
    // window while the initial reconcile is in flight aren't silently
    // dropped. (Hit this with ⌘⌥3 immediately after open.)
    const unlistens: UnlistenFn[] = await Promise.all([
      onTerminalsChanged(() => {
        void reconcile();
      }),
      onBucketsChanged(() => setBucketKey((v) => v + 1)),
      onMenuEvent("terminal-new", () => {
        const p = activeProject();
        if (p) addOwnedTerminal(p);
      }),
      onMenuEvent("terminal-close", () => {
        const id = activeTabId();
        if (!id) return;
        const tab = tabs().find((t) => t.id === id);
        if (tab) void handleCloseTab(tab);
      }),
      onMenuEvent("terminal-next", () => cycleTerminalInActive(1)),
      onMenuEvent("terminal-prev", () => cycleTerminalInActive(-1)),
      onMenuEvent("terminal-toggle-3d", () => {
        // No-op when there's nothing meaningful to show in 3D.
        if (projects().length === 0) return;
        setMode((m) => (m === "3d" ? "flat" : "3d"));
      }),
      onMenuEvent("bucket-3d-ring-prev", () => cycleRing(-1)),
      onMenuEvent("bucket-3d-ring-next", () => cycleRing(1)),
    ]);

    await reconcile();

    // Prime panel width so 3D geometry has a sane radius before the first
    // ResizeObserver tick lands.
    if (stackEl?.clientWidth) setPanelWidth(stackEl.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPanelWidth(e.contentRect.width);
    });
    if (stackEl) ro.observe(stackEl);

    // Route wheel events to the facing terminal's xterm scrollback. In 3D
    // mode, .bw-pane.is-3d sets pointer-events: none on non-facing panes
    // (deliberate — keeps inactive rings' empty boxes from stealing clicks),
    // which also blocks xterm's native wheel handler the moment the user
    // ⌘⌥→ navigates to a different terminal. The active+facing pane gets
    // pointer-events: auto but its xterm still doesn't reliably receive
    // wheel through the perspective ancestor (the same class of issue
    // ADR-0011 documents for DnD). Mirror TerminalsView's fix: intercept
    // wheel at the stack and drive scrollLines manually on the active
    // terminal's handle.
    const onWheel = (e: WheelEvent) => {
      if (mode() !== "3d") return;
      if (e.deltaY === 0) return;
      const id = activeTabId();
      if (!id) return;
      const handle = handles.get(id);
      if (!handle) return;
      const sign = e.deltaY > 0 ? 1 : -1;
      const magnitude = Math.max(1, Math.round(Math.abs(e.deltaY) / 18));
      handle.scrollLines(sign * magnitude);
      e.preventDefault();
    };
    if (stackEl) stackEl.addEventListener("wheel", onWheel, { passive: false });

    // ⌘⌥D toggles the event-capture overlay. Not wired through Tauri's
    // menu since this is a developer-debug surface — keeping it as a
    // direct window listener avoids polluting the native menu config.
    const onDebugToggle = (e: KeyboardEvent) => {
      if (e.metaKey && e.altKey && (e.key === "d" || e.key === "D" || e.code === "KeyD")) {
        e.preventDefault();
        setShowEventLog((v) => !v);
      }
    };
    window.addEventListener("keydown", onDebugToggle);

    // Enter-to-focus model: Enter steps INTO the facing pane (focuses
    // its xterm, or opens the notes modal if the notes face is
    // facing). Escape steps OUT (blurs the focused xterm so ⌘⌥
    // shortcuts respond cleanly). Only active in 3D mode — 2D is
    // click-driven and doesn't need the gesture.
    //
    // We never intercept Enter while xterm IS the active element —
    // that would break the shell prompt. The closest() check confirms
    // the active element lives inside the facing pane's .xterm host.
    const onWorkspaceKey = (e: KeyboardEvent) => {
      if (mode() !== "3d") return;
      if (e.metaKey || e.altKey || e.ctrlKey) return;

      // If a modal is open, it owns input. Bail before touching focus —
      // otherwise this handler races the modal's own keydown listener and
      // can yank focus to a terminal mid-typing. The overlay divs are
      // only rendered while their respective open() signal is true, so a
      // pure DOM check is the cheapest and most reliable signal here
      // (no extra state plumbing between BucketWorkspace and the modal
      // components).
      if (document.querySelector(".notes-overlay, .timer-overlay")) return;

      const active = document.activeElement;
      const xtermFocused =
        active instanceof HTMLElement &&
        active.closest(".bw-pane.is-3d.is-facing .xterm") !== null;

      if (e.key === "Enter" && !xtermFocused) {
        const p = activeProject();
        const sel = p ? activeByProject()[p.path] : null;
        if (sel === NOTES_SENTINEL) {
          e.preventDefault();
          void emitMenuEventLocal("notes-open");
          return;
        }
        const id = activeTabId();
        if (id) {
          e.preventDefault();
          handles.get(id)?.focus();
        }
        return;
      }

      if (e.key === "Escape" && xtermFocused) {
        e.preventDefault();
        (active as HTMLElement).blur();
        return;
      }
    };
    window.addEventListener("keydown", onWorkspaceKey);

    // Timer finish: subtle bell + a brief radial flash tinted with the
    // finished-project's accent so the user can tell at a glance which
    // ring's session just ended.
    const unsubFinish = timerStore.onFinish((projectPath) => {
      const proj = projects().find((p) => p.path === projectPath) ?? null;
      const accent =
        proj && isColorTag(proj.color) ? PALETTE[proj.color].accent : "#5eead4";
      if (flashEl) {
        flashEl.style.setProperty("--flash-accent", accent);
        flashElement(flashEl, "is-flashing", 1500);
      }
      playFinishBell();
    });
    onCleanup(unsubFinish);

    onCleanup(() => {
      unlistens.forEach((u) => u());
      ro.disconnect();
      if (stackEl) stackEl.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onDebugToggle);
      window.removeEventListener("keydown", onWorkspaceKey);
    });
  });

  // --- 3D geometry (stacked arcs) ------------------------------------------
  //
  // Each project gets its own horizontal arc, sharing the cylinder math
  // from TerminalsView.tsx. The arcs are vertically stacked along Y; a
  // wrapper element translates the stack so the active ring lands at the
  // viewer's eye level, and a small rotateX tilts the stack to convey
  // physical motion when switching projects.
  const FACE_WIDTH_FRAC = 0.62;
  const arcDeg = (n: number) => Math.min(180, Math.max(n - 1, 1) * 45);
  const slotAngleDeg = (n: number) => arcDeg(n) / Math.max(n - 1, 1);
  const slotOffsetDeg = (i: number, n: number) =>
    -arcDeg(n) / 2 + i * slotAngleDeg(n);
  const radiusFor = (n: number) => {
    if (n < 2) return 0;
    const halfSlotRad = (slotAngleDeg(n) * Math.PI) / 180 / 2;
    return (panelWidth() * FACE_WIDTH_FRAC) / 2 / Math.tan(halfSlotRad);
  };
  const perspectivePx = () => Math.max(panelWidth() * 1.2, 1000);
  const ringHeightPx = () => Math.max(360, panelWidth() * 0.42);
  // Domed/fan arrangement: slots farther from facing get translated
  // upward in the ring's local Y. Facing slot stays at the ring's
  // baseline; edge slots lift by `ringHeightPx() * DOME_LIFT_FRAC`.
  // Returns 0 when |angle| is 0 (facing) and the full lift at the
  // arc's extreme. Proportional to ringHeight so the dome stays
  // visually consistent under window resize.
  const DOME_LIFT_FRAC = 0.18;
  const domeLiftPx = (angleDeg: number, n: number) => {
    const half = arcDeg(n) / 2;
    if (half <= 0) return 0;
    const ratio = Math.min(1, Math.abs(angleDeg) / half);
    return ratio * ringHeightPx() * DOME_LIFT_FRAC;
  };
  // Center-of-stack on the active ring: translate so the active is at y=0
  // in viewport coordinates, regardless of which ring index we're on.
  const stackTranslateY = () =>
    -activeProjectIdx() * ringHeightPx();
  // Constant cylindric tilt — small fixed rotateX so the cylinder reads
  // as a 3D enclosing shape (side panes' tops lean toward the camera,
  // wrapping around the facing pane) rather than a flat fan. Was
  // previously a per-idx formula clamped to ±6°, which made each
  // project's active cylinder look subtly different (-3.75° at idx 0,
  // +6° at idx 6 with 7 projects). User wants every project's 3D view
  // to look IDENTICAL while keeping the cylindric wrap, so the value
  // is now a constant -4° regardless of which ring is active. Sign:
  // negative rotateX tilts the top toward the viewer (view from
  // slightly above) — combined with the dome translateY lift, this
  // gives side panes the enclosing "wrapped up-and-around" feel the
  // user described. Tunable from this single number.
  const stackTiltDeg = () => -4;
  // Notes face occupies slot 0 of each ring's cylinder; terminal i sits at
  // slot i+1. Total slot count = arr.length + 1.
  const ringRotationDeg = (projectPath: string) => {
    const arr = tabsForProject(projectPath);
    const n = arr.length + 1;
    if (n < 2) return 0;
    const currentId = activeByProject()[projectPath];
    if (currentId === NOTES_SENTINEL) {
      // User has navigated to the notes face — rotate slot 0 to center.
      return -slotOffsetDeg(0, n);
    }
    const idx = arr.findIndex((t) => t.id === currentId);
    if (idx < 0) {
      // No selected terminal: leave the cylinder centered on the notes
      // face (slot 0) so something readable is always in view.
      return -slotOffsetDeg(0, n);
    }
    return -slotOffsetDeg(idx + 1, n);
  };

  return (
    <Show
      when={bucket()}
      fallback={
        <div class="bw-loading">
          <Show
            when={bucket.state === "errored" || bucket() === null}
            fallback={<span>Loading workspace…</span>}
          >
            <span>Bucket not found.</span>
          </Show>
        </div>
      }
    >
      {(b) => (
        <div class={`bucket-workspace mode-${mode()}`}>
          {/* Hover-zone trigger that brings the auto-hidden header back
              in 3D mode. Lives BEFORE the header in DOM so the CSS
              sibling combinator (`.bw-header-trigger:hover ~ .bw-header`)
              works without JS. Hidden in 2D mode (CSS gates on the
              parent's mode-3d class). */}
          <div class="bw-header-trigger" aria-hidden="true" />
          <BucketWorkspaceDebugLog
            visible={showEventLog}
            onClose={() => setShowEventLog(false)}
          />
          <header class="bw-header">
            <span class="bw-title">{b().name}</span>
            <span
              class="bw-mode-badge"
              classList={{ "is-3d": mode() === "3d" }}
              title="Toggle with ⌘⌥3"
            >
              {mode() === "3d" ? "3D" : "2D"}
            </span>
            <span class="bw-hint">
              {mode() === "3d"
                ? "⌘⌥3 exit · ⌘⌥↑/↓ ring · ⌘⌥←/→ terminal · Enter focus · Esc blur"
                : `${tabs().length} tab${tabs().length === 1 ? "" : "s"} · registry ${registryTotal()}`}
            </span>
            <button
              type="button"
              class="bw-rescan-btn"
              onClick={() => void handleRescan()}
              title="Ask every open project window to re-register its running terminals"
            >
              Re-scan
            </button>
            <button
              type="button"
              class="bw-mode-toggle-btn"
              onClick={() => {
                if (projects().length === 0) return;
                setMode((m) => (m === "3d" ? "flat" : "3d"));
              }}
              title="Toggle 3D view"
            >
              {mode() === "3d" ? "Exit 3D" : "Enter 3D"}
            </button>
            <button
              type="button"
              class="bw-rescan-btn"
              onClick={() => setShowDebug((v) => !v)}
              title="Toggle registry diagnostic strip"
            >
              {showDebug() ? "Hide debug" : "Debug"}
            </button>
          </header>

          {/* Always-visible active-project chip. The .bw-header auto-hides
              in 3D mode, so without this the user has no persistent
              indicator of which project the active ring belongs to. The
              chip uses the same per-project accent (--chip-accent) that
              tints the active pane's frame, so it reads as a peer of the
              ring it labels. Hidden in 2D via CSS — the static header is
              always visible there.

              Rendered AFTER .bw-header so the CSS sibling combinator
              `.bw-header:hover ~ .bw-project-chip` can fade the chip
              out while the header is hover-revealed — otherwise the
              chip would overlap with the bucket title on the left. */}
          <Show when={activeProject()}>
            {(proj) => (
              // proj() is accessed inline (no snapshot to a local) so
              // Solid's reactivity flows through and the chip updates
              // when activeProjectIdx switches the active project. The
              // earlier `const p = proj()` pattern only ran once because
              // Solid's non-keyed <Show> doesn't re-invoke its render
              // prop on truthy → different-truthy transitions.
              <div
                class="bw-project-chip"
                style={
                  { "--chip-accent": chipAccent() } as Record<string, string>
                }
                title={proj().path}
              >
                <span class="bw-project-chip-name">{proj().name}</span>
                <span
                  class="bw-project-chip-pos"
                  title={`Project ${activeProjectIdx() + 1} of ${projects().length} in this bucket`}
                >
                  {activeProjectIdx() + 1}/{projects().length}
                </span>
              </div>
            )}
          </Show>

          {/* Right-edge focus timer. Mirrors the project chip on the left
              edge: stays visible in 3D mode while the header is auto-
              hidden, dispatches a window-level CustomEvent on click which
              the TimerModal listens for. Per-project state lives in
              timerStore; the rail reads the active project's snapshot. */}
          <Show when={activeProject()}>
            {(proj) => (
              <TimerRail
                project={() => proj()}
                store={timerStore}
                accent={() => chipAccent() || null}
                onOpen={() => dispatchOpenTimer(proj().path)}
              />
            )}
          </Show>

          <Show when={showDebug()}>
            <div class="bw-debug">
              <div class="bw-debug-head">
                <span>
                  Bucket project IDs:{" "}
                  {projects().map((p) => p.id).join(", ") || "(none)"}
                </span>
                <button
                  type="button"
                  class="bw-rescan-btn"
                  onClick={() => void handleTestInsert()}
                  title="Insert a debug entry for the active project — verifies the read path works"
                >
                  Test-insert
                </button>
                <button
                  type="button"
                  class="bw-rescan-btn"
                  onClick={() => void reconcile()}
                  title="Re-query the registry"
                >
                  Refresh
                </button>
              </div>
              <Show
                when={registryEntries().length > 0}
                fallback={
                  <div class="bw-debug-empty">
                    Registry is empty. Either (a) project windows aren't
                    calling open_terminal with valid projectId/projectPath,
                    or (b) something is clearing the registry. Click
                    Test-insert to verify the read path in isolation.
                  </div>
                }
              >
                <ul class="bw-debug-list">
                  <For each={registryEntries()}>
                    {(e) => (
                      <li>
                        <code>{e.pty_id.slice(0, 8)}</code> · pid=
                        {e.project_id} ·{" "}
                        <span title={e.project_path}>{e.project_path}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          </Show>

          {/* Tab strip: hidden in 3D mode, visible in 2D. One row per
              project; clicking a row's tab sets it as the global active
              terminal AND focuses that project's ring. Rows are
              reorderable via solid-dnd — DragDropProvider catches the
              drag lifecycle, SortableProvider tracks the live id order,
              and createSortable inside the For wires each row up as
              both draggable and droppable. The PointerSensor's built-in
              250ms / 10px activation threshold means a plain click
              still falls through to onClick. */}
          <DragDropProvider
            onDragEnd={handleSortEnd}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <div class="bw-tabstrip">
              <SortableProvider ids={projectIds()}>
            <For each={projects()}>
              {(p, pi) => {
                const arr = () => tabsForProject(p.path);
                const isActiveRow = () => pi() === activeProjectIdx();
                const rowAccent = () =>
                  isColorTag(p.color) ? PALETTE[p.color].accent : null;
                const handleAdd = (e: MouseEvent) => {
                  e.stopPropagation();
                  addOwnedTerminal(p);
                };
                const sortable = createSortable(p.id);
                return (
                  <div
                    use:sortable
                    class={`bw-tabrow ${isActiveRow() ? "active" : ""} ${
                      rowAccent() ? "has-accent" : "no-accent"
                    } ${sortable.isActiveDraggable ? "is-dragging" : ""}`}
                    style={{
                      // Per-row CSS variable: lets the stylesheet drive
                      // both the always-on identity bar and the
                      // active-state tint from one source of truth.
                      // Null accent falls back to the default
                      // --row-accent defined on .bw-tabrow in CSS.
                      ...(rowAccent()
                        ? ({ "--row-accent": rowAccent() } as Record<
                            string,
                            string
                          >)
                        : {}),
                      // solid-dnd publishes the live translate during a
                      // drag (and the layout shift of neighbouring
                      // rows) through `sortable.transform`. Spreading
                      // its style here is what gives the rows their
                      // smooth slide-out-of-the-way feel.
                      ...transformStyle(sortable.transform),
                    }}
                    onClick={() => setActiveProjectIdx(pi())}
                  >
                    <span class="bw-row-name" title={p.path}>
                      {p.name}
                    </span>
                    <div class="bw-row-tabs">
                      <For each={arr()}>
                        {(tab, ti) => (
                          <button
                            type="button"
                            class={`bw-tab ${
                              activeByProject()[p.path] === tab.id ? "active" : ""
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveForProject(p.path, tab.id);
                            }}
                            title={tab.sessionId ?? "(spawning…)"}
                          >
                            <span class="bw-tab-num">{ti() + 1}.</span>
                            <span class="bw-tab-host">
                              {tab.owned ? "new" : "live"}
                            </span>
                            <span
                              class="bw-tab-close"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleCloseTab(tab);
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
                        class="bw-tab-add"
                        onClick={handleAdd}
                        title="New terminal in this project (⌘T)"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              }}
            </For>
              </SortableProvider>
              <Show when={projects().length === 0}>
                <div class="bw-empty">
                  This bucket has no projects yet. Add a project to the
                  bucket first.
                </div>
              </Show>
            </div>
          </DragDropProvider>

          {/* Per-project notes side rail. Only mounted in 3D mode — in
              flat mode the tab strip carries enough chrome already. The
              rail is absolutely positioned at .bucket-workspace level so
              it sits OUTSIDE the 3D-transformed .bw-stack subtree and
              doesn't get rotated or perspective-projected. */}
          {/* NotesModal scoped to the currently-active project so each
              ring's Edit button has a target in this workspace window
              (App.tsx's modal only mounts when there's a currentProject,
              which the bucket-workspace window doesn't set). */}
          <Show when={activeProject()}>
            {(proj) => <NotesModal projectId={proj().id} />}
          </Show>

          {/* Focus timer modal scoped to the active project. Same scoping
              rationale as NotesModal above: each open window's modal
              targets that window's currently-active ring. */}
          <Show when={activeProject()}>
            {(proj) => (
              <TimerModal
                project={() => proj()}
                store={timerStore}
                accent={() => chipAccent() || null}
              />
            )}
          </Show>

          {/* Terminal panes. Always all rendered, with display managed by
              the per-tab style block below so xterm instances don't get
              torn down when switching tabs. The 3D mode wraps each
              project's panes in a cylinder element and the whole stack in
              a vertically-translated outer wrapper. */}
          <div
            class="bw-stack"
            ref={stackEl}
            tabIndex={-1}
            style={
              mode() === "3d"
                ? { perspective: `${perspectivePx()}px` }
                : undefined
            }
          >
            {/* Timer-finish flash overlay. Lives inside .bw-stack so the
                radial fade is bounded by the cylinder area, not the whole
                window. Pointer-events:none in CSS — clicks pass through. */}
            <div class="bw-timer-flash" ref={flashEl} aria-hidden="true" />
            <div
              class={`bw-rings ${mode() === "3d" ? "is-3d" : ""}`}
              style={
                mode() === "3d"
                  ? {
                      // Order matters: CSS applies the rightmost transform
                      // first to a point, so translateY runs before
                      // rotateX. That puts the active ring at local origin
                      // BEFORE the rotation, so rotateX(tilt) doesn't
                      // shift it in z. The previous order
                      // (translateY ∘ rotateX) left the active ring at
                      // z = activeIdx * ringHeightPx * sin(tilt) — small
                      // for the top ring (tilt≈0 there) but growing for
                      // lower rings, pulling them toward the camera and
                      // making the terminal appear progressively larger
                      // as the user navigated down the stack.
                      transform: `rotateX(${stackTiltDeg()}deg) translateY(${stackTranslateY()}px)`,
                    }
                  : undefined
              }
            >
              <For each={projects()}>
                {(p, pi) => {
                  const arr = () => tabsForProject(p.path);
                  const ringY = () => pi() * ringHeightPx();
                  const ringIsActive = () => pi() === activeProjectIdx();
                  // Per-project accent for the 3D pane frame so the user
                  // can tell at a glance which project owns the terminal
                  // they're looking at. Falls back to the white-tinted
                  // border when the project has no color set.
                  const paneAccent = () =>
                    isColorTag(p.color) ? PALETTE[p.color].accent : null;
                  return (
                    <div
                      class={`bw-ring ${ringIsActive() ? "is-active" : ""}`}
                      style={
                        mode() === "3d"
                          ? { transform: `translateY(${ringY()}px)` }
                          : undefined
                      }
                    >
                      <div
                        class={`bw-cylinder ${mode() === "3d" ? "is-3d" : ""}`}
                        style={
                          // arr.length >= 1 means total slot count
                          // (terminals + notes) is >= 2 — that's the
                          // threshold for engaging the cylinder transform.
                          mode() === "3d" && arr().length >= 1
                            ? {
                                transform: `translateZ(${-radiusFor(arr().length + 1)}px) rotateY(${ringRotationDeg(p.path)}deg)`,
                              }
                            : undefined
                        }
                      >
                        {/* Notes face — slot 0 of this ring's cylinder, so
                            it rotates with the terminals during ⌘⌥←/→.
                            Per-project: each ring has its own notes face
                            scoped to that project's id. Active ring's face
                            is the only one visible (inactive rings are
                            opacity:0 in the existing CSS). */}
                        <Show when={mode() === "3d"}>
                          <div
                            class={`bw-pane is-3d is-notes ${
                              ringIsActive() &&
                              activeByProject()[p.path] === NOTES_SENTINEL
                                ? "is-facing"
                                : ""
                            }`}
                            style={
                              (() => {
                                const n = arr().length + 1;
                                const angle = slotOffsetDeg(0, n);
                                const r = radiusFor(n);
                                const lift = domeLiftPx(angle, n);
                                return {
                                  display: "flex",
                                  // Notes face lives at slot 0 (leftmost
                                  // slot, max |angle|), so the dome lift
                                  // sits it visibly high-left — exactly
                                  // the "fan opening upward" arrangement
                                  // the user asked for.
                                  transform: `rotateY(${angle}deg) translateZ(${r}px) translateY(${-lift}px)`,
                                  "--pane-accent": paneAccent() ?? "",
                                } as Record<string, string>;
                              })()
                            }
                          >
                            <ProjectNotesPanel
                              projectId={() => p.id}
                              onOpenEditor={(noteId) => {
                                // NotesModal is scoped to activeProject(),
                                // so make sure THIS ring's project is the
                                // active one before opening — otherwise
                                // the modal would open against whatever
                                // project was last focused.
                                setActiveProjectIdx(pi());
                                // If the caller picked a specific note,
                                // hint the modal synchronously BEFORE the
                                // Tauri emit so its open-handler picks up
                                // that id instead of defaulting to the
                                // most-recently-updated note.
                                if (noteId != null) {
                                  window.dispatchEvent(
                                    new CustomEvent(
                                      "lexical:notes-open-hint",
                                      { detail: { noteId } },
                                    ),
                                  );
                                }
                                // emitMenuEventLocal scopes the event
                                // target to THIS webview window
                                // (emitTo(label, ...)), so other open
                                // windows' NotesModals don't also pop
                                // open. Plain `emit()` was a broadcast
                                // and was firing every window's modal.
                                void emitMenuEventLocal("notes-open");
                              }}
                            />
                          </div>
                        </Show>
                        <For each={arr()}>
                          {(tab, ti) => {
                            const isFacing = () =>
                              tab.id === activeByProject()[p.path];
                            const inActiveRing = () => ringIsActive();
                            const hostStyle = () => {
                              const accent = paneAccent();
                              const base: Record<string, string> = accent
                                ? { "--pane-accent": accent }
                                : {};
                              if (mode() !== "3d") {
                                // 2D: show only the globally-active tab
                                // (active project's active tab).
                                return {
                                  ...base,
                                  display:
                                    inActiveRing() && isFacing()
                                      ? "flex"
                                      : "none",
                                };
                              }
                              // Cylinder has notes at slot 0 and terminal i
                              // at slot i+1, so total slot count is
                              // arr.length + 1.
                              const n = arr().length + 1;
                              if (n < 2) {
                                return {
                                  ...base,
                                  display: "flex",
                                  transform: "translateZ(0)",
                                };
                              }
                              const angle = slotOffsetDeg(ti() + 1, n);
                              const r = radiusFor(n);
                              const lift = domeLiftPx(angle, n);
                              return {
                                ...base,
                                display: "flex",
                                // translateY runs in the slot's local
                                // frame after rotateY. Since rotateY
                                // preserves the Y axis, this lifts the
                                // slot vertically in world space by the
                                // same amount regardless of its
                                // rotateY — exactly what the domed
                                // arrangement needs.
                                transform: `rotateY(${angle}deg) translateZ(${r}px) translateY(${-lift}px)`,
                              };
                            };
                            return (
                              <div
                                class={`bw-pane ${
                                  mode() === "3d" ? "is-3d" : ""
                                } ${
                                  mode() === "3d" && isFacing() && inActiveRing()
                                    ? "is-facing"
                                    : ""
                                }`}
                                style={hostStyle()}
                              >
                                <TerminalPane
                                  cwd={tab.cwd}
                                  sessionId={tab.sessionId}
                                  projectId={tab.projectId}
                                  projectPath={tab.projectPath}
                                  onSpawned={(sid) =>
                                    handlePaneSpawned(tab.id, sid)
                                  }
                                  onReady={(h) =>
                                    registerHandle(tab.id, h)
                                  }
                                  onDeregister={() => handles.delete(tab.id)}
                                  closeOnUnmount={false}
                                />
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};
