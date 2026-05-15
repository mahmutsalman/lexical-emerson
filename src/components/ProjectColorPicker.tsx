import { Component, For } from "solid-js";

import { setProjectColor } from "../lib/ipc";
import { COLOR_TAGS, PALETTE, type ColorTag } from "../lib/palette";
import type { Project } from "../lib/types";

export interface ProjectColorPickerProps {
  project: Project;
  onChange: (updated: Project) => void;
}

export const ProjectColorPicker: Component<ProjectColorPickerProps> = (props) => {
  const pick = async (tag: ColorTag) => {
    const same = props.project.color === tag;
    const next = same ? null : tag;
    try {
      const updated = await setProjectColor(props.project.id, next);
      props.onChange(updated);
    } catch (err) {
      console.error("setProjectColor failed", err);
    }
  };

  return (
    <div class="color-picker" role="group" aria-label="Project color">
      <For each={COLOR_TAGS}>
        {(tag) => (
          <button
            type="button"
            class={`color-swatch ${
              props.project.color === tag ? "selected" : ""
            }`}
            style={{ "background-color": PALETTE[tag].accent }}
            title={tag}
            aria-label={tag}
            aria-pressed={props.project.color === tag}
            onClick={() => pick(tag)}
          />
        )}
      </For>
    </div>
  );
};
