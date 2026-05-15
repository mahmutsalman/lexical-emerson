import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
} from "solid-js";
import type { Accessor } from "solid-js";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import { markActive, onMenuEvent } from "../lib/ipc";

interface Tab {
  id: string;
  cwd: string;
  projectPath: string;
}

let tabCounter = 0;
const newTabId = () => `tab-${++tabCounter}`;

export interface TerminalsViewProps {
  cwd: string;
  projectPath: string;
  zoom?: Accessor<number>;
  accent?: Accessor<string | null>;
}

export const TerminalsView: Component<TerminalsViewProps> = (props) => {
  // All terminals across all visited projects. xterm instances and their
  // backing PTYs stay alive as long as the entry stays in this array — the
  // user owns the lifecycle by closing tabs explicitly.
  const [allTabs, setAllTabs] = createSignal<Tab[]>([]);
  const [activeByProject, setActiveByProject] = createSignal<
    Record<string, string>
  >({});
  const [is3dByProject, setIs3dByProject] = createSignal<
    Record<string, boolean>
  >({});
  // Free-rotation offset on top of the auto-centred-on-active rotation. ⌘⌥←
  // and ⌘⌥→ add/subtract a slot-angle so the user can "look around" the
  // cylinder without changing which terminal is focused. Resets to 0 whenever
  // ⌘K cycles focus (snap-to-active) or the 3D toggle flips.
  const [manualRotationByProject, setManualRotationByProject] = createSignal<
    Record<string, number>
  >({});
  const [panelWidth, setPanelWidth] = createSignal(800);

  let stackEl!: HTMLDivElement;
  const handles = new Map<string, TerminalHandle>();

  const projectTabs = createMemo(() =>
    allTabs().filter((t) => t.projectPath === props.projectPath),
  );

  const activeId = () => activeByProject()[props.projectPath] ?? "";

  // 3D arc layout. Standard CSS-3D carousel math, adapted so the active
  // terminal sits at ~70% size in the centre and the immediate neighbours
  // peek in from the margins. Geometry:
  //
  //   wrapper:  translateZ(-(R + D)) rotateY(-α_active)
  //   face_i:   rotateY(α_i) translateZ(R)
  //
  //   With wrapper undoing α_active and translating back by R+D, the active
  //   face lands at world z = -D (slightly behind the screen plane), which
  //   shrinks it to roughly P/(P+D) of its layout size. The wrapper's extra
  //   translateZ(-D) on top of -R is THE key — without it, the active face
  //   ends up at z = +R, often past the perspective distance, and the whole
  //   scene either clips or implodes.
  const is3d = () =>
    (is3dByProject()[props.projectPath] ?? false) && projectTabs().length >= 2;
  // 45° per slot keeps adjacent neighbours readable while still letting up to
  // 5 terminals fit in front of the viewer (180° arc). For N ≥ 6 the slots
  // pack tighter to stay inside that 180° front-arc.
  const arcDeg = (n: number) => Math.min(180, Math.max(n - 1, 1) * 45);
  const slotAngleDeg = (n: number) => arcDeg(n) / Math.max(n - 1, 1);
  const slotOffsetDeg = (i: number, n: number) =>
    -arcDeg(n) / 2 + i * slotAngleDeg(n);
  // Inscribed cylinder — adjacent faces touch at z = 0 in the cylinder frame
  // (before the wrapper's translateZ pulls everything back). Uses the
  // narrowed face width (62% of viewport), matching `.terminal-host.is-3d`'s
  // width: 62% rule in CSS.
  const FACE_WIDTH_FRAC = 0.62;
  const radius = () => {
    const n = projectTabs().length;
    if (n < 2) return 0;
    const halfSlotRad = (slotAngleDeg(n) * Math.PI) / 180 / 2;
    return (panelWidth() * FACE_WIDTH_FRAC) / 2 / Math.tan(halfSlotRad);
  };
  const perspectivePx = () => Math.max(panelWidth() * 1.2, 1000);
  const activeIdx = () =>
    projectTabs().findIndex((t) => t.id === activeId());
  // Auto-centre the active terminal (its world angle becomes 0°, facing the
  // viewer straight-on) plus the user's manual rotation offset. Panoramic
  // (no auto-centre) would leave the active terminal tilted at its slot
  // angle — readable but visibly off-axis. Auto-centre keeps the focused
  // terminal in the natural reading position; ⌘⌥←/→ lets the user pan
  // around the cylinder when they want to peek at non-active slots.
  const wrapperRotation = () => {
    const n = projectTabs().length;
    if (n < 2) return 0;
    const idx = activeIdx();
    const autoCenter = idx < 0 ? 0 : -slotOffsetDeg(idx, n);
    const manual = manualRotationByProject()[props.projectPath] ?? 0;
    return autoCenter + manual;
  };

  const setActiveForCurrent = (id: string) => {
    setActiveByProject((prev) => ({ ...prev, [props.projectPath]: id }));
  };

  const addTerminal = (cwd?: string) => {
    const tab: Tab = {
      id: newTabId(),
      cwd: cwd ?? props.cwd,
      projectPath: props.projectPath,
    };
    setAllTabs((prev) => [...prev, tab]);
    setActiveForCurrent(tab.id);
  };

  const closeTerminal = (id: string) => {
    const tab = allTabs().find((t) => t.id === id);
    if (!tab) return;
    handles.delete(id);
    setAllTabs((prev) => prev.filter((t) => t.id !== id));

    // Re-select within the project the closed tab belonged to.
    if (id === activeByProject()[tab.projectPath]) {
      const remaining = allTabs().filter(
        (t) => t.projectPath === tab.projectPath && t.id !== id,
      );
      if (remaining.length > 0) {
        setActiveByProject((prev) => ({
          ...prev,
          [tab.projectPath]: remaining[remaining.length - 1].id,
        }));
      } else if (tab.projectPath === props.projectPath) {
        // Last terminal in the *current* project: spawn a fresh one so the
        // user is never left looking at an empty terminal stack.
        addTerminal();
      } else {
        // Last terminal in a non-active project: just clear the active mark.
        setActiveByProject((prev) => {
          const next = { ...prev };
          delete next[tab.projectPath];
          return next;
        });
      }
    }
  };

  const cycleTerminal = (delta: number) => {
    const arr = projectTabs();
    if (arr.length < 2) return;
    const idx = arr.findIndex((t) => t.id === activeId());
    if (idx === -1) return;
    const next = (idx + delta + arr.length) % arr.length;
    setActiveForCurrent(arr[next].id);
    // Snap back to auto-centre: any free-rotation pan the user did with
    // ⌘⌥←/→ is discarded so ⌘K predictably "jumps to" the new active.
    resetManualRotation();
  };

  const resetManualRotation = () => {
    setManualRotationByProject((prev) => {
      if (!(props.projectPath in prev)) return prev;
      const next = { ...prev };
      delete next[props.projectPath];
      return next;
    });
  };

  const nudgeManualRotation = (deltaSign: 1 | -1) => {
    const n = projectTabs().length;
    if (n < 2) return;
    const step = slotAngleDeg(n);
    setManualRotationByProject((prev) => ({
      ...prev,
      [props.projectPath]:
        (prev[props.projectPath] ?? 0) + deltaSign * step,
    }));
  };

  // Whenever the project changes (or on first mount), ensure this project
  // has at least one terminal and a valid active id.
  createEffect(() => {
    const path = props.projectPath;
    const ptabs = projectTabs();
    const current = activeByProject()[path];
    if (ptabs.length === 0) {
      addTerminal();
    } else if (!current || !ptabs.find((t) => t.id === current)) {
      setActiveByProject((prev) => ({ ...prev, [path]: ptabs[0].id }));
    }
  });

  // Focus the active tab whenever it changes. Belt + suspenders: macOS menu
  // accelerators (⌘K, ⌘⌥3, ⌘⌥←/→) capture the keystroke and seem to
  // restore focus AFTER our microtask runs, parking it back on the previous
  // active. The setTimeout backup re-focuses on a later turn, beating the
  // OS focus restoration.
  const focusActive = () => {
    const id = activeId();
    if (!id) return;
    queueMicrotask(() => handles.get(id)?.focus());
    setTimeout(() => handles.get(id)?.focus(), 50);
  };
  createEffect(() => {
    activeId();
    focusActive();
  });
  // Same belt-and-suspenders on 3D toggle and manual rotation — the
  // accelerator that triggered them stole the textarea's focus.
  createEffect(() => {
    is3d();
    manualRotationByProject();
    focusActive();
  });

  // 30s-debounced project-activity ping.
  let lastMarked = 0;
  const markActivityForCurrent = () => {
    const now = Date.now();
    if (now - lastMarked < 30_000) return;
    lastMarked = now;
    const path = props.projectPath;
    markActive(path).catch((err) =>
      console.warn("mark_active failed:", err),
    );
  };

  onMount(async () => {
    const unlistens: UnlistenFn[] = await Promise.all([
      onMenuEvent("terminal-new", () => addTerminal()),
      onMenuEvent("terminal-close", () => {
        const id = activeId();
        if (id) closeTerminal(id);
      }),
      onMenuEvent("terminal-next", () => cycleTerminal(1)),
      onMenuEvent("terminal-prev", () => cycleTerminal(-1)),
      onMenuEvent("terminal-toggle-3d", () => {
        // No-op with fewer than 2 terminals — nothing to fan out.
        if (projectTabs().length < 2) return;
        setIs3dByProject((prev) => ({
          ...prev,
          [props.projectPath]: !prev[props.projectPath],
        }));
        // Drop any free-rotation pan so the toggle always starts from the
        // canonical "active centred" view.
        resetManualRotation();
      }),
      onMenuEvent("terminal-rotate-left", () => {
        if (!is3d()) return;
        nudgeManualRotation(+1);
      }),
      onMenuEvent("terminal-rotate-right", () => {
        if (!is3d()) return;
        nudgeManualRotation(-1);
      }),
    ]);

    // Prime panelWidth synchronously so the first 3D toggle has correct
    // geometry, even before ResizeObserver gets its first callback.
    if (stackEl?.clientWidth) setPanelWidth(stackEl.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPanelWidth(e.contentRect.width);
    });
    ro.observe(stackEl);

    onCleanup(() => {
      unlistens.forEach((u) => u());
      ro.disconnect();
    });
  });

  return (
    <div class={`terminals-view ${is3d() ? "is-3d" : ""}`}>
      <div class="terminal-tabs">
        <For each={projectTabs()}>
          {(tab, idx) => (
            <button
              type="button"
              class={`terminal-tab ${tab.id === activeId() ? "active" : ""}`}
              onClick={() => setActiveForCurrent(tab.id)}
              title={tab.cwd}
            >
              <span class="tab-label">
                {idx() + 1}. {basename(tab.cwd)}
              </span>
              <span
                class="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(tab.id);
                }}
                title="Close terminal"
              >
                ×
              </span>
            </button>
          )}
        </For>
        <button
          type="button"
          class="terminal-tab-add"
          onClick={() => addTerminal()}
          title="New terminal (⌘T)"
        >
          +
        </button>
      </div>
      <div
        class="terminal-stack"
        ref={stackEl}
        style={
          is3d() ? { perspective: `${perspectivePx()}px` } : undefined
        }
      >
        <div
          class={`cylinder ${is3d() ? "is-3d" : ""}`}
          style={
            is3d()
              ? {
                  transform: `translateZ(${-radius()}px) rotateY(${wrapperRotation()}deg)`,
                }
              : undefined
          }
        >
          <For each={allTabs()}>
            {(tab) => {
              const inThisProject = () =>
                tab.projectPath === props.projectPath;
              const tabIdx = () =>
                projectTabs().findIndex((t) => t.id === tab.id);
              const isFacing = () => tab.id === activeId();
              const hostStyle = () => {
                if (!inThisProject()) return { display: "none" };
                if (!is3d()) {
                  return {
                    display: isFacing() ? "flex" : "none",
                  } as Record<string, string>;
                }
                const idx = tabIdx();
                if (idx < 0) return { display: "none" };
                const n = projectTabs().length;
                const angle = slotOffsetDeg(idx, n);
                const r = radius();
                return {
                  display: "flex",
                  transform: `rotateY(${angle}deg) translateZ(${r}px)`,
                } as Record<string, string>;
              };
              return (
                <div
                  class={`terminal-host ${is3d() && inThisProject() ? "is-3d" : ""} ${
                    is3d() && isFacing() ? "is-facing" : ""
                  }`}
                  style={hostStyle()}
                >
                  <TerminalPane
                    cwd={tab.cwd}
                    onReady={(h) => handles.set(tab.id, h)}
                    onActivity={markActivityForCurrent}
                    zoom={props.zoom}
                    accent={props.accent}
                  />
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
};

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
