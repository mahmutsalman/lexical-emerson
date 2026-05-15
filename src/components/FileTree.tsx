import {
  Component,
  createResource,
  createSignal,
  For,
  Show,
  Suspense,
} from "solid-js";

import { listDirectory } from "../lib/ipc";
import type { DirEntry } from "../lib/types";

interface NodeProps {
  entry: DirEntry;
  depth: number;
}

const TreeNode: Component<NodeProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const [children] = createResource(
    () => (expanded() && props.entry.is_dir ? props.entry.path : null),
    (path) => listDirectory(path, false),
  );

  const toggle = () => {
    if (props.entry.is_dir) setExpanded((v) => !v);
  };

  const icon = () => {
    if (props.entry.is_symlink) return "↪";
    if (props.entry.is_dir) return expanded() ? "▾" : "▸";
    return " ";
  };

  return (
    <>
      <div
        class={`tree-node ${props.entry.is_dir ? "directory" : "file"}`}
        onClick={toggle}
        style={{ "padding-left": `${8 + props.depth * 12}px` }}
        title={props.entry.path}
      >
        <span class="icon">{icon()}</span>
        {props.entry.name}
      </div>
      <Show when={expanded() && props.entry.is_dir}>
        <Suspense fallback={
          <div class="tree-node" style={{ "padding-left": `${8 + (props.depth + 1) * 12}px`, color: "#5e5e66" }}>
            loading…
          </div>
        }>
          <For each={children() ?? []}>
            {(child) => <TreeNode entry={child} depth={props.depth + 1} />}
          </For>
        </Suspense>
      </Show>
    </>
  );
};

export interface FileTreeProps {
  rootPath: string;
}

export const FileTree: Component<FileTreeProps> = (props) => {
  const [rootEntries] = createResource(
    () => props.rootPath,
    (path) => listDirectory(path, false),
  );

  return (
    <Suspense fallback={<div class="empty-state">loading tree…</div>}>
      <For
        each={rootEntries() ?? []}
        fallback={<div class="empty-state">empty folder</div>}
      >
        {(entry) => <TreeNode entry={entry} depth={0} />}
      </For>
    </Suspense>
  );
};
