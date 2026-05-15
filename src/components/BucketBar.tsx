import { Component, Show } from "solid-js";

import { cycleBucket } from "../lib/ipc";
import type { Bucket } from "../lib/types";

export interface BucketBarProps {
  activeBucket: Bucket | null;
  trailing?: string;
}

export const BucketBar: Component<BucketBarProps> = (props) => {
  const cycle = (direction: 1 | -1) => {
    cycleBucket(direction).catch((err) =>
      console.error("cycleBucket failed:", err),
    );
  };

  return (
    <footer class="bucket-bar">
      <Show
        when={props.activeBucket}
        fallback={
          <span class="bucket-bar-idle">
            No active bucket — pick one in the sidebar to enable ⌘J
          </span>
        }
      >
        {(bucket) => (
          <div class="bucket-bar-active">
            <button
              type="button"
              class="bucket-cycle-btn"
              onClick={() => cycle(-1)}
              title="Cycle backward (⌘⇧J)"
              disabled={bucket().projects.length === 0}
            >
              ◄
            </button>
            <span class="bucket-bar-name">{bucket().name}</span>
            <span class="bucket-bar-position">
              {bucket().projects.length > 0
                ? `${bucket().cursor + 1}/${bucket().projects.length}`
                : "empty"}
            </span>
            <Show when={bucket().projects[bucket().cursor]}>
              <span class="bucket-bar-current">
                → {bucket().projects[bucket().cursor].name}
              </span>
            </Show>
            <button
              type="button"
              class="bucket-cycle-btn"
              onClick={() => cycle(1)}
              title="Cycle forward (⌘J)"
              disabled={bucket().projects.length === 0}
            >
              ►
            </button>
          </div>
        )}
      </Show>
      <Show when={props.trailing}>
        <span class="bucket-bar-trailing">{props.trailing}</span>
      </Show>
    </footer>
  );
};
