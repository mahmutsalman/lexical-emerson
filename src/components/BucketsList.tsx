import {
  Component,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import {
  addToBucket,
  createBucket,
  deleteBucket,
  onMenuEvent,
  removeFromBucket,
  setActiveBucket,
} from "../lib/ipc";
import type { Bucket } from "../lib/types";

export interface BucketsListProps {
  buckets: Bucket[];
  activeBucketId: number | null;
  currentProjectId: number | null;
}

export const BucketsList: Component<BucketsListProps> = (props) => {
  const [expanded, setExpanded] = createSignal<Record<number, boolean>>({});
  const [newOpen, setNewOpen] = createSignal(false);
  const [newName, setNewName] = createSignal("");

  let newInputEl: HTMLInputElement | undefined;

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
                <div class="bucket-header" onClick={handleSetActive}>
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
                      {(project, idx) => (
                        <li
                          class={`bucket-project ${
                            isActive() && idx() === bucket.cursor ? "at-cursor" : ""
                          }`}
                        >
                          <span class="bucket-project-name">{project.name}</span>
                          <button
                            type="button"
                            class="bucket-action danger"
                            onClick={() =>
                              removeFromBucket(bucket.id, project.id).catch(
                                (err) =>
                                  console.error("removeFromBucket failed:", err),
                              )
                            }
                            title="Remove from bucket"
                          >
                            ×
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
};
