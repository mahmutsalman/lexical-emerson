# Status — Lexical Emerson

**Last updated**: 2026-05-17 00:43
**Current phase**: v0.1 shipped + post-v0.1 feature work (M6 notes, M7 workspace, M7.5 session restore)
**Current slice**: M7.5 — per-bucket Claude session restore (hardening round)

---

## Last Completed Task
Hardened the per-bucket Claude session restore feature originally shipped untested in 24f2300. Six concrete fixes in commit e042f48: (a) 1.5s timeout race around `persistProjectTerminals` so `win.destroy()` always runs even if Rust hangs; (b) `RunEvent::ExitRequested` handler that closes BOTH `main` and `project-*` windows on ⌘Q (previously only project-* — main's persist was silently dropped because main usually hosts `lastProject`); (c) `⌘⇧W` Close Window accelerator since `⌘W` is owned by Close Terminal; (d) session-mtime cutoff bumped 6h → 48h so overnight sessions aren't filtered out; (e) `eprintln` diagnostics on persist for Console.app visibility; (f) per-bucket right-click "Load active Claude sessions" action (new Rust command `load_active_claude_sessions_for_bucket`) that spawns project windows for projects in that bucket with persisted rows — replaces the launch-time auto-spawn that was creating window-storms. Also removed `lastProject` auto-load on main mount: launcher now starts empty, user drives restore manually per bucket.

## Next Concrete Action
User to safely rebuild (`cargo tauri build` + `rm -rf`/`ditto` install — never killall, this Claude Code session is hosted inside the old running app) and run the full end-to-end test: (1) open 2-3 projects in "first bucket" with Claude running, (2) ⌘Q the whole app, (3) verify `persisted_terminals` has rows for every closed window via `sqlite3 ~/Library/Application\ Support/com.mahmutsalman.lexical-emerson/state.db 'SELECT * FROM persisted_terminals;'`, (4) relaunch — launcher should open empty, (5) right-click "first bucket" → "Load active Claude sessions" → all persisted project windows should auto-spawn with `claude --resume <uuid>` injected per tab.

## Active Blockers
- none

## Open Questions
- "Loads twice then stops" — user observed during bucket-bar ◄► navigation in the previous build; could not reproduce from code, suspected to be a race between `lastProject` auto-load and persisted-windows auto-spawn (both removed in this commit). Needs verification after next test.
- Multi-tab-per-cwd correctness: `detect_claude_session` claims unique `.jsonl` UUIDs from `claimed: HashSet`, so 3 tabs in the same cwd → newest, 2nd-newest, 3rd-newest. Tab→session mapping is mtime-ordered, not identity-tracked. Acceptable heuristic but may surprise users with many concurrent sessions in one cwd.
- Persist runs only on `onCloseRequested` (per window) and via the new `ExitRequested` orchestration (whole app). No incremental save during a long-running session — a crash mid-session loses everything since the last close.

## Recent Decisions (last 3)
- (this session, no ADR) — Per-bucket user-driven restore over launch-time auto-restore: avoids window-storm when multiple buckets had persisted sessions, gives user explicit control over which bucket to revive
- ADR-0011 — Pointer-event DnD (solid-dnd) inside CSS-3D ancestors; native HTML5 DnD is off-limits in this codebase
- ADR-0010 — Bucket Workspace + Tauri v2 ACL window-scoping gotcha (load-bearing: future window labels must update capabilities)
