# Tasks — No active slice

> Regenerated each milestone from `plan.md` + recent ADRs. Do not edit by hand long-term — rewrite at slice boundaries.

## Status: M7 closed 2026-05-16

M7 (Bucket Workspace) shipped today. No new slice is active.

The user said the workspace "works" and "looks good right now" with optional
style polish noted for later. STATUS.md → "Next Concrete Action" lists those
polish items.

## Candidate next slices (pick one when ready)

### Option A — M7.1 polish (1–2 hours)
- Tighten 3D ring visuals (current dim non-active rings + box-shadow can read
  as cluttered)
- Carry per-project accent colour into the 3D pane border for at-a-glance
  project identification
- Decide fate of the header **Debug** toggle — remove, hide behind a
  shortcut, or leave as-is

### Option B — v0.2 candidates (each ~1 day)
- Notarization + GitHub Release with prebuilt DMG (ADR-0008 deferred this;
  reactivate if external users ask)
- Linux + Windows builds
- Per-project shell override (currently uses `$SHELL`, falls back to `/bin/zsh`)
- Dotfile visibility toggle (⌘.)
- Split-pane terminals (two terminals side by side in one project window —
  distinct from M2's stacked tabs)

### Option C — Workspace-session persistence
- Workspace-owned terminals currently die with the app process. A small
  session-snapshot layer (last-active workspace bucket + which `+` terminals
  it had open) would let the workspace boot back to where the user left it.
- Open question in `docs/STATUS.md` and the M7 handoff.

## When picking a slice

1. Update `docs/plan.md` "Active slice" line.
2. Rewrite this file with the new slice's exit criteria + task list.
3. Use `/checkpoint` at session ends, `/where-am-i` at session starts.
