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
import type { UnlistenFn } from "@tauri-apps/api/event";

import { BucketBar } from "./components/BucketBar";
import { BucketsList } from "./components/BucketsList";
import { FileTree } from "./components/FileTree";
import { NotesModal } from "./components/NotesModal";
import { ProjectColorPicker } from "./components/ProjectColorPicker";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { RecentProjects } from "./components/RecentProjects";
import { TerminalsView } from "./components/TerminalsView";
import {
  currentWindowLabel,
  cycleBucket,
  getActiveBucket,
  getProjectById,
  lastProject,
  listBuckets,
  markFocused,
  onBucketsChanged,
  onMenuEvent,
  openProject,
  pickFolder,
  requestOpenProject,
  setMainProject,
  setProjectZoom,
} from "./lib/ipc";
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
  const [currentProject, setCurrentProject] = createSignal<Project | null>(null);
  const [recentsKey, setRecentsKey] = createSignal(0);
  const [bucketsKey, setBucketsKey] = createSignal(0);
  const [panelsHidden, setPanelsHidden] = createSignal(false);
  const [zoom, setZoom] = createSignal(1);

  // Persisted with a small debounce so holding ⌘= or ⌘- doesn't fire a write
  // per keystroke. Fire-and-forget; if the window closes before the timer
  // resolves the row still gets written.
  let zoomPersistTimer: number | undefined;
  const schedulePersistZoom = (id: number, z: number) => {
    if (zoomPersistTimer !== undefined) clearTimeout(zoomPersistTimer);
    zoomPersistTimer = window.setTimeout(() => {
      setProjectZoom(id, z).catch((err) =>
        console.warn("setProjectZoom failed:", err),
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

  let unlistenFocus: UnlistenFn | undefined;
  let unlistenBuckets: UnlistenFn | undefined;
  let unlistenBucketNext: UnlistenFn | undefined;
  let unlistenBucketPrev: UnlistenFn | undefined;
  let unlistenZoomIn: UnlistenFn | undefined;
  let unlistenZoomOut: UnlistenFn | undefined;
  let unlistenZoomReset: UnlistenFn | undefined;

  onMount(async () => {
    let label = "main";
    try {
      label = await currentWindowLabel();
      setWindowLabel(label);
    } catch (err) {
      console.warn("currentWindowLabel failed:", err);
    }

    if (label === "main") {
      try {
        const last = await lastProject();
        if (last) {
          setCurrentProject(last);
          setRecentsKey((v) => v + 1);
        }
      } catch (err) {
        console.error("lastProject failed:", err);
      }
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

    const bumpZoom = (delta: number) => {
      const p = currentProject();
      if (!p) return;
      const next = clampZoom(zoom() + delta);
      if (next === zoom()) return;
      setZoom(next);
      schedulePersistZoom(p.id, next);
    };
    unlistenZoomIn = await onMenuEvent("zoom-in", () => bumpZoom(+ZOOM_STEP));
    unlistenZoomOut = await onMenuEvent("zoom-out", () => bumpZoom(-ZOOM_STEP));
    unlistenZoomReset = await onMenuEvent("zoom-reset", () => {
      const p = currentProject();
      if (!p) return;
      setZoom(1);
      schedulePersistZoom(p.id, 1);
    });
  });

  // Adopt the loaded project's saved zoom and color whenever currentProject
  // changes. Both effects also run on initial load.
  createEffect(() => {
    const p = currentProject();
    if (!p) return;
    const z = typeof p.zoom === "number" && p.zoom > 0 ? p.zoom : 1;
    setZoom(clampZoom(z));
  });
  createEffect(() => {
    // WebKit `zoom` is a layout-scale (not a transform) so it propagates to
    // child boxes. The terminal subtree resets `zoom: 1` in CSS to keep
    // FitAddon reading native pixels; cell size is driven by fontSize.
    (document.documentElement.style as { zoom?: string }).zoom = String(zoom());
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
    if (zoomPersistTimer !== undefined) clearTimeout(zoomPersistTimer);
    if (isMain()) {
      void setMainProject(null);
    }
  });

  const projectName = () => currentProject()?.name ?? null;

  return (
    <div class="app-shell" classList={{ "panels-hidden": panelsHidden() }}>
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
                  <div class="sidebar-pinned-name">{projectName()}</div>
                  <div class="sidebar-pinned-hint">pinned to this window</div>
                  <Show when={currentProject()}>
                    {(proj) => (
                      <ProjectColorPicker
                        project={proj()}
                        onChange={(updated) => setCurrentProject(updated)}
                      />
                    )}
                  </Show>
                </div>
              </Show>
            }
          >
            <button class="sidebar-button primary" onClick={openFolder}>
              {projectPath() ? "Switch folder…" : "Open folder…"}
            </button>
            <Show when={projectPath()}>
              <div class="sidebar-project-path" title={projectPath() ?? ""}>
                {projectName()}
              </div>
              <Show when={currentProject()}>
                {(proj) => (
                  <ProjectColorPicker
                    project={proj()}
                    onChange={(updated) => setCurrentProject(updated)}
                  />
                )}
              </Show>
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
        when={projectPath()}
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
        {(path) => (
          <div class="workspace">
            <div class="file-tree-panel">
              <FileTree rootPath={path()} />
            </div>
            <div class="terminal-panel">
              <TerminalsView
                cwd={path()}
                projectPath={path()}
                zoom={zoom}
                accent={terminalAccent}
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
    </div>
  );
};
