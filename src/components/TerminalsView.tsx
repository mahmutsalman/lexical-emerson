import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
} from "solid-js";
import type { Accessor } from "solid-js";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import { markActive, onMenuEvent } from "../lib/ipc";

interface Tab {
  id: string;
  cwd: string;
  projectPath: string;
}

let tabCounter = 0;
const newTabId = () => `tab-${++tabCounter}`;

export interface TerminalsViewProps {
  cwd: string;
  projectPath: string;
  zoom?: Accessor<number>;
  accent?: Accessor<string | null>;
}

export const TerminalsView: Component<TerminalsViewProps> = (props) => {
  // All terminals across all visited projects. xterm instances and their
  // backing PTYs stay alive as long as the entry stays in this array — the
  // user owns the lifecycle by closing tabs explicitly.
  const [allTabs, setAllTabs] = createSignal<Tab[]>([]);
  const [activeByProject, setActiveByProject] = createSignal<
    Record<string, string>
  >({});

  const handles = new Map<string, TerminalHandle>();

  const projectTabs = createMemo(() =>
    allTabs().filter((t) => t.projectPath === props.projectPath),
  );

  const activeId = () => activeByProject()[props.projectPath] ?? "";

  const setActiveForCurrent = (id: string) => {
    setActiveByProject((prev) => ({ ...prev, [props.projectPath]: id }));
  };

  const addTerminal = (cwd?: string) => {
    const tab: Tab = {
      id: newTabId(),
      cwd: cwd ?? props.cwd,
      projectPath: props.projectPath,
    };
    setAllTabs((prev) => [...prev, tab]);
    setActiveForCurrent(tab.id);
  };

  const closeTerminal = (id: string) => {
    const tab = allTabs().find((t) => t.id === id);
    if (!tab) return;
    handles.delete(id);
    setAllTabs((prev) => prev.filter((t) => t.id !== id));

    // Re-select within the project the closed tab belonged to.
    if (id === activeByProject()[tab.projectPath]) {
      const remaining = allTabs().filter(
        (t) => t.projectPath === tab.projectPath && t.id !== id,
      );
      if (remaining.length > 0) {
        setActiveByProject((prev) => ({
          ...prev,
          [tab.projectPath]: remaining[remaining.length - 1].id,
        }));
      } else if (tab.projectPath === props.projectPath) {
        // Last terminal in the *current* project: spawn a fresh one so the
        // user is never left looking at an empty terminal stack.
        addTerminal();
      } else {
        // Last terminal in a non-active project: just clear the active mark.
        setActiveByProject((prev) => {
          const next = { ...prev };
          delete next[tab.projectPath];
          return next;
        });
      }
    }
  };

  const cycleTerminal = (delta: number) => {
    const arr = projectTabs();
    if (arr.length < 2) return;
    const idx = arr.findIndex((t) => t.id === activeId());
    if (idx === -1) return;
    const next = (idx + delta + arr.length) % arr.length;
    setActiveForCurrent(arr[next].id);
  };

  // Whenever the project changes (or on first mount), ensure this project
  // has at least one terminal and a valid active id.
  createEffect(() => {
    const path = props.projectPath;
    const ptabs = projectTabs();
    const current = activeByProject()[path];
    if (ptabs.length === 0) {
      addTerminal();
    } else if (!current || !ptabs.find((t) => t.id === current)) {
      setActiveByProject((prev) => ({ ...prev, [path]: ptabs[0].id }));
    }
  });

  // Focus the active tab whenever it changes.
  createEffect(() => {
    const id = activeId();
    if (!id) return;
    queueMicrotask(() => handles.get(id)?.focus());
  });

  // 30s-debounced project-activity ping.
  let lastMarked = 0;
  const markActivityForCurrent = () => {
    const now = Date.now();
    if (now - lastMarked < 30_000) return;
    lastMarked = now;
    const path = props.projectPath;
    markActive(path).catch((err) =>
      console.warn("mark_active failed:", err),
    );
  };

  onMount(async () => {
    const unlistens: UnlistenFn[] = await Promise.all([
      onMenuEvent("terminal-new", () => addTerminal()),
      onMenuEvent("terminal-close", () => {
        const id = activeId();
        if (id) closeTerminal(id);
      }),
      onMenuEvent("terminal-next", () => cycleTerminal(1)),
      onMenuEvent("terminal-prev", () => cycleTerminal(-1)),
    ]);
    onCleanup(() => unlistens.forEach((u) => u()));
  });

  return (
    <div class="terminals-view">
      <div class="terminal-tabs">
        <For each={projectTabs()}>
          {(tab, idx) => (
            <button
              type="button"
              class={`terminal-tab ${tab.id === activeId() ? "active" : ""}`}
              onClick={() => setActiveForCurrent(tab.id)}
              title={tab.cwd}
            >
              <span class="tab-label">
                {idx() + 1}. {basename(tab.cwd)}
              </span>
              <span
                class="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(tab.id);
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
          class="terminal-tab-add"
          onClick={() => addTerminal()}
          title="New terminal (⌘T)"
        >
          +
        </button>
      </div>
      <div class="terminal-stack">
        <For each={allTabs()}>
          {(tab) => (
            <div
              class="terminal-host"
              style={{
                display:
                  tab.projectPath === props.projectPath &&
                  tab.id === activeId()
                    ? "flex"
                    : "none",
              }}
            >
              <TerminalPane
                cwd={tab.cwd}
                onReady={(h) => handles.set(tab.id, h)}
                onActivity={markActivityForCurrent}
                zoom={props.zoom}
                accent={props.accent}
              />
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
