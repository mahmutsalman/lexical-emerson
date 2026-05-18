# Status — Lexical Emerson

**Last updated**: 2026-05-18 06:05
**Current phase**: v0.1 shipped + post-v0.1 feature work (M6 notes, M7 workspace, M7.5 session restore, M8 RAM optimization, D1/D2 suspend-resume)
**Current slice**: D1/D2 bugfix pass — per-tab UUID binding so suspend/resume doesn't converge same-cwd tabs onto a single Claude session

---

## Last Completed Task
Shipped commit `3380f1f` — "fix: per-tab Claude UUID binding to stop suspend/resume convergence". Diagnosed and fixed the user-reported bug where clicking Resume on a suspended Claude tab eventually produced two duplicate tabs both running `claude --resume <same-uuid>`. Root cause: `suspendTab` and `persist_project_terminals` both keyed off `detectClaudeSessionsForCwd(tab.cwd)[0]` (newest .jsonl in the cwd), which is shared across every tab pointing at that directory. Fix introduces `claudeUuidByTab` signal seeded at restore from the persisted row, refreshed at handlePaneSpawned via a post-spawn jsonl-diff poll (1.5s/+2s/+2.5s/+4s ≈ 10s) that identifies the NEW UUID `claude` creates on resume. `persist_project_terminals` now takes Vec<PersistTabInput { cwd, claude_session_id }> instead of Vec<cwd>; Rust dedupes by (cwd, uuid) with `session_file_exists` check. Defensive guard added to `handlePaneSpawned` against double-fire (the symptom that surfaced as `claude --resume` typed twice in image 5). Built via `cargo tauri build --bundles app`; installed via `rm -rf` + `ditto` per the in-app-hosting rule.

## Next Concrete Action
User empirically verifies the fix end-to-end: quit and relaunch from `/Applications`, open LearnTogetherMultiplayer (the project that reproduced the bug), confirm the duplicate-row restore is healed by the (cwd, uuid) dedupe at onMount, then run a full suspend → resume cycle (manual Cmd+Alt+S or wait for 20-min idle) and confirm tabs stay 1:1 with distinct UUIDs. Watch devtools console for `[bind] tab X → uuid Y` lines (good) and `[TerminalsView] handlePaneSpawned: tab already bound, ignoring` warns (bad — would mean the double-spawn we suspected has a real source still in the code, not just paranoid defense).

## Active Blockers
- none

## Open Questions
- Manual `claude` typed >10 s after PTY open won't get a binding → won't persist at close. Acceptable for now (suspend's exclude-list fallback still handles it within a session), but if a user types claude late and loses the tab on next launch, we'll need a longer-running watcher or PTY-output sniffer.
- Root cause of the "command typed twice" symptom (image 5) is not pinpointed — only defensively guarded in handlePaneSpawned. If the guard's warn fires post-fix, that's the signal to dig.
- "Loads twice then stops" / focus-refit confirmations from `954e80f` and `e042f48` still need real-world confirmation across N>2 project windows (carried forward).
- 1/7 projects intermittently drops Enter/typing in 3D mode (carried forward, low-priority).
- `@xterm/addon-webgl` still in `package.json` — `npm uninstall` candidate, decorative since ADR-0012.
- RAM-optimization backlog parked at `~/.claude/plans/image-4-can-you-check-reflective-snowflake.md` — Tier A/B/C remain queued. Biggest single win is B1 lazy-mount terminals in BucketWorkspace (~245 MB → ~100 MB on the workspace window).

## Recent Decisions (last 3)
- (this session, no ADR) — **Bind Claude UUID to the tab, not to its cwd.** The cwd-scan model (`detectClaudeSessionsForCwd(cwd)[0]`) is the source of every convergence symptom: same-cwd tabs read the same "newest", `claude --resume` chains create more .jsonl rows that persist re-reads on next close, and over a few cycles a single tab inflates into N. Per-tab binding via post-spawn jsonl-diff is the architectural shift; persist signature change from `Vec<cwd>` to `Vec<{cwd, uuid}>` is the load-bearing consequence. Not ADR-worthy on its own (it's a bug fix, not a new direction), but the "tabs own UUIDs, cwds don't" framing is worth remembering if anyone proposes a cwd-keyed shortcut later.
- (this session, no ADR) — **Drop the "scan cwd, persist every UUID found" behavior.** Previously persist would surface sessions that no tab had explicitly opened, which doubled as an implicit "discover orphan sessions" feature. Removing it means new on-disk sessions don't auto-appear as tabs on next launch — but `load_active_claude_sessions_for_bucket` is the explicit recovery path and stays unchanged, so the feature isn't lost, just opt-in.
- (2026-05-17, no ADR) — **Tier D D1 — auto-suspend idle Claude sessions, 20-min idle threshold, idle-time-only trigger model, silent auto-resume on terminal click/keystroke.** User explicitly chose predictability over aggressive savings (no window-hidden trigger) and silent UX over confirm dialogs. This is the feature whose bug we fixed today; the design itself stands.
