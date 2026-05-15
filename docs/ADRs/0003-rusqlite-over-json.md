# ADR-0003 — rusqlite (SQLite) over a JSON file

**Status:** Accepted — 2026-05-15

## Context

State to persist:
- `projects (id, path, name, last_focused_at, last_active_at)` — up to a few hundred over the app's lifetime.
- `buckets (id, name, cursor)` + `bucket_projects (bucket_id, project_id, position)` — a handful.
- Future v0.2: per-project shell, last-window-position, etc.

Two writers at minimum: any window's focus event AND any window's PTY-keystroke debounce. Three soon (project add/remove, bucket update). Concurrent writes from multiple windows running in the same Rust process.

## Options considered

- **JSON file at `~/Library/Application Support/lexical-emerson/state.json`.** Simple, debuggable in a text editor, no dependency cost.
- **rusqlite (bundled feature).** ~600 KB binary cost, atomic transactions, WAL mode for concurrency, indexed queries.
- **sqlx.** Async, query-checking at compile time. Heavier than rusqlite, more setup.

## Decision

**rusqlite with `bundled` feature and `PRAGMA journal_mode=WAL` from day one.**

Reasoning:
1. The moment two windows both want to update `last_focused_at` we get write-stomp races on JSON. Mutex + read-modify-write-fsync is fine until it isn't, and the failure mode (silent record loss) is the worst kind.
2. SQLite gives us atomic upserts and trivially recoverable storage. WAL means readers don't block writers.
3. Bundled feature avoids depending on the system SQLite; binary grows by ~600 KB, which is irrelevant compared to the Tauri shell.
4. rusqlite is synchronous — fits our small-write pattern. sqlx's async story is overkill.
5. Matches Mahmut's `better-sqlite3` muscle memory from his Electron projects.

## Consequences

- Schema migrations: numbered `.sql` files compiled in via `include_str!`. Runs on connect. Cheap to maintain at this scale.
- All windows in a single Tauri process share one `Connection` behind a `Mutex` — no contention even at 20 windows.
- We get an upgrade path: if Tauri ever splits processes (it doesn't currently), WAL means the multi-writer case still works without code changes.
- Direct human inspection harder than JSON but not by much (`sqlite3` CLI is on every Mac).

## Revisit when

- State grows beyond a few thousand records (it shouldn't — this is per-user, per-machine).
- We need full-text search over project paths (FTS5 is built into rusqlite-bundled, so this is more "use it" than "switch").
