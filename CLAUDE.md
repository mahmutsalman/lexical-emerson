# Lexical Emerson — Claude Code project context

> This file is read at session start by Claude Code. Keep it concise.

## What this project is

A **lightweight macOS folder + terminal launcher** for developers who use Claude Code as their primary editor. Not an IDE. No Monaco, no LSP, no language servers — those are the things that make VS Code 500 MB per window.

## Killer features (in priority order)

1. **Buckets** — user groups 3–5 active projects and cycles through them with `Cmd+Shift+]`. This is the differentiator vs VS Code's Cmd-` window cycling.
2. **PTY-backed terminal** per window — `claude` runs inside it.
3. **Smart-sorted recent projects** — sort by window focus + PTY-keystroke activity, not raw click recency.

## Stack (locked)

- Tauri v2 + Rust + `portable-pty` + `rusqlite` (WAL)
- Solid.js + TypeScript + xterm.js (NOT React; see ADR-0002)
- macOS-only for v0.1 (see ADR-0004, ADR-0001)

## Methodology

**Adaptive Project Execution is active for this project.** See `~/.claude/projects/-Users-mahmutsalman-.../memory/methodology-active.md`.

Working surfaces:
- `docs/plan.md` — vision + milestone slices (rolling-wave)
- `docs/tasks.md` — current slice only, regenerated at milestone boundaries
- `docs/STATUS.md` — cold-start orientation for `/where-am-i`
- `docs/ADRs/` — load-bearing decisions
- `docs/handoff/` — per-session handoffs from `/checkpoint`

Use `/checkpoint`, `/where-am-i`, `/replan-from-here` skills proactively.

## Critical architectural invariants

These are decided and should NOT be casually reconsidered:

- **One project = one native macOS window** (separate WKWebView). See ADR-0004.
- **PTY reader thread MUST be killed by closing the master fd from another thread.** `portable-pty`'s blocking `read()` doesn't observe signals. See `src-tauri/src/pty.rs` and ADR-0001's gotchas.
- **xterm.js WebGL renderer requires `allow-unsigned-executable-memory` entitlement.** Without this, terminal renders black on hardened runtime. See `src-tauri/entitlements.plist`.
- **SQLite WAL mode from day one.** Set `PRAGMA journal_mode=WAL` on connect. Zero cost now, prevents painful migration later. See ADR-0003.
- **No embedded code editor in v0.1.** The terminal is the editor. Adding Monaco/CodeMirror is the surest way to balloon to VS Code's RAM profile.

## Code style

- **Rust**: idiomatic; `Result<T, String>` for Tauri commands (Tauri requires `Serialize` on errors); minimize `unwrap()` in production paths; document any thread that owns a non-trivial resource.
- **Solid**: signals, `createSignal`, `createMemo`, `createResource`. Avoid React patterns (no `useEffect`-style deps thinking).
- **CSS**: vanilla. No Tailwind. Co-locate styles next to components if needed.
- **No comments that just restate the code.** Comments are for non-obvious *why* only — see Mahmut's global style note in `~/.claude/CLAUDE.md`.

## Verification routine before claiming a milestone done

- `cargo tauri dev` runs without warnings.
- Open a real project folder; `claude --version` works in the terminal.
- `ps -axm -o pid,rss,command | grep -i lexical` shows the per-window RAM target hit (see `docs/plan.md` success metrics).
- No leaked threads after window close (close one of N windows, observe Activity Monitor).

## References

- User's prior Tauri v2 work: `~/.claude/notes/obs-shortcut-controller-dev.md`
- User's macOS notarization recipe (for M5): `~/.claude/notes/macos-notarization-electron-python.md`
- Original planning doc: `~/.claude/plans/i-want-to-build-lexical-emerson.md`
