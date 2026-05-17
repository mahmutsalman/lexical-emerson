import { createSignal } from "solid-js";

export type TimerStatus = "idle" | "running" | "paused" | "finished";

export interface TimerState {
  // Target duration in ms. 0 when nothing has been set yet.
  durationMs: number;
  // Epoch ms when the current run started or last resumed. null when not running.
  startedAt: number | null;
  // Accumulated elapsed across previous run+pause segments of the current cycle.
  elapsedAtPauseMs: number;
  status: TimerStatus;
}

export interface TimerSnapshot extends TimerState {
  // Live remaining ms, clamped at 0.
  remainingMs: number;
}

export interface TimerStore {
  // Read current snapshot for a project. Reactive — re-runs when status/tick changes.
  snapshot: (projectPath: string) => TimerSnapshot;
  // Set the target minutes (resets to idle).
  setMinutes: (projectPath: string, minutes: number) => void;
  // Start (or restart) the countdown with the current durationMs. If duration is 0, no-op.
  start: (projectPath: string) => void;
  pause: (projectPath: string) => void;
  resume: (projectPath: string) => void;
  reset: (projectPath: string) => void;
  // Subscribe to the finish event (fires once per project when status flips to "finished").
  onFinish: (cb: (projectPath: string) => void) => () => void;
  // Stop the internal interval — call from onCleanup.
  dispose: () => void;
}

const emptyState = (): TimerState => ({
  durationMs: 0,
  startedAt: null,
  elapsedAtPauseMs: 0,
  status: "idle",
});

export function computeRemaining(s: TimerState, now: number): number {
  if (s.status === "idle") return s.durationMs;
  if (s.status === "finished") return 0;
  if (s.status === "paused") {
    return Math.max(0, s.durationMs - s.elapsedAtPauseMs);
  }
  // running
  if (s.startedAt == null) return s.durationMs;
  const elapsed = s.elapsedAtPauseMs + (now - s.startedAt);
  return Math.max(0, s.durationMs - elapsed);
}

export function createTimerStore(): TimerStore {
  // Single signal holds the whole map; mutate by spreading. We also keep a
  // separate "tick" signal that bumps every 250ms so countdown displays
  // re-render without us having to replace the state map on every tick.
  const [states, setStates] = createSignal<Record<string, TimerState>>({});
  const [tick, setTick] = createSignal(0);

  const finishCallbacks = new Set<(p: string) => void>();
  // Tracks per-project whether we've fired the finish callback for the
  // current run. Cleared on reset/start.
  const finishFired: Record<string, boolean> = {};

  const get = (path: string): TimerState => states()[path] ?? emptyState();
  const put = (path: string, next: TimerState) =>
    setStates((prev) => ({ ...prev, [path]: next }));

  const interval = window.setInterval(() => {
    // Bump tick so consumers reading snapshot() re-run.
    setTick((t) => t + 1);
    // Detect newly-finished states and fire callbacks.
    const now = Date.now();
    const snap = states();
    for (const path of Object.keys(snap)) {
      const s = snap[path];
      if (s.status !== "running") continue;
      const remaining = computeRemaining(s, now);
      if (remaining <= 0 && !finishFired[path]) {
        finishFired[path] = true;
        // Promote to finished AND freeze remaining at 0 by setting
        // elapsedAtPauseMs = durationMs.
        put(path, {
          ...s,
          status: "finished",
          startedAt: null,
          elapsedAtPauseMs: s.durationMs,
        });
        for (const cb of finishCallbacks) cb(path);
      }
    }
  }, 250);

  return {
    snapshot(path: string): TimerSnapshot {
      // Read tick() so Solid re-runs this on every interval bump.
      tick();
      const s = get(path);
      return { ...s, remainingMs: computeRemaining(s, Date.now()) };
    },
    setMinutes(path, minutes) {
      const clamped = Math.max(0, Math.min(24 * 60, Math.floor(minutes)));
      finishFired[path] = false;
      put(path, {
        durationMs: clamped * 60 * 1000,
        startedAt: null,
        elapsedAtPauseMs: 0,
        status: "idle",
      });
    },
    start(path) {
      const s = get(path);
      if (s.durationMs <= 0) return;
      finishFired[path] = false;
      put(path, {
        durationMs: s.durationMs,
        startedAt: Date.now(),
        elapsedAtPauseMs: 0,
        status: "running",
      });
    },
    pause(path) {
      const s = get(path);
      if (s.status !== "running" || s.startedAt == null) return;
      const elapsed = s.elapsedAtPauseMs + (Date.now() - s.startedAt);
      put(path, {
        ...s,
        startedAt: null,
        elapsedAtPauseMs: Math.min(elapsed, s.durationMs),
        status: "paused",
      });
    },
    resume(path) {
      const s = get(path);
      if (s.status !== "paused") return;
      put(path, { ...s, startedAt: Date.now(), status: "running" });
    },
    reset(path) {
      const s = get(path);
      finishFired[path] = false;
      put(path, {
        durationMs: s.durationMs,
        startedAt: null,
        elapsedAtPauseMs: 0,
        status: "idle",
      });
    },
    onFinish(cb) {
      finishCallbacks.add(cb);
      return () => finishCallbacks.delete(cb);
    },
    dispose() {
      window.clearInterval(interval);
      finishCallbacks.clear();
    },
  };
}

export function formatCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (hh > 0) return `${hh}:${pad(mm)}:${pad(ss)}`;
  return `${pad(mm)}:${pad(ss)}`;
}
