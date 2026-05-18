# Status — Lexical Emerson

**Last updated**: 2026-05-18 (session 6)
**Current phase**: v0.1 shipped + post-v0.1 feature work (keyboard UX layer, visual polish)
**Current slice**: D1/D2 polish — frequent-projects feature (star + Space cycle)

---

## Last Completed Task
Frequent-projects feature fully shipped and verified: F stars current project, Space cycles among only starred projects AND switches the window. Three bugs fixed over the session: (1) held-Shift ambiguity → moved binding to F key; (2) stale cursor in F/Space handlers → optimistic localCursor signal; (3) Space updated footer but didn't switch window → added requestOpenProject call alongside setBucketCursorToProject.

## Next Concrete Action
Pick next feature from the keyboard UX backlog or RAM-optimization Tier A tasks (see `~/.claude/plans/image-4-can-you-check-reflective-snowflake.md`).

## Active Blockers
- none

## Open Questions
- New project windows opened mid-session inherit `panelsHidden=false` (not the current bucket state). Acceptable for now; could fix later with a "request current state on mount" emit.
- Manual `claude` typed >10 s after PTY open won't get a binding → won't persist at close. Acceptable for now.
- RAM-optimization backlog at `~/.claude/plans/image-4-can-you-check-reflective-snowflake.md` — Tier A/B/C queued.

## Recent Decisions (last 3)
- (2026-05-18, session 6) — Space in armed footer calls both requestOpenProject (switches window) and setBucketCursorToProject (updates cursor), mirroring the BucketsList sidebar-click pattern.
- (2026-05-18, session 6) — Optimistic localCursor signal in BucketBar: set synchronously on ArrowLeft/Right, reset to null when props.activeBucket resource settles. Fixes stale-cursor mis-fires in F and Space handlers.
- (2026-05-18, session 6) — Frequent-project mark binding moved from Shift+Space to F key. Reason: e.shiftKey is true on any keypress while right-Shift is physically held, making Shift+Space mis-fire on every plain Space press the user intended as "cycle frequent."
