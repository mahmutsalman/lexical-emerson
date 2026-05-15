# ADR-0005 — Terminal tabs within a project window

**Status:** Accepted — 2026-05-15 (revision of M1's single-terminal assumption)

## Context

ADR-0004 said *projects* get separate windows (not tabs). That's still true. But within one project, a user often wants two or three terminals running concurrently — one for `claude`, one for `git`, one for a long-running build. M1 shipped with exactly one terminal per window; the user (after seeing M1 work) requested:

1. A native macOS menu bar entry "Terminal" with "New Terminal" (Cmd+T).
2. A visual stack of active terminals he can switch between.

So inside a single project window we now need N terminals.

## Options considered

### Option A — Stacked tabs (one visible at a time)
- Tab strip at top of terminal panel.
- All terminals' xterm instances exist in the DOM but inactive ones get `display:none`.
- xterm.js handles invisibility fine — its rendering pauses when its host element is hidden.
- Click a tab to switch; "+" button to add; "x" on each tab to close.

### Option B — Split panes (multiple terminals visible simultaneously)
- Divide the terminal panel horizontally or vertically.
- Each pane has its own xterm.
- Cmd+D = split right; Cmd+Shift+D = split down (iTerm-style).

### Option C — One terminal per window, "New Terminal" opens a new project window
- Reuses ADR-0004's window-per-project model.
- But: terminals would be project-less or share the project, neither feels right.

## Decision

**Option A — Stacked tabs.**

Reasoning:
1. **The user said "stacked place where I can see my active terminals"** — explicit signal for tabs over splits.
2. **Splits compete for screen real estate.** Terminals already share a window with the file tree; a vertical or horizontal split shrinks each terminal below comfortable width/height. Tabs preserve full-size terminals.
3. **Tab management is universally understood** (browser tabs, VS Code, iTerm). No learning curve.
4. **The xterm.js + `display:none` trick is well-known**, performant, and preserves scrollback when switching back.
5. **Split-panes can ship later as a v0.2+ feature** without contradicting this choice — splits live *inside* a tab.

## Consequences

- TerminalsView component manages an array of `{ id, cwd }` records and a single `activeId`. It mounts N TerminalPane instances, each with `display: block` (active) or `display: none` (inactive). xterm instances stay alive.
- Memory cost: each xterm instance is ~8–15 MB. Three concurrent terminals = ~30–45 MB extra. Acceptable.
- New PTY sessions are tracked by the same `PtyManager` we already built — N sessions per window is what it was designed for. Zero backend change.
- The native macOS menu adds a "Terminal" submenu between "Edit" and "View" with:
  - **New Terminal** — `Cmd+T`
  - **Close Terminal** — `Cmd+W` (closes only the current terminal tab; window stays open unless it was the last)
  - **Next Terminal** — `Cmd+Shift+]`
  - **Previous Terminal** — `Cmd+Shift+[`
  - **Go to Terminal 1..9** — `Cmd+1..9`
- Menu items are wired via `tauri::menu::Menu` + `on_menu_event` → emit to frontend.
- Default cwd for a new terminal: same as the project root. Per-tab cwd override deferred to v0.2.

## Consequences for ADR-0004

No conflict. ADR-0004 is about *project-level* window vs tab decision (separate windows win). ADR-0005 is about *terminal-level* tab vs split within one project window (tabs win). Two different layers.

## Revisit when

- A user requests split-panes alongside or instead of tabs.
- Memory per active terminal materially grows beyond the ~10 MB envelope.
- We add a "drag terminal out to its own window" gesture (tear-off).
