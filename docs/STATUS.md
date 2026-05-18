# Status — Lexical Emerson

**Last updated**: 2026-05-18 07:15
**Current phase**: v0.1 shipped + post-v0.1 feature work (M6 notes, M7 workspace, M7.5 session restore, M8 RAM optimization, D1/D2 suspend-resume)
**Current slice**: D1/D2 polish — armed keyboard navigation layer complete (bucket bar + tab strip + vertical switching)

---

## Last Completed Task
Shipped commit `e703bdf` — armed tab strip with vertical arrow-key switching between header and footer. Click the terminal/editor tab strip to arm it; ← / → cycle through the unified terminals + editors list; ↓ hands arm off to the bucket bar footer (← / → now cycles projects); ↑ in the armed footer hands arm back to the header. Fixed ArrowDown focus leak (`e.stopPropagation()` + `verticalSwitching` flag) that was sending cursor-down to the Claude Code terminal input during the header→footer arm handoff.

## Next Concrete Action
User empirically verifies the full keyboard navigation round-trip: click header strip → ← / → cycle terminals/editors → ↓ → bucket bar arms → ← / → cycle projects → ↑ → header re-arms → Esc → focus back in terminal. Also confirm cross-window: ↓ in window A's header arms BOTH windows' footers (broadcastArmed propagates). Watch for any focus issues with the ↑ handoff direction (footer→header) under key-repeat.

## Active Blockers
- none

## Open Questions
- Manual `claude` typed >10 s after PTY open won't get a binding → won't persist at close. Acceptable for now (suspend's exclude-list fallback still handles it within a session).
- Root cause of the "command typed twice" symptom (image 5 from earlier session) is only defensively guarded — if the handlePaneSpawned double-fire warn ever fires post-fix, that's the signal to dig.
- "Loads twice then stops" / focus-refit confirmations from `954e80f` and `e042f48` still need real-world confirmation across N>2 project windows (carried forward).
- 1/7 projects intermittently drops Enter/typing in 3D mode (carried forward, low-priority).
- `@xterm/addon-webgl` still in `package.json` — `npm uninstall` candidate, decorative since ADR-0012.
- RAM-optimization backlog parked at `~/.claude/plans/image-4-can-you-check-reflective-snowflake.md` — Tier A/B/C remain queued. Biggest win is B1 lazy-mount terminals in BucketWorkspace (~245 MB → ~100 MB).

## Recent Decisions (last 3)
- (2026-05-18, no ADR) — Armed tab strip with vertical switching. `window.dispatchEvent(CustomEvent "lexical:arm-switch-vertical { target: header|footer }")` coordinates the two strips; same-window siblings confirmed via App.tsx tree, no Tauri round-trip needed. ArrowDown focus leak fixed with `verticalSwitching` flag + `e.stopPropagation()`.
- (2026-05-18, no ADR) — Bind Claude UUID to the tab, not to its cwd. Per-tab `claudeUuidByTab` signal replaces cwd-scan model; `persist_project_terminals` now takes `Vec<PersistTabInput { cwd, claude_session_id }>`.
- (2026-05-17, no ADR) — Tier D D1 — auto-suspend idle Claude sessions, 20-min idle threshold, idle-time-only trigger model, silent auto-resume on terminal click/keystroke.
