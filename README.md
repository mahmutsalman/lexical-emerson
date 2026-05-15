# Lexical Emerson

A lightweight macOS folder + terminal launcher for developers who use Claude Code as their primary editor.

**Not an IDE.** No Monaco, no LSP, no language servers. Just a folder, a file tree, and a real PTY-backed terminal — plus the one feature you've been missing: **cycle through a curated bucket of 3–5 active projects with one keystroke.**

## Why

VS Code costs ~500 MB of RAM per window. If you juggle 20 projects a week, that's a 10 GB ceiling before language servers. Lexical Emerson targets ~70–80 MB per window — a **~5–10× win** — by deliberately not being an editor. Your editor is `claude` running inside the terminal.

## Status

**v0.1 in development.** macOS only.

See [`docs/plan.md`](docs/plan.md) for the milestone-sliced roadmap.

## Features

### v0.1 (in progress)

- **File tree** per project window — lazy, fast, no FS watcher overhead.
- **PTY-backed terminal** in every window — `claude`, `vim`, `htop`, anything runs the way you'd expect.
- **Recent projects** sidebar — last 20, smart-sorted by where you've actually been working (window focus + keystroke activity), not where you most recently clicked.
- **Cmd+P switcher** — fuzzy-search any known project, jump in one keystroke.
- **Buckets** — group your 3–5 active projects, cycle through them with `Cmd+Shift+]` regardless of how many other windows are open. The killer feature.

### v0.2+ (planned)

- Cross-platform (Linux, Windows).
- Per-project shell override.
- "Last modified" sort signal in addition to "last worked in".

## Tech

- [Tauri v2](https://v2.tauri.app) + Rust backend
- [Solid.js](https://solidjs.com) frontend (no React)
- [xterm.js](https://xtermjs.org) terminal renderer
- [`portable-pty`](https://docs.rs/portable-pty) Rust PTY crate
- [rusqlite](https://docs.rs/rusqlite) state store, WAL mode

See [`docs/ADRs/`](docs/ADRs/) for why each was chosen.

## Build from source

Requires Node ≥ 20, Rust ≥ 1.80, and the Tauri CLI prereqs (Xcode CLT on macOS).

```bash
npm install
npm run tauri dev
```

For a release build:

```bash
npm run tauri build
```

The notarized `.dmg` lands in `src-tauri/target/release/bundle/dmg/`.

## RAM expectations (target)

| Scenario | Target idle RAM |
|---|---|
| 1 window | ≤ 100 MB |
| 5 windows (typical active workload) | ≤ 400 MB |
| 20 windows | ≤ 1.5 GB |

For comparison: VS Code with 5 projects = ~2.5 GB before language servers.

## License

[MIT](LICENSE)
