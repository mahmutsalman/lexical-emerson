# Status — Lexical Emerson

**Last updated**: 2026-05-18 (session 5)
**Current phase**: v0.1 shipped + post-v0.1 feature work (keyboard UX layer, visual polish)
**Current slice**: D1/D2 polish — armed-mode M-key panel toggle + active tab accent fill

---

## Last Completed Task
Two features shipped this session: (1) active terminal tab fills with the full project accent color for instant recognizability; (2) pressing M while footer is armed toggles hide-panels globally across all open project windows in the bucket via Tauri broadcast.

## Next Concrete Action
Verify both features in the prod build: active tab should be solid accent color; Shift → footer → M should hide/show panels on every project window simultaneously; M in terminal (unarmed) should type normally.

## Active Blockers
- none

## Open Questions
- New project windows opened mid-session inherit `panelsHidden=false` (not the current bucket state). User can re-press M to sync. Acceptable for now; could fix later with a "request current state on mount" emit.
- Manual `claude` typed >10 s after PTY open won't get a binding → won't persist at close. Acceptable for now.
- Root cause of "command typed twice" symptom only defensively guarded — if double-fire warn fires, dig deeper.
- RAM-optimization backlog at `~/.claude/plans/image-4-can-you-check-reflective-snowflake.md` — Tier A/B/C queued.

## Recent Decisions (last 3)
- (2026-05-18, session 5) — M-key panel toggle broadcasts via Tauri `panels://changed` event. Sender sets local state immediately then emits; receivers skip non-project windows and short-circuit on state-equality. Title-bar panel button stays local-only (unchanged).
- (2026-05-18, session 5) — Active terminal tab fills with `var(--proj-accent, #2d5cc8)`. close-button gets rgba(255,255,255,0.7) so it reads on any accent. Editor-tab dirty dot overridden to white on active to avoid invisible accent-on-accent. border-bottom also switches to accent to preserve the "tab merges into content" visual.
- (2026-05-18, session 4) — Global ShiftRight detector. Moved from per-TerminalPane to `src/lib/shift-arm.ts` singleton; always targets "footer"; mousedown taints to prevent Shift+Click arming.
