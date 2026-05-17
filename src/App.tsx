import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { BucketBar } from "./components/BucketBar";
import { BucketsList } from "./components/BucketsList";
import { BucketWorkspace } from "./components/BucketWorkspace";
import { FileTree } from "./components/FileTree";
import { NotesModal } from "./components/NotesModal";
import { ProjectColorPicker } from "./components/ProjectColorPicker";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { RecentProjects } from "./components/RecentProjects";
import { TerminalsView } from "./components/TerminalsView";
import { TimerModal } from "./components/TimerModal";
import { TimerRail, dispatchOpenTimer } from "./components/TimerRail";
import { playFinishBell } from "./lib/timer-effects";
import { createTimerStore } from "./lib/timer-store";
import {
  currentWindowLabel,
  cycleBucket,
  emitMenuEventLocal,
  getActiveBucket,
  getProjectById,
  listBuckets,
  markFocused,
  onBucketsChanged,
  onMenuEvent,
  openProject,
  pickFolder,
  requestOpenProject,
  setMainProject,
  getGlobalZoom,
  setGlobalZoom,
} from "./lib/ipc";
import { createEditorState } from "./lib/editor-state";
import { applyPalette, isColorTag, PALETTE } from "./lib/palette";
import type { Bucket, Project } from "./lib/types";

const ZOOM_MIN = 0.75;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;
const ZOOM_PERSIST_MS = 250;

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));
}

