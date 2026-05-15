# Tasks — Current Slice (M1)

> Regenerated each milestone from `plan.md` + recent ADRs. Do not edit by hand long-term — rewrite at slice boundaries.

## Slice: M1 — Skeleton window with working terminal

**Exit criterion**: `claude` runs inside the PTY-backed terminal, file tree browses the picked folder.

### Tasks

- [x] Scaffold methodology + docs (this file)
- [x] Write 4 ADRs (Tauri v2, Solid, rusqlite, multi-window)
- [x] Create repo basics: LICENSE, .gitignore, README, CLAUDE.md
- [x] Write Tauri v2 + Solid + TS skeleton (package.json, vite.config, tsconfig, index.html, tauri.conf.json, Cargo.toml)
- [x] Write `src-tauri/entitlements.plist` with `allow-unsigned-executable-memory`
- [x] Implement PTY backend (`src-tauri/src/pty.rs`)
- [x] Implement file-tree + projects commands (`src-tauri/src/commands.rs`, `projects.rs`)
- [x] Implement Solid frontend (`App.tsx`, `FileTree.tsx`, `TerminalPane.tsx`, `ipc.ts`)
- [x] `npm install` (78 packages clean), `npx tsc --noEmit` clean, `cargo check` clean
- [x] Generate placeholder icons via `npx tauri icon`
- [x] `npm run build` produces dist/ successfully
- [ ] `cargo tauri dev` — launch the actual window (first-time compile ~3–5 min)
- [ ] Smoke test: pick a folder, expand a directory in the tree, run `claude --version` in the terminal
- [ ] First `/checkpoint` to capture M1 completion handoff

### Definition of done

- A single Tauri window opens.
- Native folder picker works.
- File tree shows the picked folder's first-level contents with expandable directories.
- Terminal renders `$SHELL` (zsh on Mahmut's machine) with a working prompt.
- Resize the window → terminal reflows correctly.
- Ctrl+C in the terminal kills the running command but keeps the shell.
- Close the window → no leaked Rust threads (`ps` after close shows clean state).

### After M1: what comes next

M2 — rusqlite store + recent projects sidebar. Pre-decision: schema lives in `src-tauri/src/store.rs` with `PRAGMA journal_mode=WAL` from day one.
