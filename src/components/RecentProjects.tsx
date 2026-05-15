import {
  Component,
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";

import {
  addToBucket,
  hideProject,
  listRecents,
  revealInFinder,
} from "../lib/ipc";
import type { Project } from "../lib/types";

export interface RecentProjectsProps {
  refreshKey: number;
  activePath: string | null;
  activeBucketId: number | null;
  onPick: (path: string) => void;
  onChanged: () => void;
}

type MenuState = {
  project: Project;
  x: number;
  y: number;
};

export const RecentProjects: Component<RecentProjectsProps> = (props) => {
  const [recents] = createResource(
    () => props.refreshKey,
    () => listRecents(),
  );
  const [menu, setMenu] = createSignal<MenuState | null>(null);

  const closeMenu = () => setMenu(null);

  const openMenu = (e: MouseEvent, p: Project) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ project: p, x: e.clientX, y: e.clientY });
  };

  // Dismiss the menu on any outside click, Escape, or scroll. We register on
  // window so the listeners catch clicks regardless of where they land.
  createEffect(() => {
    if (!menu()) return;
    const onDocClick = () => closeMenu();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closeMenu();
    };
    const onScroll = () => closeMenu();
    window.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    });
  });

  const handleOpen = (p: Project) => {
    closeMenu();
    props.onPick(p.path);
  };

  const handleReveal = async (p: Project) => {
    closeMenu();
    try {
      await revealInFinder(p.path);
    } catch (err) {
      console.warn("revealInFinder failed:", err);
    }
  };

  const handleCopyPath = async (p: Project) => {
    closeMenu();
    try {
      await navigator.clipboard.writeText(p.path);
    } catch (err) {
      console.warn("clipboard.writeText failed:", err);
    }
  };

  const handleAddToBucket = async (p: Project) => {
    const bucketId = props.activeBucketId;
    closeMenu();
    if (bucketId == null) return;
    try {
      await addToBucket(bucketId, p.id);
    } catch (err) {
      console.warn("addToBucket failed:", err);
    }
  };

  const handleHide = async (p: Project) => {
    closeMenu();
    try {
      await hideProject(p.id);
      props.onChanged();
    } catch (err) {
      console.warn("hideProject failed:", err);
    }
  };

  return (
    <>
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
                  onContextMenu={(e) => openMenu(e, p)}
                  title={p.path}
                >
                  <span class="recent-name">{p.name}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={menu()}>
        {(m) => (
          <Portal>
            <div
              class="context-menu"
              style={{
                left: `${clampMenuX(m().x)}px`,
                top: `${clampMenuY(m().y)}px`,
              }}
              onMouseDown={(e) => e.stopPropagation()}
              role="menu"
            >
              <button
                type="button"
                class="context-menu-item"
                onClick={() => handleOpen(m().project)}
              >
                Open
              </button>
              <button
                type="button"
                class="context-menu-item"
                onClick={() => handleReveal(m().project)}
              >
                Reveal in Finder
              </button>
              <button
                type="button"
                class="context-menu-item"
                onClick={() => handleCopyPath(m().project)}
              >
                Copy path
              </button>
              <div class="context-menu-separator" />
              <button
                type="button"
                class="context-menu-item"
                disabled={props.activeBucketId == null}
                onClick={() => handleAddToBucket(m().project)}
                title={
                  props.activeBucketId == null
                    ? "No active bucket — pick one from the bucket bar first"
                    : undefined
                }
              >
                Add to active bucket
              </button>
              <div class="context-menu-separator" />
              <button
                type="button"
                class="context-menu-item danger"
                onClick={() => handleHide(m().project)}
              >
                Remove from list
              </button>
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
};

const MENU_W = 200;
const MENU_H = 220;

function clampMenuX(x: number): number {
  const max = window.innerWidth - MENU_W - 8;
  return Math.min(Math.max(x, 8), Math.max(8, max));
}

function clampMenuY(y: number): number {
  const max = window.innerHeight - MENU_H - 8;
  return Math.min(Math.max(y, 8), Math.max(8, max));
}
