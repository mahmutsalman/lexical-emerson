import { Component, createMemo, Show } from "solid-js";
import type { Accessor } from "solid-js";

import { formatCountdown, type TimerStore } from "../lib/timer-store";
import type { Project } from "../lib/types";

interface TimerRailProps {
  project: Accessor<Project | null>;
  store: TimerStore;
  accent: Accessor<string | null>;
  // Dispatches the open-modal event for the active project. Click and Enter both call this.
  onOpen: () => void;
}

const TIMER_OPEN_EVENT = "lexical:timer-open";

export function dispatchOpenTimer(projectPath: string): void {
  window.dispatchEvent(
    new CustomEvent(TIMER_OPEN_EVENT, { detail: { projectPath } }),
  );
}

export const TIMER_OPEN_EVENT_NAME = TIMER_OPEN_EVENT;

export const TimerRail: Component<TimerRailProps> = (props) => {
  const snap = createMemo(() => {
    const p = props.project();
    if (!p) return null;
    return props.store.snapshot(p.path);
  });

  const display = createMemo(() => {
    const s = snap();
    if (!s) return "—";
    if (s.status === "idle" && s.durationMs === 0) return "Set";
    return formatCountdown(s.remainingMs);
  });

  const statusLabel = createMemo(() => {
    const s = snap();
    if (!s) return "";
    switch (s.status) {
      case "running":
        return "running";
      case "paused":
        return "paused";
      case "finished":
        return "done";
      case "idle":
        return s.durationMs > 0 ? "ready" : "focus timer";
    }
  });

  return (
    <Show when={props.project()}>
      {(proj) => (
        <button
          type="button"
          class="timer-rail"
          classList={{
            "is-running": snap()?.status === "running",
            "is-paused": snap()?.status === "paused",
            "is-finished": snap()?.status === "finished",
          }}
          style={
            { "--timer-accent": props.accent() ?? "" } as Record<string, string>
          }
          onClick={() => props.onOpen()}
          title={`Focus timer · ${proj().name}`}
        >
          <span class="timer-rail-label">{statusLabel()}</span>
          <span class="timer-rail-time">{display()}</span>
          <span class="timer-rail-hint">click to set</span>
        </button>
      )}
    </Show>
  );
};
