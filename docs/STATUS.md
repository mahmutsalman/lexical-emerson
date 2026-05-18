# Status — Lexical Emerson

**Last updated**: 2026-05-18 (session 3)
**Current phase**: v0.1 shipped + post-v0.1 feature work (keyboard UX layer, visual polish, per-bucket idle config)
**Current slice**: D1/D2 polish — keyboard enter/escape flow + armed-header visual cue + per-bucket idle timeout

---

## Last Completed Task
Per-bucket idle-suspend timeout: each bucket stores its own `idle_suspend_min` (15 / 30 / 60, default 60). Toggle renders inline in each bucket header row in BucketsList sidebar. Active bucket's timeout governs all open project windows reactively. DB migration via existing `migrate_buckets_columns()` pattern; broadcasts via `buckets://changed`.

## Next Concrete Action
Relaunch app after bundle install, verify: (1) each bucket row shows [15·30·60] with 60 highlighted, (2) toggling updates all windows, (3) persists across restart. Then verify the Enter/right-Shift-tap terminal flow from the same session.

## Active Blockers
- none

## Open Questions
- Manual `claude` typed >10 s after PTY open won't get a binding → won't persist at close. Acceptable for now.
- Root cause of "command typed twice" symptom only defensively guarded — if double-fire warn fires post-fix, dig deeper.
- "Loads twice then stops" confirmations across N>2 project windows still needed (carried forward).
- 1/7 projects intermittently drops Enter/typing in 3D mode (carried forward, low-priority).
- `@xterm/addon-webgl` still in `package.json` — `npm uninstall` candidate.
- RAM-optimization backlog at `~/.claude/plans/image-4-can-you-check-reflective-snowflake.md` — Tier A/B/C queued. B1 lazy-mount terminals in BucketWorkspace is biggest win (~245 MB → ~100 MB).

## Recent Decisions (last 3)
- (2026-05-18, no ADR) — Enter + right-Shift-tap terminal flow. Enter in armed bar focuses terminal (disarms bar, existing createEffect handles focus). Right-Shift tap (300 ms window, not tainted by other keys) returns focus to last-armed bar. `src/lib/arm-focus.ts` tracks last-armed ("footer" default). `lexical:focus-terminal` CustomEvent channels BucketBar → TerminalsView.
- (2026-05-18, no ADR) — Armed header bottom stripe. `.terminal-tabs.is-armed` gets a second inset box-shadow on the bottom edge (`inset 0 -2px 0 var(--proj-accent, #4f88ff)`), mirroring the footer's top stripe. Baseline top stripe unchanged — bottom stripe is the armed-only signal.
- (2026-05-18, no ADR) — Per-bucket idle timeout. `idle_suspend_min INTEGER NOT NULL DEFAULT 60` added to `buckets` table. `idleSuspendMin` memo in App.tsx derives from `activeBucket`, passed as prop to TerminalsView. `idleCheckTick` reads it reactively. Toggle in BucketsList dispatches `set_bucket_idle_suspend_min` command which broadcasts `buckets://changed`.
