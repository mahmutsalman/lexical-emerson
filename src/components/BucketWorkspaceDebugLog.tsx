import { Component, createSignal, For, onCleanup, onMount, Show } from "solid-js";

interface DebugEvent {
  ts: number;
  type: string;
  target: string;
  detail: string;
}

interface Props {
  visible: () => boolean;
  onClose: () => void;
}

const MAX_ENTRIES = 50;

function targetDescription(t: EventTarget | null): string {
  if (!t || !(t instanceof Element)) return "(no target)";
  const tag = t.tagName.toLowerCase();
  const cls =
    typeof t.className === "string" && t.className.length > 0
      ? "." + t.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".")
      : "";
  return `${tag}${cls}`.slice(0, 80);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export const BucketWorkspaceDebugLog: Component<Props> = (props) => {
  const [events, setEvents] = createSignal<DebugEvent[]>([]);

  const push = (e: DebugEvent) => {
    setEvents((prev) => {
      const next = [e, ...prev];
      if (next.length > MAX_ENTRIES) next.length = MAX_ENTRIES;
      return next;
    });
  };

  const insideWorkspace = (t: EventTarget | null): boolean => {
    if (!(t instanceof Element)) return false;
    return t.closest(".bucket-workspace") !== null;
  };

  const onClick = (e: MouseEvent) => {
    if (!insideWorkspace(e.target)) return;
    push({
      ts: Date.now(),
      type: "click",
      target: targetDescription(e.target),
      detail: `@(${e.clientX},${e.clientY})`,
    });
  };
  const onPointerDown = (e: PointerEvent) => {
    if (!insideWorkspace(e.target)) return;
    push({
      ts: Date.now(),
      type: "pointerdown",
      target: targetDescription(e.target),
      detail: `${e.pointerType}@(${e.clientX},${e.clientY})`,
    });
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!insideWorkspace(e.target)) return;
    push({
      ts: Date.now(),
      type: "pointerup",
      target: targetDescription(e.target),
      detail: `${e.pointerType}@(${e.clientX},${e.clientY})`,
    });
  };
  const onWheel = (e: WheelEvent) => {
    if (!insideWorkspace(e.target)) return;
    push({
      ts: Date.now(),
      type: "wheel",
      target: targetDescription(e.target),
      detail: `dy=${Math.round(e.deltaY)} dx=${Math.round(e.deltaX)}`,
    });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!insideWorkspace(e.target)) return;
    const mods = [
      e.metaKey ? "⌘" : "",
      e.altKey ? "⌥" : "",
      e.ctrlKey ? "⌃" : "",
      e.shiftKey ? "⇧" : "",
    ]
      .filter(Boolean)
      .join("");
    push({
      ts: Date.now(),
      type: "keydown",
      target: targetDescription(e.target),
      detail: `${mods}${e.key}`,
    });
  };

  onMount(() => {
    // capture:true so we see events before any upstream stopPropagation
    // (e.g. solid-dnd's PointerSensor) could swallow them.
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    document.addEventListener("keydown", onKeyDown, true);
  });

  onCleanup(() => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("wheel", onWheel, { capture: true } as never);
    document.removeEventListener("keydown", onKeyDown, true);
  });

  return (
    <Show when={props.visible()}>
      <aside class="bw-debug-log" aria-label="Event capture log">
        <header class="bw-debug-log-head">
          <span class="bw-debug-log-title">Events (⌘⌥D)</span>
          <button
            type="button"
            class="bw-debug-log-btn"
            onClick={() => setEvents([])}
            title="Clear log"
          >
            Clear
          </button>
          <button
            type="button"
            class="bw-debug-log-btn"
            onClick={() => props.onClose()}
            title="Hide (⌘⌥D)"
          >
            ×
          </button>
        </header>
        <div class="bw-debug-log-list">
          <For
            each={events()}
            fallback={
              <div class="bw-debug-log-empty">
                Waiting for events inside .bucket-workspace…
              </div>
            }
          >
            {(e) => (
              <div class={`bw-debug-log-row type-${e.type}`}>
                <span class="bw-debug-log-ts">{formatTime(e.ts)}</span>
                <span class="bw-debug-log-type">{e.type}</span>
                <span class="bw-debug-log-target" title={e.target}>
                  {e.target}
                </span>
                <span class="bw-debug-log-detail">{e.detail}</span>
              </div>
            )}
          </For>
        </div>
      </aside>
    </Show>
  );
};
