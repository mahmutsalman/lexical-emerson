import {
  Component,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { BucketBar } from "./components/BucketBar";
import { BucketsList } from "./components/BucketsList";
import { FileTree } from "./components/FileTree";
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
} from "./lib/ipc";
import type { Bucket, Project } from "./lib/types";

export const App: Component = () => {
  const [windowLabel, setWindowLabel] = createSignal<string>("main");
  const [currentProject, setCurrentProject] = createSignal<Project | null>(null);
  const [recentsKey, setRecentsKey] = createSignal(0);
  const [bucketsKey, setBucketsKey] = createSignal(0);

  const projectPath = () => currentProject()?.path ?? null;
  const projectId = () => currentProject()?.id ?? null;
  const isMain = () => windowLabel() === "main";

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
  });

  onCleanup(() => {
    unlistenFocus?.();
    unlistenBuckets?.();
    unlistenBucketNext?.();
    unlistenBucketPrev?.();
  });

  const projectName = () => currentProject()?.name ?? null;

  return (
    <div class="app-shell">
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
            </Show>
          </Show>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title">Recent</div>
          <RecentProjects
            refreshKey={recentsKey()}
            activePath={projectPath()}
            onPick={(path) => navigateToProject(path)}
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
              <TerminalsView cwd={path()} projectPath={path()} />
            </div>
          </div>
        )}
      </Show>

      <BucketBar
        activeBucket={activeBucket()}
        trailing={isMain() ? "v0.1 launcher" : windowLabel()}
      />

      <QuickSwitcher />
    </div>
  );
};
