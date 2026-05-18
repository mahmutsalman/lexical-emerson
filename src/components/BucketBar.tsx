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

import {
  cycleBucket,
  requestOpenProject,
  setBucketCursorToProject,
  toggleProjectFrequent,
} from "../lib/ipc";
import type { Bucket, Project } from "../lib/types";
import { setLastArmedBar } from "../lib/arm-focus";

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

  // Optimistic cursor: updated immediately on arrow key press, before the
  // cycleBucket IPC resolves and props.activeBucket refetches. Without this,
  // b.cursor is stale when F or Space fires right after navigation — causing
  // F to toggle the wrong project and Space's guard to mis-fire.
  const [localCursor, setLocalCursor] = createSignal<number | null>(null);
  const currentCursor = () => localCursor() ?? props.activeBucket?.cursor ?? 0;

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
    setLastArmedBar("footer");
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const len = props.activeBucket?.projects.length ?? 0;
      if (len > 0) setLocalCursor((currentCursor() - 1 + len) % len);
      cycle(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const len = props.activeBucket?.projects.length ?? 0;
      if (len > 0) setLocalCursor((currentCursor() + 1) % len);
      cycle(1);
    } else if (e.key === "ArrowUp") {
      // Vertical arm-switch: hand off to the tab strip (TerminalsView)
      // so ← / → now cycle terminals + editor files. The header listens
      // for the same event and arms itself if it has anything to cycle.
      // We broadcast our disarm unconditionally so all sibling windows'
      // footers also light off, matching the existing click-to-disarm
      // broadcast behavior.
      e.preventDefault();
      window.dispatchEvent(
        new CustomEvent("lexical:arm-switch-vertical", {
          detail: { target: "header" },
        }),
      );
      broadcastArmed(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      broadcastArmed(false);
      window.dispatchEvent(new CustomEvent("lexical:focus-terminal"));
    } else if (e.key === "Escape") {
      e.preventDefault();
      broadcastArmed(false);
    } else if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("lexical:toggle-panels"));
      // Stay armed — footer remains live for chained M-presses or cycling.
    } else if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      const b = props.activeBucket;
      if (!b || b.projects.length === 0) return;
      // F: toggle the star on the cursor's project. Stay armed.
      // Bound to F (not Shift+Space) because the OS reports shiftKey=true on
      // any keystroke while Shift is physically held — including a still-held
      // right-Shift used to arm the footer — which made Shift+Space mis-fire
      // on every plain Space press the user intended as "cycle frequent."
      const cur = b.projects[currentCursor()];
      if (!cur) return;
      toggleProjectFrequent(b.id, cur.id).catch((err) =>
        console.error("toggleProjectFrequent failed:", err),
      );
    } else if (e.key === " ") {
      e.preventDefault();
      const b = props.activeBucket;
      if (!b || b.projects.length === 0) return;
      // Space: advance cursor to next starred project (forward, wrapping).
      // Never toggles, regardless of e.shiftKey — see the F branch for why.
      const len = b.projects.length;
      const cursor = currentCursor();
      let nextProject: Project | null = null;
      for (let i = 1; i <= len; i++) {
        const p = b.projects[(cursor + i) % len];
        if (p.is_frequent) { nextProject = p; break; }
      }
      if (!nextProject) return;
      if (nextProject.id === b.projects[cursor]?.id) return;
      // Mirror BucketsList.tsx sidebar-click: open the window AND move the
      // cursor. Without requestOpenProject the footer updates but the window
      // never switches.
      void requestOpenProject(nextProject.path).catch((err) =>
        console.error("requestOpenProject failed:", err),
      );
      void setBucketCursorToProject(b.id, nextProject.id).catch((err) =>
        console.error("setBucketCursorToProject failed:", err),
      );
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

  // Vertical arm-switch receiver — the header (TerminalsView) dispatches
  // this when the user presses ArrowDown while it's armed. We delegate to
  // the existing arm() helper which already has the activeBucket guard,
  // so an empty-bucket window stays unarmed instead of lighting up with
  // nothing to cycle.
  const onArmSwitch = (e: Event) => {
    if ((e as CustomEvent).detail?.target === "footer") arm();
  };

  onMount(async () => {
    unlistenArmed = await listen<boolean>(ARMED_EVENT, (event) => {
      setArmed(!!event.payload);
    });
    document.addEventListener("click", onDocClick, true);
    window.addEventListener("lexical:arm-switch-vertical", onArmSwitch);
  });

  // When props.activeBucket changes (resource refetch completed), the DB cursor
  // is now authoritative — drop the optimistic localCursor override.
  createEffect(() => {
    props.activeBucket;
    setLocalCursor(null);
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
    window.removeEventListener("lexical:arm-switch-vertical", onArmSwitch);
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
                <Show when={bucket().projects[bucket().cursor].is_frequent}>
                  <span class="bucket-bar-star" title="frequent">★</span>
                </Show>
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
