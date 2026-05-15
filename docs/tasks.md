# Tasks — Current Slice (M2)

> Regenerated each milestone from `plan.md` + recent ADRs. Do not edit by hand long-term — rewrite at slice boundaries.

## Slice: M2 — Persistence + recent projects + multi-terminal tabs

**Exit criteria** (all must hit):

1. Reopen Lexical Emerson after quit → last project's path restores.
2. Recent Projects sidebar shows up to 20 entries, sorted by smart-sort (`max(last_active_at, last_focused_at - 1h)`), clickable.
3. Native macOS menu bar has a "Terminal" entry with "New Terminal" (Cmd+T), "Close Terminal" (Cmd+W), "Next/Prev Terminal" (Cmd+Shift+]/[).
4. Inside the terminal panel: tab strip on top showing all open terminals, click to switch, x to close, + to add.
5. Each terminal's scrollback survives switching tabs (xterm instance stays alive).

### Tasks

- [x] Update `plan.md` + write `ADR-0005-terminal-tabs-within-project-window.md`
- [ ] Backend: add `rusqlite` (bundled, WAL) to `Cargo.toml`
- [ ] Backend: `src-tauri/src/store.rs` — schema, migrations, queries
- [ ] Backend: `src-tauri/src/projects.rs` — `Project` struct, store integration
- [ ] Backend: Tauri commands `list_recents`, `mark_focused`, `mark_active`, `register_project`
- [ ] Backend: native macOS menu in `main.rs` (`tauri::menu::Menu`) + `on_menu_event` forwarder
- [ ] Frontend: `RecentProjects.tsx` — renders sidebar list, polls or invalidates on switch
- [ ] Frontend: `TerminalsView.tsx` — tab strip + N TerminalPane instances + display:none for inactive
- [ ] Frontend: extract TerminalPane to accept `terminalId` + `cwd` props; lifecycle keyed by id
- [ ] Frontend: listen for `menu://new-terminal`, `menu://close-terminal`, `menu://cycle-terminal`
- [ ] Frontend: 30s-debounced `mark_active` call from TerminalPane on `onData` activity
- [ ] Verify: `cargo check` clean, `tsc --noEmit` clean
- [ ] Manual test: hit all 5 exit criteria from a fresh quit

### Definition of done

All 5 exit criteria hit, dev test passes, no warnings in console. After this lands, commit "M2 — persistence + recent + multi-terminal tabs" and update `docs/STATUS.md`.

### After M2: what comes next

M3 — multi-window + Cmd+P switcher. Pre-decision: the SQLite schema in M2 already supports multiple open windows (one window = one project, but `last_focused_at` is per-project not per-window — fine). M3 adds `WindowId → ProjectId` mapping in Rust AppState and the Cmd+P fuzzy modal in Solid.
