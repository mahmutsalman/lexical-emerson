import {
  Component,
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { listRecents, onMenuEvent, requestOpenProject } from "../lib/ipc";
import type { Project } from "../lib/types";
import { fuzzyRank } from "../lib/fuzzy";

export const QuickSwitcher: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [highlightIdx, setHighlightIdx] = createSignal(0);

  // Re-fetch recents every time the modal opens so it reflects the latest order.
  const [recents, { refetch }] = createResource<Project[]>(() => listRecents());

  const ranked = () => {
    const items = recents() ?? [];
    return fuzzyRank(query(), items, (p) => `${p.name} ${p.path}`);
  };

  let inputEl: HTMLInputElement | undefined;

  const close = () => {
    setOpen(false);
    setQuery("");
    setHighlightIdx(0);
  };

  const activate = async (project: Project) => {
    close();
    try {
      await requestOpenProject(project.path);
    } catch (err) {
      console.error("requestOpenProject failed:", err);
    }
  };

  onMount(async () => {
    const unlisten = await onMenuEvent("quick-switcher", () => {
      setOpen(true);
      refetch();
      setHighlightIdx(0);
      queueMicrotask(() => inputEl?.focus());
    });
    onCleanup(unlisten);
  });

  // Keep highlightIdx in range whenever the ranked list shrinks.
  createEffect(() => {
    const len = ranked().length;
    if (highlightIdx() >= len) setHighlightIdx(Math.max(0, len - 1));
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(ranked().length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sel = ranked()[highlightIdx()];
      if (sel) activate(sel.item);
    }
  };

  return (
    <Show when={open()}>
      <div
        class="switcher-overlay"
        onClick={close}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        <div class="switcher" onClick={(e) => e.stopPropagation()}>
          <input
            ref={inputEl}
            class="switcher-input"
            type="text"
            placeholder="Find project…"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setHighlightIdx(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div class="switcher-list">
            <For
              each={ranked()}
              fallback={
                <div class="switcher-empty">
                  {recents()?.length ? "no matches" : "no recent projects"}
                </div>
              }
            >
              {(entry, idx) => (
                <div
                  class={`switcher-item ${
                    idx() === highlightIdx() ? "highlighted" : ""
                  }`}
                  onMouseEnter={() => setHighlightIdx(idx())}
                  onClick={() => activate(entry.item)}
                >
                  <span class="switcher-item-name">{entry.item.name}</span>
                  <span class="switcher-item-path">{compactPath(entry.item.path)}</span>
                </div>
              )}
            </For>
          </div>
          <div class="switcher-hint">
            <kbd>↵</kbd> open · <kbd>↑↓</kbd> navigate · <kbd>esc</kbd> close
          </div>
        </div>
      </div>
    </Show>
  );
};

function compactPath(p: string): string {
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length).split("/").slice(1).join("/");
    return rest ? `~/${rest}` : "~";
  }
  return p;
}
