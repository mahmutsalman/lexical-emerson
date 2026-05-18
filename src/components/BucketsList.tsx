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
  closestCenter,
  createSortable,
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  transformStyle,
  type DragEvent as SolidDndDragEvent,
} from "@thisbeyond/solid-dnd";

// Same augmentation BucketWorkspace declares — TS interface merging is fine
// across multiple modules. Repeated here so BucketsList stays compilable
// even when BucketWorkspace isn't part of the build / is tree-shaken out
// of the launcher window's bundle (launcher only renders BucketsList; the
// 3D workspace ships in its own window's render path).
declare module "solid-js" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface Directives {
      sortable: true;
    }
  }
}

import {
  addToBucket,
  createBucket,
  deleteBucket,
  loadActiveClaudeSessionsForBucket,
  onMenuEvent,
  removeFromBucket,
  reorderBucketProjects,
  requestOpenProject,
  setActiveBucket,
  setBucketAutoRestore,
  setBucketCursorToProject,
  setBucketIdleSuspendMin,
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

  let menuRef: HTMLDivElement | undefined;
  const [menuSize, setMenuSize] = createSignal({ w: 240, h: 200 });
  const [menuMeasured, setMenuMeasured] = createSignal(false);

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

  // Measure the menu div after it mounts so we can flip it above the cursor
  // when it would otherwise overflow the bottom of the viewport.
  createEffect(() => {
    if (menu()) {
      setMenuMeasured(false);
      queueMicrotask(() => {
        if (menuRef) {
          const { width, height } = menuRef.getBoundingClientRect();
          if (width > 0 && height > 0) {
            setMenuSize({ w: width, h: height });
          }
        }
        setMenuMeasured(true);
      });
    } else {
      setMenuMeasured(false);
    }
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

  // Drag-reorder handler for a single bucket's projects. Mirrors the
  // workspace's pattern (BucketWorkspace.tsx) — solid-dnd's
  // PointerSensor uses a 250 ms / 10 px activation threshold so a plain
  // click still falls through to the row's onClick (open project).
  // Persistence is fire-and-forget: the backend command emits
  // buckets://changed, which our parent (Sidebar / App) listens to and
  // refreshes the bucket data — so we never mutate `bucket.projects`
  // locally, avoiding any flicker between optimistic and authoritative
  // state.
  const handleSortEnd = (bucket: Bucket, event: SolidDndDragEvent) => {
    const { draggable, droppable } = event;
    if (!draggable || !droppable) return;
    const arr = bucket.projects;
    const fromIdx = arr.findIndex((p) => p.id === draggable.id);
    const toIdx = arr.findIndex((p) => p.id === droppable.id);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const next = arr.slice();
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    void reorderBucketProjects(
      bucket.id,
      next.map((p) => p.id),
    ).catch((err) =>
      console.warn("reorderBucketProjects failed:", err),
    );
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
                  <div
                    class="bucket-idle-toggle"
                    onClick={(e) => e.stopPropagation()}
                    title="Auto-suspend idle terminals after…"
                  >
                    <For each={[15, 30, 60] as const}>
                      {(opt) => (
                        <button
                          type="button"
                          class="bucket-idle-btn"
                          classList={{ "is-active": bucket.idle_suspend_min === opt }}
                          onClick={async (e) => {
                            e.stopPropagation();
                            await setBucketIdleSuspendMin(bucket.id, opt).catch(() => {});
                          }}
                        >
                          {opt}
                        </button>
                      )}
                    </For>
                  </div>
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
                  <DragDropProvider
                    onDragEnd={(e) => handleSortEnd(bucket, e)}
                    collisionDetector={closestCenter}
                  >
                    <DragDropSensors />
                    <ul class="bucket-projects">
                      <SortableProvider ids={bucket.projects.map((p) => p.id)}>
                        <For each={bucket.projects}>
                          {(project, idx) => {
                            const sortable = createSortable(project.id);
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
                                use:sortable
                                class={`bucket-project ${
                                  isActive() && idx() === bucket.cursor
                                    ? "at-cursor"
                                    : ""
                                } ${sortable.isActiveDraggable ? "is-dragging" : ""}`}
                                style={transformStyle(sortable.transform)}
                                onClick={() => handleOpen(project)}
                                title={project.path}
                              >
                                <span class="bucket-project-name">
                                  {project.name}
                                </span>
                                <Show when={project.is_frequent}>
                                  <span class="bucket-project-star" title="frequent">★</span>
                                </Show>
                                <button
                                  type="button"
                                  class="bucket-action danger"
                                  onPointerDown={(e) => e.stopPropagation()}
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
                      </SortableProvider>
                    </ul>
                  </DragDropProvider>
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
              ref={menuRef}
              class="context-menu"
              style={{
                left: `${computeMenuX(m().x, menuSize().w)}px`,
                top: `${computeMenuY(m().y, menuSize().h)}px`,
                visibility: menuMeasured() ? "visible" : "hidden",
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

function computeMenuX(x: number, w: number): number {
  if (x + w + 8 > window.innerWidth) return Math.max(8, x - w);
  return Math.max(8, x);
}

// Flip the menu above the cursor when (a) it would overflow the bottom or
// (b) the cursor is in the lower half of the viewport. The second trigger
// is the load-bearing one — the menu's actual height (~100 px for three
// short items) often fits below the cursor even in a short sidebar window,
// so a pure overflow check leaves the menu clipped because measurement
// reports a height smaller than what the user perceives as "off-screen".
// Biasing toward flipping in the bottom half matches macOS native context
// menus and keeps "Load active Claude sessions" reachable.
function computeMenuY(y: number, h: number): number {
  const vh = window.innerHeight;
  if (y + h + 8 > vh || y > vh * 0.55) {
    return Math.max(8, y - h);
  }
  return Math.max(8, y);
}
