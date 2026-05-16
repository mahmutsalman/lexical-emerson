import {
  Component,
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";

import {
  addToBucket,
  createBucket,
  deleteBucket,
  loadActiveClaudeSessionsForBucket,
  onMenuEvent,
  removeFromBucket,
  requestOpenProject,
  setActiveBucket,
  setBucketAutoRestore,
  setBucketCursorToProject,
  spawnBucket3DWorkspace,
} from "../lib/ipc";
import type { Bucket, Project } from "../lib/types";

type BucketMenuState = {
  bucket: Bucket;
  x: number;
  y: number;
};

export interface BucketsListProps {
  buckets: Bucket[];
  activeBucketId: number | null;
  currentProjectId: number | null;
}

export const BucketsList: Component<BucketsListProps> = (props) => {
  const [expanded, setExpanded] = createSignal<Record<number, boolean>>({});
  const [newOpen, setNewOpen] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [menu, setMenu] = createSignal<BucketMenuState | null>(null);
  const closeMenu = () => setMenu(null);

  let newInputEl: HTMLInputElement | undefined;

  const openMenu = (e: MouseEvent, b: Bucket) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ bucket: b, x: e.clientX, y: e.clientY });
  };

  // Mirror RecentProjects.tsx's dismissal listeners — outside click, Escape,
  // or scroll all close the menu. Window-level so any region of the app
  // dismisses it consistently.
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

  const handleOpenWorkspace = async (b: Bucket) => {
    closeMenu();
    if (b.projects.length === 0) return;
    try {
      await spawnBucket3DWorkspace(b.id);
    } catch (err) {
      console.error("spawnBucket3DWorkspace failed:", err);
    }
  };

  const handleToggleAutoRestore = async (b: Bucket) => {
    closeMenu();
    try {
      await setBucketAutoRestore(b.id, !b.auto_restore_sessions);
    } catch (err) {
      console.error("setBucketAutoRestore failed:", err);
    }
  };

  const handleLoadActiveSessions = async (b: Bucket) => {
    closeMenu();
    try {
      const count = await loadActiveClaudeSessionsForBucket(b.id);
      console.info(
        `[bucket ${b.id}] opened ${count} window(s) with persisted sessions`,
      );
    } catch (err) {
      console.error("loadActiveClaudeSessionsForBucket failed:", err);
    }
  };

  onMount(async () => {
    const unlisten = await onMenuEvent("bucket-new", () => {
      setNewOpen(true);
      setNewName("");
      queueMicrotask(() => newInputEl?.focus());
    });
    onCleanup(unlisten);
  });

  const toggleExpand = (id: number) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isInBucket = (bucket: Bucket): boolean => {
    if (props.currentProjectId == null) return false;
    return bucket.projects.some((p) => p.id === props.currentProjectId);
  };

  const submitNew = async () => {
    const name = newName().trim();
    if (!name) {
      setNewOpen(false);
      return;
    }
    try {
      await createBucket(name);
    } catch (err) {
      console.error("createBucket failed:", err);
    }
    setNewOpen(false);
    setNewName("");
  };

  return (
    <div class="buckets-list">
      <Show
        when={!newOpen()}
        fallback={
          <div class="bucket-new-row">
            <input
              ref={newInputEl}
              class="bucket-new-input"
              type="text"
              placeholder="bucket name"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNew();
                else if (e.key === "Escape") setNewOpen(false);
              }}
              onBlur={() => submitNew()}
            />
          </div>
        }
      >
        <button
          type="button"
          class="bucket-new-button"
          onClick={() => {
            setNewOpen(true);
            queueMicrotask(() => newInputEl?.focus());
          }}
        >
          + New bucket
        </button>
      </Show>

      <Show
        when={props.buckets.length > 0}
        fallback={
          <div class="bucket-empty">
            Create a bucket to group projects you cycle between.
          </div>
        }
      >
        <For each={props.buckets}>
          {(bucket) => {
            const isActive = () => props.activeBucketId === bucket.id;
            const isOpen = () => !!expanded()[bucket.id];

            const handleSetActive = async () => {
              try {
                await setActiveBucket(isActive() ? null : bucket.id);
              } catch (err) {
                console.error("setActiveBucket failed:", err);
              }
            };

            const handleAddCurrent = async (e: MouseEvent) => {
              e.stopPropagation();
              if (props.currentProjectId == null) return;
              try {
                await addToBucket(bucket.id, props.currentProjectId);
                setExpanded((prev) => ({ ...prev, [bucket.id]: true }));
              } catch (err) {
                console.error("addToBucket failed:", err);
              }
            };

            const handleDelete = async (e: MouseEvent) => {
              e.stopPropagation();
              if (!confirm(`Delete bucket "${bucket.name}"?`)) return;
              try {
                await deleteBucket(bucket.id);
              } catch (err) {
                console.error("deleteBucket failed:", err);
              }
            };

            return (
              <div class={`bucket-row ${isActive() ? "active" : ""}`}>
                <div
                  class="bucket-header"
                  onClick={handleSetActive}
                  onContextMenu={(e) => openMenu(e, bucket)}
                >
                  <button
                    type="button"
                    class="bucket-chevron"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpand(bucket.id);
                    }}
                    title={isOpen() ? "collapse" : "expand"}
                  >
                    {isOpen() ? "▾" : "▸"}
                  </button>
                  <span class="bucket-name" title={bucket.name}>
                    {bucket.name}
                  </span>
                  <span class="bucket-count">{bucket.projects.length}</span>
                  <Show when={props.currentProjectId != null && !isInBucket(bucket)}>
                    <button
                      type="button"
                      class="bucket-action"
                      onClick={handleAddCurrent}
                      title="Add current project"
                    >
                      +
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="bucket-action danger"
                    onClick={handleDelete}
                    title="Delete bucket"
                  >
                    ×
                  </button>
                </div>
                <Show when={isOpen() && bucket.projects.length > 0}>
                  <ul class="bucket-projects">
                    <For each={bucket.projects}>
                      {(project, idx) => {
                        const handleOpen = (p: Project) => {
                          // Fire both in parallel — opening the window
                          // and moving the at-cursor highlight are
                          // independent (no shared state, no ordering
                          // dependency). The cursor IPC also activates
                          // this bucket so the .at-cursor styling
                          // actually paints.
                          void requestOpenProject(p.path).catch((err) =>
                            console.error("requestOpenProject failed:", err),
                          );
                          void setBucketCursorToProject(bucket.id, p.id).catch(
                            (err) =>
                              console.error(
                                "setBucketCursorToProject failed:",
                                err,
                              ),
                          );
                        };
                        return (
                          <li
                            class={`bucket-project ${
                              isActive() && idx() === bucket.cursor
                                ? "at-cursor"
                                : ""
                            }`}
                            onClick={() => handleOpen(project)}
                            title={project.path}
                          >
                            <span class="bucket-project-name">
                              {project.name}
                            </span>
                            <button
                              type="button"
                              class="bucket-action danger"
                              onClick={(e) => {
                                // Don't let the remove click bubble into
                                // the row's open handler.
                                e.stopPropagation();
                                removeFromBucket(bucket.id, project.id).catch(
                                  (err) =>
                                    console.error(
                                      "removeFromBucket failed:",
                                      err,
                                    ),
                                );
                              }}
                              title="Remove from bucket"
                            >
                              ×
                            </button>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </Show>
              </div>
            );
          }}
        </For>
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
                disabled={m().bucket.projects.length === 0}
                onClick={() => handleOpenWorkspace(m().bucket)}
                title={
                  m().bucket.projects.length === 0
                    ? "Add at least one project to this bucket first"
                    : undefined
                }
              >
                Open in 3D Workspace
              </button>
              <button
                type="button"
                class="context-menu-item"
                disabled={m().bucket.projects.length === 0}
                onClick={() => handleLoadActiveSessions(m().bucket)}
                title="Spawn project windows for every project in this bucket that has a persisted Claude session from the last quit"
              >
                Load active Claude sessions
              </button>
              <button
                type="button"
                class="context-menu-item"
                onClick={() => handleToggleAutoRestore(m().bucket)}
                title="When on, this bucket's Claude sessions are saved on quit so they can be restored later"
              >
                Auto-restore Claude sessions:{" "}
                {m().bucket.auto_restore_sessions ? "on" : "off"}
              </button>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
};

const MENU_W = 240;
const MENU_H = 160;

function clampMenuX(x: number): number {
  const max = window.innerWidth - MENU_W - 8;
  return Math.min(Math.max(x, 8), Math.max(8, max));
}

function clampMenuY(y: number): number {
  const max = window.innerHeight - MENU_H - 8;
  return Math.min(Math.max(y, 8), Math.max(8, max));
}
