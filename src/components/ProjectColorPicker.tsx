import {
  Component,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";

import { setProjectColor } from "../lib/ipc";
import { COLOR_TAGS, isColorTag, PALETTE, type ColorTag } from "../lib/palette";
import type { Project } from "../lib/types";

export interface ProjectColorPickerProps {
  project: Project;
  onChange: (updated: Project) => void;
}

const POPOVER_W = 140;
const POPOVER_H = 120;
const POPOVER_GAP = 6;

export const ProjectColorPicker: Component<ProjectColorPickerProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  let triggerRef: HTMLButtonElement | undefined;

  const currentColor = (): ColorTag | null => {
    const c = props.project.color;
    return isColorTag(c) ? c : null;
  };

  const togglePopover = () => {
    if (open()) {
      setOpen(false);
      return;
    }
    if (triggerRef) {
      const rect = triggerRef.getBoundingClientRect();
      setPos({ x: rect.left, y: rect.bottom + POPOVER_GAP });
    }
    setOpen(true);
  };

  createEffect(() => {
    if (!open()) return;
    const onDocMouseDown = () => setOpen(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    });
  });

  const pick = async (tag: ColorTag) => {
    const same = currentColor() === tag;
    const next = same ? null : tag;
    try {
      const updated = await setProjectColor(props.project.id, next);
      props.onChange(updated);
    } catch (err) {
      console.error("setProjectColor failed", err);
    } finally {
      setOpen(false);
    }
  };

  const clear = async () => {
    try {
      const updated = await setProjectColor(props.project.id, null);
      props.onChange(updated);
    } catch (err) {
      console.error("setProjectColor failed", err);
    } finally {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        class="color-dot-trigger"
        classList={{ "is-unset": currentColor() == null }}
        style={{
          "background-color":
            currentColor() ? PALETTE[currentColor() as ColorTag].accent : "transparent",
        }}
        title="Project color"
        aria-label="Project color"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          togglePopover();
        }}
      />
      <Show when={open()}>
        <Portal>
          <div
            class="color-popover"
            role="dialog"
            aria-label="Project color"
            style={{
              left: `${clampX(pos().x)}px`,
              top: `${clampY(pos().y)}px`,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div class="color-popover-grid">
              <For each={COLOR_TAGS}>
                {(tag) => (
                  <button
                    type="button"
                    class="color-swatch"
                    classList={{ selected: currentColor() === tag }}
                    style={{ "background-color": PALETTE[tag].accent }}
                    title={tag}
                    aria-label={tag}
                    aria-pressed={currentColor() === tag}
                    onClick={() => pick(tag)}
                  />
                )}
              </For>
            </div>
            <Show when={currentColor() != null}>
              <button
                type="button"
                class="color-popover-clear"
                onClick={clear}
              >
                Clear color
              </button>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
};

function clampX(x: number): number {
  const max = window.innerWidth - POPOVER_W - 8;
  return Math.min(Math.max(x, 8), Math.max(8, max));
}

function clampY(y: number): number {
  const max = window.innerHeight - POPOVER_H - 8;
  return Math.min(Math.max(y, 8), Math.max(8, max));
}
