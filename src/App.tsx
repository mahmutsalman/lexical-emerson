import { Component, createSignal, Show } from "solid-js";

import { FileTree } from "./components/FileTree";
import { TerminalPane } from "./components/TerminalPane";
import { pickFolder } from "./lib/ipc";

export const App: Component = () => {
  const [projectPath, setProjectPath] = createSignal<string | null>(null);

  const openFolder = async () => {
    try {
      const picked = await pickFolder();
      if (picked) {
        setProjectPath(picked);
      }
    } catch (err) {
      console.error("pick_folder failed:", err);
    }
  };

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
            <div
              style={{
                "margin-top": "10px",
                "font-size": "11px",
                color: "#7a7a82",
                "word-break": "break-all",
              }}
              title={projectPath() ?? ""}
            >
              {projectName()}
            </div>
          </Show>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title">Recent</div>
          <div style={{ "font-size": "11px", color: "#5e5e66" }}>
            (M2 — persistence)
          </div>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-section-title">Buckets</div>
          <div style={{ "font-size": "11px", color: "#5e5e66" }}>
            (M4 — the killer feature)
          </div>
        </div>
      </aside>

      <Show
        when={projectPath()}
        keyed
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
              <FileTree rootPath={path} />
            </div>
            <div class="terminal-panel">
              <TerminalPane cwd={path} />
            </div>
          </div>
        )}
      </Show>

      <footer class="bucket-bar">
        <span>Lexical Emerson v0.1 — M1 (skeleton)</span>
      </footer>
    </div>
  );
};
