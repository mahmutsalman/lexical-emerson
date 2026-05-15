# Status — Lexical Emerson

**Last updated:** 2026-05-15

## Current slice

**M1 — Skeleton window with working terminal.**

## Where we are

Day 1 scaffold complete. Methodology + docs + Tauri v2 + Solid + TS skeleton + M1 code all written. **`npx tsc --noEmit` and `cargo check` both pass cleanly with zero warnings.** Frontend build emits a 414 KB JS bundle (107 KB gzipped). Icons generated via `npx tauri icon` from a placeholder source PNG.

The skeleton is structurally complete. The next milestone-defining act is launching `cargo tauri dev`, picking a folder, and confirming `claude` runs inside the terminal.

## Next concrete step

1. `cargo tauri dev` — launches Vite + the Tauri window. First run will compile all dependencies (~3–5 min).
2. Click "Open folder…" in the sidebar, pick any real project folder.
3. Confirm: file tree populates with first-level entries, expanding a directory shows its children.
4. Confirm: terminal pane shows a prompt at the picked folder's cwd. Run `claude --version`. Type, edit-line, Ctrl+C, hit return — everything should behave like Terminal.app.
5. If all green: M1 is done. Run `/checkpoint` to record real completion (this STATUS only covers the scaffold day).
6. If anything is wrong: fix, re-run, iterate.

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
