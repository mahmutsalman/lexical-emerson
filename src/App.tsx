import { Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { FileTree } from "./components/FileTree";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { RecentProjects } from "./components/RecentProjects";
import { TerminalsView } from "./components/TerminalsView";
import {
  currentWindowLabel,
  getProjectById,
  lastProject,
  markFocused,
  openProject,
  pickFolder,
  requestOpenProject,
} from "./lib/ipc";

export const App: Component = () => {
  const [windowLabel, setWindowLabel] = createSignal<string>("main");
  const [projectPath, setProjectPath] = createSignal<string | null>(null);
  const [recentsKey, setRecentsKey] = createSignal(0);

  const isMain = () => windowLabel() === "main";

  // Mutates the CURRENT window's project. Only available in the main window —
  // project-N windows are pinned to their project (ADR-0006).
  const mutateCurrentProject = async (path: string) => {
    try {
      await openProject(path);
      setProjectPath(path);
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

  // Opens a project in its dedicated window. Focuses if already open.
  const navigateToProject = async (path: string) => {
    try {
      await requestOpenProject(path);
      setRecentsKey((v) => v + 1);
    } catch (err) {
      console.error("requestOpenProject failed:", err);
    }
  };

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
          setProjectPath(last.path);
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
            setProjectPath(proj.path);
            setRecentsKey((v) => v + 1);
          }
        } catch (err) {
          console.error("getProjectById failed:", err);
        }
      }
    }

    // Bump last_focused_at whenever this window gains focus.
    unlistenFocus = await getCurrentWindow().onFocusChanged((event) => {
      if (!event.payload) return;
      const p = projectPath();
      if (p) markFocused(p).catch(() => {});
      setRecentsKey((v) => v + 1);
    });
  });

  let unlistenFocus: UnlistenFn | undefined;
  onCleanup(() => unlistenFocus?.());

  const projectName = () => {
    const p = projectPath();
    if (!p) return null;
    const parts = p.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? p;
  };

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
          <div class="sidebar-placeholder">(M4 — the killer feature)</div>
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

      <footer class="bucket-bar">
        <span>
          Lexical Emerson v0.1 — M3 {isMain() ? "(launcher)" : `(${windowLabel()})`}
        </span>
      </footer>

      <QuickSwitcher />
    </div>
  );
};
