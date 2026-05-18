import {
  Component,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { emit, listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { cycleBucket } from "../lib/ipc";
import type { Bucket } from "../lib/types";

export interface BucketBarProps {
  activeBucket: Bucket | null;
  trailing?: string;
}

// Broadcast channel for the "armed" UI state. When the user clicks the footer
// in any project window, every project window in the bucket flips its bucket
// bar into armed mode (visual cue + programmatic footer focus) so the user
// can keep pressing arrow keys after ⌘J cycles them to the next window. Esc
// or a click outside any footer disarms everywhere.
const ARMED_EVENT = "bucket-bar://armed-changed";

export const BucketBar: Component<BucketBarProps> = (props) => {
  const cycle = (direction: 1 | -1) => {
    cycleBucket(direction).catch((err) =>
      console.error("cycleBucket failed:", err),
    );
  };

  let footerEl!: HTMLElement;
  const [armed, setArmed] = createSignal(false);

  // Single source of truth for arming: emit the broadcast. The listener
  // below (mounted in every window) updates this window's local signal.
  // The originating window also receives its own emit — Solid's signal
  // dedupe handles the no-op case if the value didn't change.
  const broadcastArmed = (value: boolean) => {
    void emit(ARMED_EVENT, value).catch((err) =>
      console.warn("emit bucket-bar armed failed:", err),
    );
  };

  const arm = () => {
    if (!props.activeBucket) return;
    broadcastArmed(true);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      cycle(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      cycle(1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      broadcastArmed(false);
    }
  };

  let unlistenArmed: UnlistenFn | undefined;
  const onDocClick = (e: MouseEvent) => {
    // Only relevant while armed. A click on (or inside) the footer is the
    // arm action — handled by onClick; ignore here. A click anywhere else
    // disarms across all windows.
    if (!armed()) return;
    const t = e.target as HTMLElement | null;
    if (t && footerEl && footerEl.contains(t)) return;
    broadcastArmed(false);
  };

  onMount(async () => {
    unlistenArmed = await listen<boolean>(ARMED_EVENT, (event) => {
      setArmed(!!event.payload);
    });
    document.addEventListener("click", onDocClick, true);
  });

  // Apply focus/blur whenever armed flips. Done as a createEffect so that
  // the same logic runs whether the change came from a local click or from
  // a broadcast — every project window's footer ends up programmatically
  // focused after arming, so arrow keys land on its onKeyDown even right
  // after ⌘J brings that window forward.
  createEffect(() => {
    if (!footerEl) return;
    if (armed()) {
      footerEl.focus({ preventScroll: true });
    } else if (document.activeElement === footerEl) {
      footerEl.blur();
    }
  });

  onCleanup(() => {
    unlistenArmed?.();
    document.removeEventListener("click", onDocClick, true);
  });

  return (
    <footer
      class="bucket-bar"
      classList={{ "is-armed": armed() }}
      ref={footerEl}
      tabIndex={-1}
      onClick={arm}
      onKeyDown={onKey}
      title={
        props.activeBucket
          ? "Click to arm — then ← / → cycle projects (Esc to release)"
          : undefined
      }
    >
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
              class="bucket-cycle-btn bucket-cycle-btn--prev"
              onClick={(e) => {
                e.stopPropagation();
                cycle(-1);
              }}
              title="Cycle backward (⌘⇧J)"
              disabled={bucket().projects.length === 0}
            >
              ▶
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
              class="bucket-cycle-btn bucket-cycle-btn--next"
              onClick={(e) => {
                e.stopPropagation();
                cycle(1);
              }}
              title="Cycle forward (⌘J)"
              disabled={bucket().projects.length === 0}
            >
              ▶
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
