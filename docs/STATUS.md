# Status — Lexical Emerson

**Last updated**: 2026-05-18 (session 4)
**Current phase**: v0.1 shipped + post-v0.1 feature work (keyboard UX layer, visual polish, per-bucket idle config)
**Current slice**: D1/D2 polish — armed-mode robustness fixes

---

## Last Completed Task
Global ShiftRight-tap detector + single-terminal armTabs fix: Shift now arms the footer regardless of focus state (fresh window, auto-resume, CodeMirror, sidebar). ArrowUp from footer with 1 tab now correctly arms the header strip instead of leaving focus orphaned.

## Next Concrete Action
Verify both fixes in the prod build: (1) tap ShiftRight immediately after window open / auto-resume — footer must arm without clicking first; (2) single-terminal window: Shift → footer → ArrowUp → header arms → Enter → terminal focused; ArrowDown → footer arms.

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
- (2026-05-18, session 4) — Global ShiftRight detector. Moved from per-TerminalPane (gated on hostEl focus) to `src/lib/shift-arm.ts` singleton, wired via App.tsx onMount/onCleanup. No focus gate. Mousedown during hold taints to prevent Shift+Click arming. Always dispatches target: "footer".
- (2026-05-18, session 4) — armTabs() arms unconditionally. Removed total < 2 guard. With 1 tab, header strip arms and Enter/ArrowDown both work. cycleAll(±1) is already a no-op when n=1 (modular arithmetic stays in place).
- (2026-05-18, no ADR) — Right-Shift tap (not Esc) for return-to-bar. Plain Esc would have clobbered Claude Code's own Escape. Tap detection (keydown+keyup pair, 300 ms window, taint-on-other-key) distinguishes from Shift-as-modifier.
