# ADR-0012 — Cylindric 3D bucket-workspace geometry (constants + canvas renderer)

**Status:** Accepted — 2026-05-17

## Context

M7 polish round 5 had three rolling 3D-feel issues that surfaced
across one user session:

1. **Each project's active 3D view looked subtly different.** The
   `stackTiltDeg` formula was `Math.max(-6, Math.min(6,
   (activeProjectIdx() - mid) * 1.5))`, intentionally varying the
   cylinder's `rotateX` per-active-ring to convey "physical leaning"
   during navigation. With 7 projects, idx 0 had −4.5° tilt
   ("view from above") and idx 6 hit the +6° clamp ("view from
   below"). The user explicitly called this out: *"works great in
   the first project, but as we go down its style gets slightly
   off… the seventh project is too much off. In each project we
   need to see the same effect."*

2. **The "flat" version (with `stackTiltDeg = 0`) lost the
   cylindric feel.** Side panes still rotated around Y, but with
   no rotateX their tops didn't lean — the cylinder read as a
   horizontal fan, not as something wrapping around the camera.
   The user reported *"now we have lost the 3d effect of
   navigation. I want silindirik (cylindric) effect like before
   on each level."*

3. **The facing terminal's top frame was clipped against the
   workspace's title-bar / auto-hidden header strip.** The previous
   `top: 28px` inset on `.bw-rings.is-3d` left the accent-coloured
   outline kissing the window chrome.

Separately, **xterm's WebGL renderer froze inside the 3D-transformed
cylinder slots**: typing didn't repaint until a ⌘⌥-navigation
forced a `fitAddon.fit()` reflow. xterm's WebGL canvas was being
promoted to its own composited GPU layer under
`transform-style: preserve-3d`, and WebKit silently stopped
re-compositing the layer between draws. Buffer updated, screen
frozen. `onContextLoss` didn't fire because the context wasn't
lost — only the composited layer was desynced.

## Decision

Three constants, one renderer choice, and one inset value drive
the 3D workspace's look. All live in
`src/components/BucketWorkspace.tsx` and
`src/styles/bucket-workspace.css`. Each knob is independently
tunable.

### Geometry constants

| Constant            | Value | Effect                                                            |
| ------------------- | ----- | ----------------------------------------------------------------- |
| `FACE_WIDTH_FRAC`   | 0.62  | Cylinder slot tangential width as a fraction of panel width. Drives the cylinder *radius* — smaller value = tighter wrap. |
| `DOME_LIFT_FRAC`    | 0.18  | Side-slot vertical lift as a fraction of `ringHeightPx`. Slots translate up by `ratio × ringHeight × lift_frac`, where `ratio = |angle| / halfArc`. Facing slot at 0 lift; edge slots at full lift. |
| `stackTiltDeg`      | **−4° constant** | Fixed `rotateX` on the rings stack so the cylinder reads as enclosing rather than flat. Negative = top toward camera (view from slightly above). |

### CSS counterparts

- `.bw-pane.is-3d { inset: 0 21% }` — pane fills 58% of its slot
  (4% air per side). Decoupled from `FACE_WIDTH_FRAC` so adjacent
  panes have visible space between them — the gap is what makes
  the rotation animation read as motion, not slide.
- `.bw-rings.is-3d { top: 48px; bottom: 28px }` — breathing room
  above the facing pane so the accent outline isn't clipped
  against the title-bar / auto-hidden header strip.

### Slot transform composition

The slot transform is:

```ts
`rotateY(${angle}deg) translateZ(${r}px) translateY(${-lift}px)`
```

Order matters. `rotateY` first puts the slot at its cylinder
position; `translateZ` pushes it out along the rotated axis;
`translateY(-lift)` then translates straight up in *world* Y
(because `rotateY` preserves the world Y axis). Re-ordering
breaks the dome arrangement.

The rings stack itself uses:

```ts
`rotateX(${stackTiltDeg()}deg) translateY(${stackTranslateY()}px)`
```

`rotateX` first puts the active ring at local origin (no Z
displacement); `translateY` then translates the rest of the
stack to bring the active ring to viewer eye-level. The reverse
order (`translateY ∘ rotateX`) leaves the active ring at
`z = activeIdx × ringHeight × sin(tilt)`, which grew as the user
navigated down the stack and pulled lower rings progressively
toward the camera.

### Renderer

`TerminalPane.tsx` uses the **2D Canvas renderer**
(`@xterm/addon-canvas`) for every terminal. `@xterm/addon-webgl`
has been removed from the imports and is no longer load-bearing.
WebGL is ~15-30% faster on heavy output but its composited-layer
desync inside a `preserve-3d` ancestor is silent and untriggerable
by `onContextLoss`. For a Claude-Code launcher with moderate
terminal throughput the Canvas renderer is fast enough.

## Consequences

- **Every project's active 3D view is geometrically identical.**
  Navigating between rings only translates the stack vertically;
  the cylinder's orientation never changes. Verified by the user
  end-to-end across 7 projects.
- **`stackTiltDeg` is the single knob for "cylindric strength."**
  Bigger negative = more "leaning into a cylinder seen from
  above"; closer to 0 = flatter; positive = view from below.
  Tunable in isolation.
- **`DOME_LIFT_FRAC` is the single knob for "dome curvature."**
  Bigger = side panes lift higher; 0 = horizontal cylinder, no
  dome.
- **The CSS inset on `.bw-pane.is-3d` is a separate axis from
  `FACE_WIDTH_FRAC`.** Keep the inset slightly more aggressive
  than the geometric fraction so panes never visually touch
  during the rotation animation. If you want them to touch, the
  rotation reads as a slide and the 3D feel is lost.
- **WebGL is off-limits inside `preserve-3d` ancestors in this
  codebase.** If a future feature wants WebGL (Three.js, a custom
  shader pane, etc.), it must NOT be mounted inside a
  `.bw-rings.is-3d` subtree, OR it must accept the
  composited-layer-desync risk and force a reflow on every paint.
  ADR-0001's `allow-unsigned-executable-memory` entitlement is no
  longer load-bearing; left in place this slice but candidate for
  removal in a future cleanup.

## What we walked back from

- **Per-idx `stackTiltDeg` formula.** Shipped 2026-05-15 with the
  "physical leaning" rationale. Reverted 2026-05-17 because the
  per-ring variation broke the user's "every project must look
  identical" requirement. If the navigation needs a "physical"
  feel, do it as a transient overshoot during the transform
  transition, not a steady-state per-idx value.
- **`stackTiltDeg = 0` (no tilt).** Shipped intermediate to fix
  the consistency issue, but the user reported the cylindric feel
  was lost. Replaced with the constant −4° within the hour.
- **WebGL renderer with `onContextLoss` → `CanvasAddon` fallback.**
  Wired correctly for context LOSS, but did nothing for the
  composited-layer desync that's the actual failure mode in 3D
  mode. Dropping WebGL entirely is a one-line fix; trying to
  detect the desync and force `term.refresh()` is not.

## Revisit when

- Mahmut asks for a stronger / weaker cylindric feel — change
  `stackTiltDeg`'s constant only.
- Mahmut asks for a stronger / weaker dome — change
  `DOME_LIFT_FRAC` only.
- A future feature actually needs WebGL inside the 3D workspace
  (unlikely; the only WebGL consumer is xterm and Canvas is
  fine for it).
- The window chrome height changes (e.g. moving away from
  `hiddenTitle: true`) — re-evaluate the 48px top inset.

## See also

- `~/.claude/notes/css-3d-cylinder-workspace-feel.md` — reusable
  cross-project knowledge about getting cylindric 3D UIs right.
- ADR-0001 (`allow-unsigned-executable-memory` entitlement) —
  candidate for cleanup now that WebGL is retired.
- ADR-0010 §4 — preserve-3d ancestor chain.
- ADR-0011 — DnD must use pointer events inside this same 3D
  ancestor chain.
