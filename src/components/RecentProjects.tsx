import { Component, createResource, For, Show } from "solid-js";

import { listRecents } from "../lib/ipc";
import type { Project } from "../lib/types";

export interface RecentProjectsProps {
  refreshKey: number;
  activePath: string | null;
  onPick: (path: string) => void;
}

export const RecentProjects: Component<RecentProjectsProps> = (props) => {
  const [recents] = createResource(
    () => props.refreshKey,
    () => listRecents(),
  );

  return (
    <Show
      when={(recents() ?? []).length > 0}
      fallback={
        <div class="recent-empty">No recent projects yet.</div>
      }
    >
      <ul class="recent-list">
        <For each={recents() ?? []}>
          {(p: Project) => (
            <li>
              <button
                type="button"
                class={`recent-item ${
                  p.path === props.activePath ? "active" : ""
                }`}
                onClick={() => props.onPick(p.path)}
                title={p.path}
              >
                <span class="recent-name">{p.name}</span>
                <span class="recent-path">{compactPath(p.path)}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
};

function compactPath(p: string): string {
  const home = "/Users/";
  if (p.startsWith(home)) {
    // ~/foo/bar — strip the username segment for compactness
    const rest = p.slice(home.length).split("/").slice(1).join("/");
    return rest ? `~/${rest}` : "~";
  }
  return p;
}
