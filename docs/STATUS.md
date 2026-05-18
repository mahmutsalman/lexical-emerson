# Status — Lexical Emerson

**Last updated**: 2026-05-18 (session 7)
**Current phase**: v0.1 shipped + post-v0.1 feature work (keyboard UX layer, visual polish, session-restore robustness)
**Current slice**: Session-restore correctness — bucket "Load active Claude sessions" now respects close-time state

---

## Last Completed Task
Fixed "Load active Claude sessions" over-restore (close 3 of 7 tabs → relaunch → still 7) and the bucket context menu clipping near the sidebar bottom. Root cause turned out to be window-close persist not running at all (universal failure across all 8 projects in bucket 1, DB rows frozen at saved_at=11:00:57 across many quit/relaunch cycles). Solved by making the close handler redundant: per-event persist on every closeTerminal and on every post-spawn UUID bind. The snapshot now reflects live state instead of relying on the broken close handler. Verified by user end-to-end on the 15:17 build.

## Next Concrete Action
Either: (a) continue the keyboard UX backlog from earlier sessions (no specific item queued); (b) chase the window-close-persist mystery diagnostically — add file-based logging in `persist_project_terminals` to capture whether the command is even invoked under ⌘Q (now cosmetic since per-event saves cover the main path); or (c) RAM-optimization Tier A from `~/.claude/plans/image-4-can-you-check-reflective-snowflake.md`.

## Active Blockers
- none

## Open Questions
- Why does the window-close persist (`TerminalsView.tsx:789 onCloseRequested` → Rust) not run for ANY project window? DB inspection showed `persisted_terminals.saved_at` frozen across all 8 bucket-1 projects all day. Cosmetic now (per-event saves cover it) but a real defect — would need file-based eprintln since Finder-launched Tauri apps route stderr to `/dev/null`.
- `src/lib/arm-focus.ts` (`lastArmedBar` / `setLastArmedBar`) likely dead code since session 4's TerminalPane refactor — low-priority cleanup pass.
- New windows opened mid-session start at `panelsHidden=false` — acceptable per session 5.

## Recent Decisions (last 3)
- (2026-05-18, session 7) — Per-event persist via `queueMicrotask(persistNow)` from `closeTerminal` and the post-spawn UUID bind, making the snapshot self-healing and the window-close handler a redundant safety net rather than the load-bearing path.
- (2026-05-18, session 7) — `load_active_claude_sessions_for_bucket` now snapshot-first / FS-fallback. Preserves force-kill recovery (FS scan when DB is empty) but stops overwriting the legitimate close-time snapshot.
- (2026-05-18, session 7) — Context menu position uses ref-measured `getBoundingClientRect()` + flip-above-cursor when in the lower 55% of viewport (with `visibility: hidden` until measured). Lower-half trigger is load-bearing — actual menu height (~100 px) often "fits" below cursor by pure-overflow check while still being visually clipped.
