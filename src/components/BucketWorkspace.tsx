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

import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import {
  closeTerminal,
  debugInsertFakeRegistryEntry,
  listAllRegisteredTerminals,
  listBuckets,
  listTerminalsForBucket,
  onBucketsChanged,
  onMenuEvent,
  onTerminalsChanged,
  registerTerminal,
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

  // Lookup effective sessionId for a tab: attached tabs carry it on the
  // Tab object; owned tabs learn it via the sidecar map.
  const effectiveSid = (t: WorkspaceTab): string | undefined =>
    t.sessionId ?? sessionIdByLocalTab()[t.id];

  let stackEl!: HTMLDivElement;
  // TerminalPane handles keyed by tab.id. Used to force-fit xterm after a
  // mode change — WebKit doesn't always fire ResizeObserver on the CSS
  // class swaps that 2D ↔ 3D triggers, so we drive a manual fit from
  // here when mode() changes.
  const handles = new Map<string, TerminalHandle>();

  const projects = createMemo<Project[]>(() => bucket()?.projects ?? []);

  const activeProject = (): Project | null =>
    projects()[activeProjectIdx()] ?? null;

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
      for (const [path, arr] of byProject) {
        const current = nextActive[path];
        if (!current || !arr.find((t) => t.id === current)) {
          nextActive[path] = arr[arr.length - 1].id;
          activeChanged = true;
        }
      }
      // Drop active entries for projects whose tabs all died.
      for (const path of Object.keys(prevActive)) {
        if (!byProject.has(path)) {
          delete nextActive[path];
          activeChanged = true;
        }
      }

      batch(() => {
        setTabs(nextTabs);
        if (activeChanged) setActiveByProject(nextActive);
      });

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
  };

  // Ensure activeByProject has a valid selection per project at all times.
  // When a project's tab list goes empty, drop its entry so the row shows
  // "empty + only" UI. When a project has tabs but no valid active, default
  // to the last (most recently added) tab.
  createEffect(() => {
    const all = tabs();
    const next = { ...activeByProject() };
    let changed = false;
    for (const p of projects()) {
      const arr = all.filter((t) => t.projectPath === p.path);
      const current = next[p.path];
      if (arr.length === 0) {
        if (current !== undefined) {
          delete next[p.path];
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

    onCleanup(() => {
      unlistens.forEach((u) => u());
      ro.disconnect();
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
  // Center-of-stack on the active ring: translate so the active is at y=0
  // in viewport coordinates, regardless of which ring index we're on.
  const stackTranslateY = () =>
    -activeProjectIdx() * ringHeightPx();
  // Subtle tilt per ring step gives the camera a physical "leaning" feel
  // when arrowing between projects. Clamped at ±6° so the active ring
  // stays readable head-on.
  const stackTiltDeg = () => {
    const n = projects().length;
    if (n < 2) return 0;
    const mid = (n - 1) / 2;
    return Math.max(-6, Math.min(6, (activeProjectIdx() - mid) * 1.5));
  };
  const ringRotationDeg = (projectPath: string) => {
    const arr = tabsForProject(projectPath);
    const n = arr.length;
    if (n < 2) return 0;
    const currentId = activeByProject()[projectPath];
    const idx = arr.findIndex((t) => t.id === currentId);
    if (idx < 0) return 0;
    return -slotOffsetDeg(idx, n);
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
                ? "⌘⌥3 exit · ⌘⌥↑/↓ ring · ⌘⌥←/→ terminal"
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
              terminal AND focuses that project's ring. */}
          <div class="bw-tabstrip">
            <For each={projects()}>
              {(p, pi) => {
                const arr = () => tabsForProject(p.path);
                const isActiveRow = () => pi() === activeProjectIdx();
                const handleAdd = (e: MouseEvent) => {
                  e.stopPropagation();
                  addOwnedTerminal(p);
                };
                return (
                  <div
                    class={`bw-tabrow ${isActiveRow() ? "active" : ""}`}
                    classList={{ [`accent-${p.color ?? ""}`]: !!p.color }}
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
            <Show when={projects().length === 0}>
              <div class="bw-empty">
                This bucket has no projects yet. Add a project to the bucket
                first.
              </div>
            </Show>
          </div>

          {/* Terminal panes. Always all rendered, with display managed by
              the per-tab style block below so xterm instances don't get
              torn down when switching tabs. The 3D mode wraps each
              project's panes in a cylinder element and the whole stack in
              a vertically-translated outer wrapper. */}
          <div
            class="bw-stack"
            ref={stackEl}
            style={
              mode() === "3d"
                ? { perspective: `${perspectivePx()}px` }
                : undefined
            }
          >
            <div
              class={`bw-rings ${mode() === "3d" ? "is-3d" : ""}`}
              style={
                mode() === "3d"
                  ? {
                      transform: `translateY(${stackTranslateY()}px) rotateX(${stackTiltDeg()}deg)`,
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
                          mode() === "3d" && arr().length >= 2
                            ? {
                                transform: `translateZ(${-radiusFor(arr().length)}px) rotateY(${ringRotationDeg(p.path)}deg)`,
                              }
                            : undefined
                        }
                      >
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
                              const n = arr().length;
                              if (n < 2) {
                                return {
                                  ...base,
                                  display: "flex",
                                  transform: "translateZ(0)",
                                };
                              }
                              const angle = slotOffsetDeg(ti(), n);
                              const r = radiusFor(n);
                              return {
                                ...base,
                                display: "flex",
                                transform: `rotateY(${angle}deg) translateZ(${r}px)`,
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
