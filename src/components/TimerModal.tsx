import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { Accessor } from "solid-js";

import { TIMER_OPEN_EVENT_NAME } from "./TimerRail";
import { formatCountdown, type TimerStore } from "../lib/timer-store";
import type { Project } from "../lib/types";

interface TimerModalProps {
  // The bucket workspace's currently-active project. The modal opens
  // against this project's timer slot (regardless of which project the
  // dispatch event named — we keep it simple and route to the active).
  project: Accessor<Project | null>;
  store: TimerStore;
  accent: Accessor<string | null>;
}

// Preset minute buttons offered in the modal — covers common focus sprints.
const PRESETS = [5, 10, 15, 25, 45, 60];

export const TimerModal: Component<TimerModalProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [draftMinutes, setDraftMinutes] = createSignal("");
  let inputEl: HTMLInputElement | undefined;

  const snap = createMemo(() => {
    const p = props.project();
    if (!p) return null;
    return props.store.snapshot(p.path);
  });

  const close = () => setOpen(false);

  const openFor = () => {
    const p = props.project();
    if (!p) return;
    const s = props.store.snapshot(p.path);
    // Seed the input with the current duration if one is set, otherwise leave
    // blank so the user can just type.
    if (s.durationMs > 0) {
      setDraftMinutes(String(Math.round(s.durationMs / 60000)));
    } else {
      setDraftMinutes("");
    }
    setOpen(true);
    // Focus the input on the next tick so the autofocus lands after the
    // overlay has been mounted.
    queueMicrotask(() => inputEl?.select());
  };

  const startWithMinutes = (minutes: number) => {
    const p = props.project();
    if (!p) return;
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    props.store.setMinutes(p.path, minutes);
    props.store.start(p.path);
    close();
  };

  const handleEnter = () => {
    const raw = draftMinutes().trim();
    if (raw.length === 0) {
      // Empty input + Enter on a running/paused timer = no-op.
      return;
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    startWithMinutes(n);
  };

  const handlePauseResume = () => {
    const p = props.project();
    const s = snap();
    if (!p || !s) return;
    if (s.status === "running") props.store.pause(p.path);
    else if (s.status === "paused") props.store.resume(p.path);
  };

  const handleReset = () => {
    const p = props.project();
    if (!p) return;
    props.store.reset(p.path);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open()) return;
    // stopImmediatePropagation: bucket workspace's onWorkspaceKey listens
    // on window for Enter/Esc too. The DOM-overlay check there already
    // short-circuits when our .timer-overlay is rendered, but stopping
    // propagation here belt-and-braces it in case subscription order or
    // future refactors expose us to a race.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      handleEnter();
    }
  };

  // Window-level Esc / Enter — same belt-and-braces pattern as NotesModal so
  // keystrokes reach us regardless of whether the input has focus.
  createEffect(() => {
    if (!open()) return;
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  // Listen for the open-event dispatched by TimerRail clicks.
  const onOpenRequest = () => openFor();
  window.addEventListener(TIMER_OPEN_EVENT_NAME, onOpenRequest);
  onCleanup(() =>
    window.removeEventListener(TIMER_OPEN_EVENT_NAME, onOpenRequest),
  );

  const liveDisplay = createMemo(() => {
    const s = snap();
    if (!s) return "00:00";
    if (s.status === "idle") {
      const minutes = parseFloat(draftMinutes());
      if (Number.isFinite(minutes) && minutes > 0) {
        return formatCountdown(minutes * 60 * 1000);
      }
      return s.durationMs > 0 ? formatCountdown(s.durationMs) : "00:00";
    }
    return formatCountdown(s.remainingMs);
  });

  return (
    <Show when={open()}>
      <div class="timer-overlay" onClick={close}>
        <div
          class="timer-modal"
          onClick={(e) => e.stopPropagation()}
          style={
            { "--timer-accent": props.accent() ?? "" } as Record<string, string>
          }
        >
          <header class="timer-modal-header">
            <span class="timer-modal-title">
              Focus timer · {props.project()?.name ?? ""}
            </span>
            <button
              type="button"
              class="timer-modal-close"
              onClick={close}
              title="Close (Esc)"
              aria-label="Close"
            >
              ×
            </button>
          </header>

          <div class="timer-modal-display">
            <span class="timer-modal-time">{liveDisplay()}</span>
            <span class="timer-modal-status">
              {snap()?.status === "running"
                ? "running"
                : snap()?.status === "paused"
                  ? "paused"
                  : snap()?.status === "finished"
                    ? "done"
                    : "ready"}
            </span>
          </div>

          <Show
            when={
              snap()?.status === "idle" || snap()?.status === "finished"
            }
            fallback={
              <div class="timer-modal-controls">
                <button
                  type="button"
                  class="timer-btn primary"
                  onClick={handlePauseResume}
                >
                  {snap()?.status === "running" ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  class="timer-btn"
                  onClick={handleReset}
                  title="Reset to ready (keeps duration)"
                >
                  Reset
                </button>
              </div>
            }
          >
            <div class="timer-modal-input-row">
              <input
                ref={inputEl}
                type="number"
                inputmode="numeric"
                min="1"
                max="1440"
                step="1"
                class="timer-modal-input"
                placeholder="minutes"
                value={draftMinutes()}
                onInput={(e) =>
                  setDraftMinutes(
                    (e.currentTarget as HTMLInputElement).value,
                  )
                }
                autofocus
              />
              <span class="timer-modal-input-suffix">min</span>
              <button
                type="button"
                class="timer-btn primary"
                onClick={handleEnter}
                disabled={!draftMinutes().trim()}
              >
                Start
              </button>
            </div>
            <div class="timer-modal-presets">
              <For each={PRESETS}>
                {(m) => (
                  <button
                    type="button"
                    class="timer-preset"
                    onClick={() => {
                      setDraftMinutes(String(m));
                      startWithMinutes(m);
                    }}
                  >
                    {m}m
                  </button>
                )}
              </For>
            </div>
            <Show when={snap()?.status === "finished"}>
              <div class="timer-modal-finish-note">
                Time's up. Enter a new duration to start another session.
              </div>
            </Show>
          </Show>

          <footer class="timer-modal-hint">
            <kbd>Enter</kbd> start · <kbd>Esc</kbd> close
          </footer>
        </div>
      </div>
    </Show>
  );
};
