# ADR-0011 — Pointer-event-based drag-and-drop, not native HTML5 DnD, inside CSS-3D ancestors

**Status:** Accepted — 2026-05-16

## Context

M7 polish round 3 added drag-to-reorder of project rows in the Bucket
Workspace's 2D tab strip, with the bucket's `bucket_projects.position`
column kept in sync across every open window via the existing
`buckets://changed` broadcast.

The first implementation used native HTML5 drag-and-drop: `draggable`
attribute on `.bw-tabrow`, `onDragStart`/`onDragOver`/`onDragLeave`/
`onDrop`/`onDragEnd` handlers, manual `dragSrcIdx` / `dragOverIdx` /
`dragOverBefore` signals on `BucketWorkspace`, and an insert-line
indicator computed from `event.clientY` against the hovered row's
bounding rect.

It compiled, type-checked, and the dragstart fired correctly — the
ghost image followed the cursor as expected. But **the `drop` event
never fired on release**. The drag would visibly end (the ghost
disappeared) without the row moving, and the source row's `dragend`
handler ran but left the array unchanged.

Root cause: the Bucket Workspace's 3D mode uses a `perspective:` +
`transform-style: preserve-3d` ancestor chain on `.bw-stack` /
`.bw-rings` / `.bw-ring` / `.bw-cylinder` (see ADR-0010 §4 and the
BucketWorkspace.tsx geometry comments). Even when the user is in 2D
mode and the tab strip is the only visible UI, the parent
`.bucket-workspace` container has CSS-3D transforms in its subtree, and
**WebKit refuses to dispatch the native `drop` event when any ancestor
between the drop target and the document is in a 3D rendering context**.
This is not a configuration bug — `e.preventDefault()` was called on
`dragover`, `dataTransfer.setData()` was wired, `dropEffect` was set.
The browser silently swallows the drop because hit-testing through the
3D context is unreliable.

This is a documented WebKit / Blink limitation around CSS-3D + native
DnD, and there's no flag, ancestor-tweak, or polyfill that fixes it
short of removing the 3D ancestor entirely (which we can't — it's the
whole feature of the workspace).

## Decision

For drag-and-drop **anywhere inside a CSS-3D / `perspective` ancestor
chain**, use a **pointer-event-based** library, not native HTML5 DnD.

For Lexical Emerson this means **`@thisbeyond/solid-dnd`** v0.7.5 — the
Solid port of the React `@dnd-kit` family. It uses document-level
pointer events (`pointerdown` / `pointermove` / `pointerup`) instead of
the browser's `dragstart` / `dragover` / `drop` pipeline, so the 3D
ancestor is irrelevant to its event flow.

API parity with dnd-kit (which the user already trusts in
NotesWithAudioAndVideo):

| dnd-kit (React)          | solid-dnd (Solid)        |
| ------------------------ | ------------------------ |
| `<DndContext>`           | `<DragDropProvider>`     |
| `<SortableContext>`      | `<SortableProvider>`     |
| `useSortable`            | `createSortable`         |
| `CSS.Transform.toString` | `transformStyle`         |
| `closestCenter`          | `closestCenter` (same)   |

`PointerSensor` defaults — 250ms activation delay AND 10px activation
distance — make click-vs-drag separation automatic: a quick tap on a
row still falls through to the row's `onClick`, and only sustained
pointer-down + movement starts a drag. No `e.stopPropagation()`
gymnastics on child buttons.

`use:sortable` is a Solid directive; the `JSX.Directives` augmentation
that registers it lives inline in BucketWorkspace.tsx. If a second
component adopts solid-dnd, factor that into
`src/types/solid-dnd.d.ts` rather than duplicating.

## Consequences

- **Drag-drop now works inside any 3D-transformed subtree** without
  special-casing the parent element. Future reordering features in the
  3D rings themselves (e.g. drag a terminal pane from one ring to
  another, drag the notes face to a different cylinder slot) inherit
  this.
- **`@thisbeyond/solid-dnd` joins the runtime deps.** ~12kb gzipped,
  one author, last published recently, MIT licensed. Risk profile
  acceptable for a single-component dependency.
- **HTML5 native DnD is now off-limits in this codebase.** Even in
  flat-2D views, anything dragged inside `.bucket-workspace` has a 3D
  ancestor; anything dragged inside a per-project window's
  `.terminals-view.is-3d` does too. Use solid-dnd everywhere; don't
  mix.
- **The activation threshold (250ms / 10px) is a behaviour choice.**
  If a future feature needs click-on-press drag-start (e.g. a
  dedicated grab handle), instantiate `PointerSensor` manually with
  `{ activationDelay: 0, activationDistance: 0 }` rather than fighting
  the default via `e.stopPropagation`.
- **No keyboard reordering yet.** dnd-kit has `KeyboardSensor`;
  solid-dnd v0.7 does not. If accessibility ever requires keyboard
  reorder, either contribute one upstream or ship our own
  `(ArrowUp/Down + space)` handler at the SortableProvider level.

## What we walked back from

- **Manual HTML5 DnD with insert-line indicators.** ~85 lines of
  signal + handler code in BucketWorkspace.tsx, plus matching
  `.drop-before` / `.drop-after` CSS rules. Worked through the
  geometry math correctly. Failed in the browser because of the
  CSS-3D + native DnD interaction described in Context.
- **Lesson:** if a Solid (or any) UI puts a draggable area inside a
  `transform: preserve-3d` / `perspective:` ancestor, skip native
  DnD entirely. The build will compile, the types will pass, the
  drag will start — and the `drop` will never fire. There is no
  diagnostic for this; it's silent.

## Revisit when

- Solid gets first-class drag-drop primitives in core, OR
- `@thisbeyond/solid-dnd` becomes unmaintained (last release more
  than ~18 months ago, AND a security issue surfaces). At that
  point, evaluate `solid-sortable` or write a thin pointer-event
  wrapper on top of `pointerdown`/`pointermove`/`pointerup`
  directly — the engine is small enough to fit in ~150 lines.
- We add a keyboard accessibility pass for the workspace; that's
  the natural moment to either upgrade solid-dnd (if it gained
  `KeyboardSensor` by then) or layer our own.
