# Status — Lexical Emerson

**Last updated:** 2026-05-15

## Current slice

**M2 — Persistence + recent projects + multi-terminal tabs.**

## Where we are

M1 shipped: window, file tree, single terminal, `<Show keyed>` fix for switching projects, first commit `3400063`.

M2 structurally complete: rusqlite WAL store, `Project` schema with `last_focused_at` / `last_active_at`, smart-sort query (`MAX(last_active, last_focused - 1h)`), Tauri commands (`open_project`, `list_recents`, `mark_active`, `last_project`), native macOS menu with `Terminal` submenu (`Cmd+T` New, `Cmd+W` Close, `Cmd+Shift+]/[` cycle), `TerminalsView` component with tab strip + N TerminalPane instances + `display:none` for inactive tabs, `RecentProjects` sidebar component, App.tsx auto-restores `lastProject()` on launch and refreshes recents on every switch.

`cargo check` and `npx tsc --noEmit` both clean. The running dev server already rebuilt the binary.

## Next concrete step (user-facing)

Smoke-test the M2 exit criteria in the running app window:

1. **Native menu**: top of screen should show **Lexical Emerson | File | Edit | View | Terminal | Window** — verify Terminal menu has New Terminal (⌘T), Close Terminal (⌘W), Next/Previous Terminal (⌘⇧]/[).
2. **Multi-terminal tabs**: pick a folder, then ⌘T a few times — terminal panel grows tabs. Click each to switch; scrollback survives. `+` button adds a tab; `×` on a tab closes it (last one auto-keeps one open).
3. **Recent projects**: switch between 2–3 folders. The Recent section in the sidebar should populate, sorted by smart-sort. The active project is highlighted blue.
4. **Persistence**: ⌘Q the app. Relaunch (`cargo tauri dev` or just open the running window again). The last project should auto-restore.

If all four hit: M2 done. Commit and move to M3 (multi-window + Cmd+P switcher).

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