export const App: Component = () => {
  const [windowLabel, setWindowLabel] = createSignal<string>("main");
  const [bucketWorkspaceId, setBucketWorkspaceId] = createSignal<number | null>(
    null,
  );
  const [currentProject, setCurrentProject] = createSignal<Project | null>(null);
  const [recentsKey, setRecentsKey] = createSignal(0);
  const [bucketsKey, setBucketsKey] = createSignal(0);
  const [panelsHidden, setPanelsHidden] = createSignal(false);
  const [zoom, setZoom] = createSignal(1.1);
  // Per-window editor store. Owns open files, dirty state, and the active
  // editor id. TerminalsView consumes it to render editor tabs alongside
  // its own terminal tabs in a single unified strip — same content area,
  // same tab bar. FileTree.onOpenFile calls editorState.open(path) which
  // either focuses the existing tab or creates a new one.
  const editorState = createEditorState();

  // Project-keyed focus countdown — same store the BucketWorkspace uses, but
  // a per-window instance so each project window's timer ticks independently
  // of the workspace's. The modal listens on window for TIMER_OPEN_EVENT.
  const timerStore = createTimerStore();

  const isBucketWorkspace = () => bucketWorkspaceId() !== null;

  // Persisted with a small debounce so holding ⌘= or ⌘- doesn't fire a write
  // per keystroke. Fire-and-forget; if the window closes before the timer
  // resolves the row still gets written. Zoom is a single global value
  // (app_meta.global_zoom), so any project window's bump broadcasts to all
  // other open windows via the Rust-side `zoom://changed` event.
  let zoomPersistTimer: number | undefined;
  const schedulePersistZoom = (z: number) => {
    if (zoomPersistTimer !== undefined) clearTimeout(zoomPersistTimer);
    zoomPersistTimer = window.setTimeout(() => {
      setGlobalZoom(z).catch((err) =>
        console.warn("setGlobalZoom failed:", err),
      );
    }, ZOOM_PERSIST_MS);
  };

  const projectPath = () => currentProject()?.path ?? null;
  const projectId = () => currentProject()?.id ?? null;
  const isMain = () => windowLabel() === "main";
  const terminalAccent = createMemo<string | null>(() => {
    const c = currentProject()?.color;
    return isColorTag(c) ? PALETTE[c].accent : null;
  });

  // Buckets and active bucket id — re-fetch whenever bucketsKey bumps (which
  // happens on every Rust-side bucket mutation, broadcast app-wide).
  const [buckets] = createResource<Bucket[], number>(
    () => bucketsKey(),
    (_key) => listBuckets(),
  );
  const [activeBucketId] = createResource<number | null, number>(
    () => bucketsKey(),
    (_key) => getActiveBucket(),
  );

  const activeBucket = createMemo<Bucket | null>(() => {
    const id = activeBucketId();
    if (id == null) return null;
    const list = buckets() ?? [];
    return list.find((b) => b.id === id) ?? null;
  });

  const mutateCurrentProject = async (path: string) => {
    try {
      const proj = await openProject(path);
      // Single-window-per-project: if a dedicated project window already
      // exists for the picked folder, focus it instead of duplicating the
      // project into main. Main stays on whatever it was showing.
      const existing = await WebviewWindow.getByLabel(`project-${proj.id}`);
      if (existing) {
        await existing.setFocus();
        setRecentsKey((v) => v + 1);
        return;
      }
      setCurrentProject(proj);
      setRecentsKey((v) => v + 1);
    } catch (err) {
      console.error("openProject failed:", err);
    }
  };

  const openFolder = async () => {
    try {
      const picked = await pickFolder();
      if (picked) await mutateCurrentProject(picked);
    } catch (err) {
      console.error("pick_folder failed:", err);
    }
  };

  const navigateToProject = async (path: string) => {
    try {
      await requestOpenProject(path);
      setRecentsKey((v) => v + 1);
    } catch (err) {
      console.error("requestOpenProject failed:", err);
    }
  };

  const openFolderInNewWindow = async () => {
    try {
      const picked = await pickFolder();
      if (picked) await navigateToProject(picked);
    } catch (err) {
      console.error("openFolderInNewWindow failed:", err);
    }
  };

  let unlistenFocus: UnlistenFn | undefined;
  let unlistenBuckets: UnlistenFn | undefined;
  let unlistenBucketNext: UnlistenFn | undefined;
  let unlistenBucketPrev: UnlistenFn | undefined;
  let unlistenZoomIn: UnlistenFn | undefined;
  let unlistenZoomOut: UnlistenFn | undefined;
  let unlistenZoomReset: UnlistenFn | undefined;
  let unlistenZoomBroadcast: UnlistenFn | undefined;
  let unlistenOpenFolder: UnlistenFn | undefined;
  let unlistenFileSave: UnlistenFn | undefined;
  let unsubTimerFinish: (() => void) | undefined;

  onMount(async () => {
    let label = "main";
    try {
      label = await currentWindowLabel();
      setWindowLabel(label);
    } catch (err) {
      console.warn("currentWindowLabel failed:", err);
    }

    // Adopt the persisted global zoom before any project metadata loads, so
    // the first paint already has the right --ui-zoom. If the key isn't set
    // yet (fresh install or pre-global-zoom DB), keep the in-memory default.
    try {
      const z = await getGlobalZoom();
      if (z !== null) setZoom(clampZoom(z));
    } catch (err) {
      console.warn("getGlobalZoom failed:", err);
    }

    if (label === "main") {
      // Intentionally NOT loading lastProject or any persisted projects on
      // launch. The user-driven workflow is: open the app → see the
      // launcher → right-click a bucket → "Load active Claude sessions"
      // to restore that bucket's windows. Avoids surprise window-spawn
      // storms when multiple buckets had persisted sessions at last quit.
    } else if (label.startsWith("project-")) {
      const id = parseInt(label.slice("project-".length), 10);
      if (Number.isFinite(id)) {
        try {
          const proj = await getProjectById(id);
          if (proj) {
            setCurrentProject(proj);
            setRecentsKey((v) => v + 1);
          }
        } catch (err) {
          console.error("getProjectById failed:", err);
        }
      }
    } else if (label.startsWith("bucket-3d-")) {
      const id = parseInt(label.slice("bucket-3d-".length), 10);
      if (Number.isFinite(id)) {
        setBucketWorkspaceId(id);
      }
    }

    unlistenFocus = await getCurrentWindow().onFocusChanged((event) => {
      if (!event.payload) return;
      const p = projectPath();
      if (p) markFocused(p).catch(() => {});
      setRecentsKey((v) => v + 1);
      setBucketsKey((v) => v + 1);
    });

    unlistenBuckets = await onBucketsChanged(() => {
      setBucketsKey((v) => v + 1);
    });

    unlistenBucketNext = await onMenuEvent("bucket-next", () => {
      cycleBucket(1).catch((err) => console.warn("cycleBucket(1) failed:", err));
    });
    unlistenBucketPrev = await onMenuEvent("bucket-prev", () => {
      cycleBucket(-1).catch((err) => console.warn("cycleBucket(-1) failed:", err));
    });

    unlistenOpenFolder = await onMenuEvent("file-open-folder", () => {
      openFolderInNewWindow();
    });

    // ⌘S → save the active editor tab. Per-window scope: the menu event
    // is already routed to the focused window only (see main.rs), so each
    // window's listener saves its own editor's active tab. Silent no-op
    // when no tab is active (e.g. only terminals are open).
    unlistenFileSave = await onMenuEvent("file-save", () => {
      void editorState.saveActive();
    });

    const bumpZoom = (delta: number) => {
      const next = clampZoom(zoom() + delta);
      if (next === zoom()) return;
      setZoom(next);
      schedulePersistZoom(next);
    };
    unlistenZoomIn = await onMenuEvent("zoom-in", () => bumpZoom(+ZOOM_STEP));
    unlistenZoomOut = await onMenuEvent("zoom-out", () => bumpZoom(-ZOOM_STEP));
    unlistenZoomReset = await onMenuEvent("zoom-reset", () => {
      setZoom(1);
      schedulePersistZoom(1);
    });

    // Live cross-window propagation: whenever any window calls setGlobalZoom,
    // Rust broadcasts the new value to every window (including this one). We
    // dedupe against the current signal to avoid a no-op write loop in the
    // window that originated the change.
    unlistenZoomBroadcast = await listen<number>("zoom://changed", (event) => {
      const next = clampZoom(event.payload);
      if (next === zoom()) return;
      setZoom(next);
    });

    // Subtle finish cue for the title-bar focus timer. The rail itself runs
    // an is-finished throb animation, so a single bell is enough — no flash
    // overlay here (we have only one project per window; no need to disambiguate
    // which ring finished like the 3D workspace does).
    unsubTimerFinish = timerStore.onFinish(() => {
      playFinishBell();
    });
  });

  // Apply this window's color theme whenever currentProject changes. Zoom is
  // no longer adopted per-project — it's a single global value (app_meta)
  // seeded in onMount and kept in sync across windows via `zoom://changed`.
  createEffect(() => {
    // Drive UI scale via a CSS variable consumed by individual chrome
    // selectors (title-bar, sidebar, file-tree, bucket-bar, terminal tabs).
    // Avoid `zoom` on <html>: even with `zoom: 1` reset on the terminal,
    // WebKit desyncs mouse-event coordinates from getBoundingClientRect()
    // for descendants of a zoomed ancestor, which made xterm.js selections
    // land at the wrong cell. Keeping the terminal subtree out of any
    // zoomed ancestor restores native click→cell mapping.
    document.documentElement.style.setProperty("--ui-zoom", String(zoom()));
  });
  createEffect(() => {
    const c = currentProject()?.color;
    applyPalette(isColorTag(c) ? c : null);
  });

  // Tell Rust which project main is currently displaying so that other
  // navigation paths (recents, Cmd+P, bucket cycle, "Open folder") can
  // focus main instead of duplicating a project window. Only main runs
  // this effect — project-N windows are locked to their project by label
  // and Rust never queries main_project_id for them.
  createEffect(() => {
    if (!isMain()) return;
    void setMainProject(currentProject()?.id ?? null);
  });

  onCleanup(() => {
    unlistenFocus?.();
    unlistenBuckets?.();
    unlistenBucketNext?.();
    unlistenBucketPrev?.();
    unlistenZoomIn?.();
    unlistenZoomOut?.();
    unlistenZoomReset?.();
    unlistenZoomBroadcast?.();
    unlistenOpenFolder?.();
    unlistenFileSave?.();
    unsubTimerFinish?.();
    if (zoomPersistTimer !== undefined) clearTimeout(zoomPersistTimer);
    if (isMain()) {
      void setMainProject(null);
    }
  });

  const projectName = () => currentProject()?.name ?? null;

  return (
    <Show
      when={!isBucketWorkspace()}
      fallback={
        <div class="app-shell bucket-workspace-shell">
          <header class="title-bar">
            <span class="title-bar-text">Workspace</span>
          </header>
          <BucketWorkspace bucketId={bucketWorkspaceId()!} />
        </div>
      }
    >
    <div class="app-shell" classList={{ "panels-hidden": panelsHidden() }}>
      <header class="title-bar">
        <span class="title-bar-text">
          Lexical Emerson{projectName() ? ` — ${projectName()}` : ""}
        </span>
        <Show when={currentProject()}>
          {(proj) => (
            <TimerRail
              project={proj}
              store={timerStore}
              accent={terminalAccent}
              onOpen={() => dispatchOpenTimer(proj().path)}
            />
          )}
        </Show>
        <Show when={currentProject()}>
          <button
            type="button"
            class="title-bar-notes-btn"
            title="Open notes (⌘⇧N)"
            aria-label="Open notes"
            onClick={() => {
              void emitMenuEventLocal("notes-open");
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
            >
              <path d="M4 2.5h6.5L13 5v8.5H4z" />
              <path d="M10 2.5V5h3" />
              <line x1="6" y1="7.5" x2="11" y2="7.5" />
              <line x1="6" y1="10" x2="11" y2="10" />
            </svg>
          </button>
        </Show>
      </header>
      <button
        type="button"
        class="panel-toggle-btn"
        onClick={() => setPanelsHidden((v) => !v)}
        title={panelsHidden() ? "Show panels" : "Hide panels"}
        aria-label={panelsHidden() ? "Show panels" : "Hide panels"}
        aria-pressed={panelsHidden()}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25">
          <rect x="2" y="2.5" width="12" height="11" rx="1.25" />
          <line x1="6" y1="2.5" x2="6" y2="13.5" />
        </svg>
      </button>
      <aside class="sidebar">
        <div class="sidebar-section">
          <div class="sidebar-section-title">Project</div>
          <Show
            when={isMain()}
            fallback={
              <Show
                when={projectPath()}
                fallback={
                  <div class="sidebar-placeholder">loading project…</div>
                }
              >
                <div class="sidebar-pinned-project">
                  <div class="sidebar-pinned-row">
                    <Show when={currentProject()}>
                      {(proj) => (
                        <ProjectColorPicker
                          project={proj()}
                          onChange={(updated) => setCurrentProject(updated)}
                        />
                      )}
                    </Show>
                    <div class="sidebar-pinned-name">{projectName()}</div>
                  </div>
                  <div class="sidebar-pinned-hint">pinned to this window</div>
                </div>
              </Show>
            }
          >
            <button class="sidebar-button primary" onClick={openFolder}>
              {projectPath() ? "Switch folder…" : "Open folder…"}
            </button>
            <Show when={projectPath()}>
              <div class="sidebar-project-row">
                <Show when={currentProject()}>
                  {(proj) => (
                    <ProjectColorPicker
                      project={proj()}
                      onChange={(updated) => setCurrentProject(updated)}
                    />
                  )}
                </Show>
                <div class="sidebar-project-path" title={projectPath() ?? ""}>
                  {projectName()}
                </div>
              </div>
            </Show>
          </Show>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title">Recent</div>
          <RecentProjects
            refreshKey={recentsKey()}
            activePath={projectPath()}
            activeBucketId={activeBucketId() ?? null}
            onPick={(path) => navigateToProject(path)}
            onChanged={() => {
              setRecentsKey((v) => v + 1);
              setBucketsKey((v) => v + 1);
            }}
          />
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title">Buckets</div>
          <BucketsList
            buckets={buckets() ?? []}
            activeBucketId={activeBucketId() ?? null}
            currentProjectId={projectId()}
          />
        </div>
      </aside>

      <Show
        when={currentProject()}
        fallback={
          <div class="workspace" style={{ "grid-template-columns": "1fr" }}>
            <div class="empty-state">
              <div>{isMain() ? "No folder open" : "loading…"}</div>
              <Show when={isMain()}>
                <button class="sidebar-button primary" onClick={openFolder}>
                  Open folder…
                </button>
              </Show>
            </div>
          </div>
        }
      >
        {(proj) => (
          <div class="workspace">
            <div class="file-tree-panel">
              <FileTree
                rootPath={proj().path}
                onOpenFile={(path) => editorState.open(path)}
              />
            </div>
            <div class="terminal-panel">
              <TerminalsView
                cwd={proj().path}
                projectPath={proj().path}
                projectId={proj().id}
                zoom={zoom}
                accent={terminalAccent}
                editorState={editorState}
              />
            </div>
          </div>
        )}
      </Show>

      <BucketBar
        activeBucket={activeBucket()}
        trailing={isMain() ? "v0.1 launcher" : windowLabel()}
      />

      <QuickSwitcher />

      {/* NotesModal is project-scoped — only mounted when a project is loaded.
          In the main launcher window before a project is picked, currentProject
          is null and Cmd+Shift+N silently does nothing. */}
      <Show when={currentProject()}>
        {(proj) => <NotesModal projectId={proj().id} />}
      </Show>
      <Show when={currentProject()}>
        <TimerModal
          project={currentProject}
          store={timerStore}
          accent={terminalAccent}
        />
      </Show>
    </div>
    </Show>
  );
};
