# Status — Lexical Emerson

**Last updated**: 2026-05-18 (session 8)
**Current phase**: v0.1 shipped + post-v0.1 feature work (keyboard UX, visual polish, session-restore robustness)
**Current slice**: Idle-suspend timeout UX — cycle button replaces segmented control, reset-on-change

---

## Last Completed Task
Replaced the per-bucket `[15 · 30 · 60]` segmented idle-suspend control in BucketsList with a single cycle button that walks `[15, 30, 60, 90, 120, 180, 240]` minutes (showing current value with "m" suffix). Added a `createEffect` in TerminalsView that watches `props.idleSuspendMin()` and resets `lastInputAtByTab` + `lastOutputAtByTab` to `Date.now()` for every tab in the project whenever the value changes — so cycling to a smaller value can't instantly suspend a tab and cycling up always grants the full new grace period.

## Next Concrete Action
No specific item queued. Open keyboard UX backlog from earlier sessions, RAM-optimization Tier A from `~/.claude/plans/image-4-can-you-check-reflective-snowflake.md`, or chase the still-open window-close persist mystery diagnostically.

## Active Blockers
- none

## Open Questions
- Why does the window-close persist (`TerminalsView.tsx onCloseRequested` → Rust) not run for ANY project window? Universal silent failure; cosmetic since session 7's per-event saves cover the practical case but still a real defect.
- `src/lib/arm-focus.ts` likely dead code since session 4. Low-priority cleanup.

## Recent Decisions (last 3)
- (2026-05-18, session 8) — Per-bucket idle-suspend uses a single cycle button (not a dropdown, not a numeric input). Values fixed to `[15, 30, 60, 90, 120, 180, 240]`. Click semantics: cycle to next, reset all tabs' idle counters to now.
- (2026-05-18, session 8) — Reset-on-change implemented as a `createEffect` on `props.idleSuspendMin` in TerminalsView (reactivity-only, no new Tauri event). Solid `(prev) => current` pattern skips the initial-mount fire.
- (2026-05-18, session 7) — Per-event persist via `queueMicrotask(persistNow)` from `closeTerminal` and post-spawn UUID bind; window-close handler becomes safety net rather than load-bearing path.
