# ADR-0007 — Bucket model: ordered ring with persisted cursor

**Status:** Accepted — 2026-05-15

## Context

Buckets are the project's reason to exist. The user juggles 20–100 projects per week but actively works on ~5; macOS Cmd-` cycles every Lexical Emerson window. He wants ONE keystroke to walk the curated subset.

The questions to settle:

1. **Cycle semantics** — what does ⌘⌥] do?
2. **Identity of the "current position" in the cycle** — where is it stored?
3. **One active bucket app-wide, or per-window?**
4. **Add/remove UX** — how does a project join or leave a bucket?

## Decisions

### 1. Cycle = focus-or-spawn through an ordered ring

A bucket is an ordered list of projects. `cycle_next` advances a cursor (wrap-around) and acts on the resulting project:

- If a window for that project is already open → focus it.
- Otherwise → spawn a new project window for it (re-uses `request_open_project` from M3).

If the bucket has 1 project, cycle = focus that project (still useful — it's a one-keystroke jump). If 0 projects, the hotkey is a no-op.

### 2. Cursor lives on the bucket row in SQLite

The cursor (an integer index into the bucket's project list) is persisted on the `buckets` table itself, not in a separate "session" store. This means cursor survives app restarts and feels like a remembered place. Cursor is updated transactionally with each cycle.

If a project is removed from the bucket and the cursor pointed past the end, it snaps back to a valid position (modulo arithmetic on every read).

### 3. One active bucket per app (not per window)

Cycling is global — pressing ⌘⌥] from any window advances the same cursor and brings the next bucket project to the foreground (focusing or spawning a window). Per-window active buckets would compete; the user's mental model is "I have ONE curated set this week."

The `active_bucket_id` is persisted in a key-value `app_meta` table so it survives quits. When nothing is set, the cycle hotkey is a no-op.

### 4. Add/remove UX — sidebar interactive list

The sidebar Buckets section becomes an interactive list:

- **+ New bucket** button creates a bucket via inline name input.
- Each bucket row:
  - Click name → sets it active (highlighted blue).
  - Expand chevron → reveals project list inside the bucket.
  - **+** icon → adds *current window's project* to this bucket (no-op if already in).
  - **×** on each expanded project row → removes from bucket.

A future v0.2 can add drag-and-drop or right-click context menus on Recent entries.

## Schema

```sql
CREATE TABLE IF NOT EXISTS buckets (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    cursor     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bucket_projects (
    bucket_id  INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    PRIMARY KEY (bucket_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_bucket_projects_order
    ON bucket_projects(bucket_id, position);

CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
```

`position` is a sparse integer; on add we use `MAX(position) + 1`. Removal doesn't compact (cursor wrap handles gaps via index-into-ordered-list semantics at read time).

`PRAGMA foreign_keys = ON` must be set on the rusqlite connection so the `ON DELETE CASCADE` clauses kick in.

## Hotkeys

- ⌘J — cycle next ("jump")
- ⌘⇧J — cycle previous

App-scoped (not OS-global) so we don't trigger the macOS Accessibility prompt. Bound via the native macOS menu's new "Bucket" submenu, which sits between Terminal and Window.

Hotkey iteration:
1. **⌘⌥] / ⌘⌥[** (original) — paired with the terminal-tab bracket family but heavy to type repeatedly.
2. **⌘I / ⌘⇧I** — rejected because ⌘I is reserved for italic in macOS rich-text contexts; user wanted a safer choice.
3. **⌘J / ⌘⇧J** (current) — ⌘J has no macOS system binding and reads as "Jump (to next bucket project)". Doesn't collide with ⌘⇧]/[ (terminal tab cycle), ⌘⇧B (new bucket), ⌘P (Quick Switcher), or ⌘T (new terminal).

## Consequences

- The bucket "cycle next" and "set active" must be atomic transactions in the DB so a hotkey spam can't race the cursor write.
- `bucket_projects` references `projects.id`; we rely on the existing `projects` table to never delete rows (it doesn't — projects are only added or upserted). If we ever add a "delete project" command, `ON DELETE CASCADE` quietly removes them from buckets.
- The active bucket key in `app_meta` is just `active_bucket_id` (a string-encoded integer). Reading and parsing is cheap.
- Cycling can spawn windows — reusing `request_open_project` means we get de-dup for free.

## Revisit when

- The single-active-bucket model proves limiting (e.g. the user wants two buckets in flight).
- The user wants automatic bucket population (e.g. "freshest 5 from Recent" as a derived bucket).
- ⌘⌥]/[ collides with something he wants to use in the focused terminal.
