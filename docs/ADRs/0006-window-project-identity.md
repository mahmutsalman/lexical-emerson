# ADR-0006 — Window-to-project identity and the navigate/mutate split

**Status:** Accepted — 2026-05-15

## Context

ADR-0004 said one project = one macOS window (separate WKWebView per project, no project-tabs). M3 implements that. Two design questions fall out:

1. **How does a window know which project it represents?**
2. **What happens when the user clicks a project in Recent or Cmd+P from an existing project window?** Does it mutate the current window's project, or open a new one?

## Decisions

### 1. Window identity via window label

Tauri assigns each window a string label, unique per app. We use this as the project identifier:

- `main` — the launcher window, opens on app start, can adopt any project (via "Switch folder")
- `project-<id>` — a window pinned to project with rusqlite id `<id>`

The frontend reads `getCurrentWindow().label` on mount:

- `"main"` → use `lastProject()` to restore (M2 behavior preserved)
- `"project-N"` → call `getProjectById(N)` to pin

Why label and not URL query parameters: window labels are guaranteed unique by Tauri, persist across reloads, and don't require URL parsing/encoding gymnastics. The trade-off — labels can't be changed after creation — is a feature: a project window is locked to one project.

### 2. Two distinct user intents: mutate vs navigate

| Intent | UI | Behavior |
|---|---|---|
| **Mutate this window** | "Switch folder…" button in sidebar | Picks a folder, replaces current window's project in-place. M2 semantics preserved. |
| **Navigate to another project** | Click in Recent list, or Cmd+P | Opens that project in a separate window. If a window for that project already exists, focuses it. |

This split matches user intuition: the big primary button at the top of the sidebar feels like "do something to *this* place", whereas Recent/Cmd+P feel like "go elsewhere".

### 3. De-dup: at most one window per project

`request_open_project(path)` is the single Tauri command that resolves a path to either:

- Focusing an existing `project-<id>` window if one is open, or
- Spawning a new `project-<id>` window otherwise.

Preventing two windows for the same project keeps the Cmd+P UX predictable (Enter always lands you somewhere you can immediately use) and avoids confusion about "which window is the real one."

### 4. Menu events route only to the focused window

The M2 implementation emitted `menu://terminal-*` via `app.emit(...)` which broadcasts to all windows. With multiple windows open this would, for example, open a new terminal in *every* window when the user pressed ⌘T. M3 changes this: `on_menu_event` finds the focused window via `window.is_focused()` and emits only there.

## Consequences

- The "main" window remains useful as a launcher even after the user has 5 project windows open. Closing all project windows leaves main alive.
- `request_open_project` becomes the canonical "go somewhere" command — used by Recent click, Cmd+P Enter, and (future) Bucket cycle in M4.
- New backend command `get_project_by_id` reads back a single Project from the rusqlite store — needed by project windows on mount.
- `mark_focused` on window focus is wired now so smart-sort updates as the user alt-tabs between project windows (not just on initial open).

## Revisit when

- The "main" launcher window feels redundant — if real-world use shows users immediately open a project and never return to main, we could auto-hide main once a project window opens.
- We need to support multiple instances of the same project (e.g. user wants two views of the same folder for diff comparison) — would need to drop the de-dup constraint.
