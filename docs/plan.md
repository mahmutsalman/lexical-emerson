# Lexical Emerson — Project Plan

> Adaptive Project Execution. This is the **vision + slices** surface, not the daily TODO list.
> See `docs/tasks.md` for the current slice's working tasks (regenerated each cycle).

## Vision

A lightweight macOS folder + terminal launcher for developers who use Claude Code as their primary editor. Open a folder, see the tree, drop into a PTY-backed terminal, and **cycle through a curated bucket of 3–5 active projects with one keystroke**.

Not an IDE in the Monaco/LSP sense. The terminal is the editor (because Claude Code is the editor).

## Non-goals (v0.1)

- No embedded code editor (no Monaco, no CodeMirror).
- No LSP, no syntax intelligence beyond what the terminal renders.
- No git UI panel — use the terminal.
- No Windows/Linux builds — macOS-only for v0.1.
- No language servers of any kind. This is the whole point.

## Success metric

- Idle RAM ≤ 100 MB for one window; ≤ 400 MB for 5 windows.
- `claude` runs inside the terminal with no rendering glitches.
- Switching between 3 projects in a bucket takes one keystroke.
- A ~5× win over VS Code's 500 MB per window is the floor of acceptability.

## Phases / milestones (rolling-wave)

| # | Milestone | Exit criterion | Estimate |
|---|---|---|---|
| **M1** | Skeleton window with working terminal | `claude` works inside the PTY, file tree browseable | 2–3 days |
| **M2** | Persistence + recent projects + **multi-terminal tabs** | Recent list smart-sorted; multiple terminals per window via a tab strip; macOS menu has Terminal submenu with Cmd+T | 2–3 days |
| **M3** | Multi-window + Cmd+P switcher | "Open in new window" via Recent/Cmd+P, focused-window-only menu events, de-dup so at most one window per project | 2 days |
| **M4** | Buckets (the killer feature) | `Cmd+Shift+]` cycles bucket ring; persists cursor | 2–3 days |
| **M5** | Polish, sign, notarize, release | DMG installs on clean Mac, no Gatekeeper warning | 1–2 days |

Each milestone is **independently usable**. Stop after any one and still have a useful tool.

## Active slice

**Current: M3 — Multi-window + Cmd+P switcher.**

See `docs/tasks.md` for M3's working tasks.

M2 is complete (commit `02c0241`): rusqlite WAL store with smart-sort, Recent Projects sidebar, native macOS Terminal menu, per-project terminal tabs that survive project switches, auto-restore last project on launch.

M1 is complete (commit `3400063`): skeleton window + working PTY-backed terminal.

## Architectural decisions

See `docs/ADRs/` for the load-bearing choices:
- ADR-0001 — Tauri v2 over Electron
- ADR-0002 — Solid.js over React
- ADR-0003 — rusqlite (SQLite) over a JSON file for state
- ADR-0004 — Separate windows over a tabbed UI (project-level)
- ADR-0005 — Terminal tabs *within* a project window (terminal-level)
- ADR-0006 — Window-to-project identity and the navigate/mutate split

## Predicted gotchas (mitigations baked into M1)

1. **PTY reader thread leak.** `portable-pty`'s blocking `read()` doesn't observe a signal. We close the master fd from another thread to unblock, then `child.kill()`. See `src-tauri/src/pty.rs`.
2. **xterm.js WebGL renderer + hardened runtime.** Needs `com.apple.security.cs.allow-unsigned-executable-memory` entitlement. Otherwise terminal renders black. Mitigation baked into `src-tauri/entitlements.plist`.
3. **SQLite WAL from day one.** Multi-window already shares one Rust process, so we share one `Connection<Mutex>`. WAL gives us atomic writes and zero-cost upgrade path if Tauri ever splits processes.

## Out-of-scope follow-ups (v0.2+)

- Linux + Windows builds.
- Per-project shell override (currently uses `$SHELL`, falls back to `/bin/zsh`).
- "Last modified mtime" sort as an additional signal (currently smart-sort uses focus + PTY-stdin only).
- Dotfile visibility toggle (`Cmd+.`).
- Split-pane terminals (two terminals side by side in one project window — different from M2's stacked tabs).

## References

- User notes — Tauri v2 mechanics: `~/.claude/notes/obs-shortcut-controller-dev.md`
- User notes — macOS notarization pipeline: `~/.claude/notes/macos-notarization-electron-python.md`
- Planning document — `~/.claude/plans/i-want-to-build-lexical-emerson.md`
