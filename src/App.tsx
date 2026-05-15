import { Component, createSignal, onMount, Show } from "solid-js";

import { FileTree } from "./components/FileTree";
import { RecentProjects } from "./components/RecentProjects";
import { TerminalsView } from "./components/TerminalsView";
import { lastProject, openProject, pickFolder } from "./lib/ipc";

export const App: Component = () => {
  const [projectPath, setProjectPath] = createSignal<string | null>(null);
  const [recentsKey, setRecentsKey] = createSignal(0);

  const switchTo = async (path: string) => {
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
      if (picked) await switchTo(picked);
    } catch (err) {
      console.error("pick_folder failed:", err);
    }
  };

  onMount(async () => {
    try {
      const last = await lastProject();
      if (last) {
        setProjectPath(last.path);
        setRecentsKey((v) => v + 1);
      }
    } catch (err) {
      console.error("lastProject failed:", err);
    }
  });

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
          <button class="sidebar-button primary" onClick={openFolder}>
            {projectPath() ? "Switch folder…" : "Open folder…"}
          </button>
          <Show when={projectPath()}>
            <div class="sidebar-project-path" title={projectPath() ?? ""}>
              {projectName()}
            </div>
          </Show>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title">Recent</div>
          <RecentProjects
            refreshKey={recentsKey()}
            activePath={projectPath()}
            onPick={(path) => switchTo(path)}
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
              <div>No folder open</div>
              <button class="sidebar-button primary" onClick={openFolder}>
                Open folder…
              </button>
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
        <span>Lexical Emerson v0.1 — M2 (persistence + multi-terminal)</span>
      </footer>
    </div>
  );
};
