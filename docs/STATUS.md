# Status — Lexical Emerson

**Last updated:** 2026-05-15

## Current slice

**M3 — Multi-window + Cmd+P switcher (structurally complete, awaiting smoke test).**

## Where we are

**M3 structural cut**:
- Window-label identity: `main` (launcher) vs `project-<id>` (pinned). Frontend reads it via the `current_window_label` IPC.
- Native macOS menu has a new **Go** submenu with **Quick Switcher** (⌘P).
- Menu events route only to the *focused* window — ⌘T no longer fires in every open window.
- New backend commands: `request_open_project` (spawn-or-focus), `get_project_by_id`, `mark_focused`, `current_window_label`.
- `QuickSwitcher` modal: fzf-style scoring with basename + start-of-word bonuses; ↑↓ navigate, Enter open, Esc close, click-outside close.
- App.tsx branches on window label — main has Switch folder, project-N is pinned (no Switch folder, sidebar shows "pinned to this window").
- Recent click + Cmd+P → `requestOpenProject` (new window or focus existing).
- Window-focus listener bumps `last_focused_at` and refreshes Recent.
- ADR-0006 documents the navigate-vs-mutate split.

**M2 shipped** (commit `02c0241`):
- rusqlite WAL store + `Project` schema, smart-sort `MAX(last_active, last_focused - 1h)`.
- Native macOS Terminal menu — New/Close/Next/Prev terminal with ⌘T, ⌘W, ⌘⇧], ⌘⇧[.
- `TerminalsView` with per-project tab persistence — switching projects keeps their terminals alive (xterm + PTY both survive); coming back restores the original active tab.
- `RecentProjects` sidebar, smart-sorted, with active highlight.
- Auto-restore last project on launch.

**M1 shipped** (commit `3400063`): window, file tree, single PTY-backed terminal, Switch folder works.

## Next concrete step (smoke test M3)

1. **⌘P** from the main window: opens the QuickSwitcher. Type to filter; Enter on a project opens a new project-N window (or focuses an existing one).
2. **Recent click** in the sidebar: opens the project in a new window now (not mutates current). Switch folder in main still mutates main.
3. **⌘T in a project-N window**: opens a tab only in that window. Other windows' tab counts don't change.
4. **Close a project window**: `ps -axm | grep zsh` drops by the number of terminals that window had open. The other windows survive.
5. **Focus another project window**: its row bubbles to the top of Recent in every visible sidebar.

If all five hit, commit M3 and move to M4 (buckets — the killer feature).

## Recent decisions (last 3)

- 2026-05-15 — Tauri v2 + Solid + xterm.js + portable-pty stack locked (see ADR-0001, ADR-0002).
- 2026-05-15 — macOS-only for v0.1; cross-platform deferred.
- 2026-05-15 — No embedded code editor; the terminal is the editor.

## Open questions

- Should the file tree default to hiding dotfiles (VS Code's behavior) or showing them? Lean: hide, with `Cmd+.` toggle in v0.2.
- Disambiguation rule for projects sharing a basename (e.g. two `MyApp/`) — to be decided before M3's Cmd+P switcher lands.

## Blockers

None.

## Methodology status

- `methodology-active.md` flag: **set**.
- `/checkpoint`, `/where-am-i`, `/replan-from-here` skills are active for this project.
