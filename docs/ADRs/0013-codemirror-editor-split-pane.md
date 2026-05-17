# ADR-0013 — CodeMirror 6 editor in a split pane

**Status:** Accepted — 2026-05-17

## Context

Up to this point, `CLAUDE.md` and `docs/plan.md` listed "No embedded code
editor (no Monaco, no CodeMirror)" as a load-bearing invariant. The whole
v0.1 thesis was *the terminal is the editor* — Claude Code does the typing,
Lexical Emerson is just the launcher / window manager. That invariant came
out of the RAM thesis (≤100 MB per window) and the desire to stay
deliberately distinct from VS Code.

User asked for a writable editor pane:

> I want my app to support showing the files and let me write my code as
> well. […] I should be able to double-click and open that file in a new
> window alongside with the terminals. And I should be able to type and save.

He mentioned Monaco specifically; we discussed cost (5 MB bundle, 50–100 MB
RAM per window, fights the lightweight thesis directly) vs CodeMirror 6
(200–400 KB tree-shaken, ~5–15 MB RAM, modular). He picked CodeMirror 6
and a split-pane layout inside the existing project window — *not* a new
top-level window — which preserves ADR-0004's one-project-one-window
invariant.

## Options considered

### Option A — Status quo (no editor)
- Keeps the original v0.1 thesis untouched.
- Forces the user out to `vim` / `nano` inside the terminal whenever they
  want to make a quick edit by hand without prompting Claude.
- Rejected: user explicitly asked for this; "claude is the editor" is true
  for big edits but underwhelming for renaming a variable or tweaking
  a YAML value.

### Option B — Monaco in a new window
- VS Code-grade editor, IntelliSense, multi-cursor, minimap.
- 50–100 MB extra per window. Bundle adds ~5 MB.
- Requires either bundled language servers (not happening) or accepts that
  90% of Monaco's value (LSP-driven completions) is unreachable.
- Rejected: directly contradicts the RAM thesis; pays Monaco's full tax
  for ~10% of its value because we have no LSP layer.

### Option C — CodeMirror 6 in a split pane (chosen)
- 5–15 MB RAM per window with the language packs we ship.
- ~200–400 KB JS once tree-shaken; we use `codemirror` meta + a handful
  of `@codemirror/lang-*` packs (js/ts, rust, markdown, json, css, html,
  python) + `@codemirror/theme-one-dark`.
- Lives inside the existing project window as a third workspace column.
  Collapses to width 0 when no file is open, so windows without active
  edits pay zero layout cost.

### Option D — Plain `<textarea>` + Shiki for static highlight
- Negligible RAM, no syntax-aware editing.
- Rejected for now: gives up too much (autocomplete, indent-on-input,
  bracket matching) for too little savings vs CodeMirror 6.

## Decision

**Option C — CodeMirror 6, embedded as a split pane inside the project
window.**

Layout: workspace grid becomes
`file-tree (240px) | editor (1fr) | terminal (1fr)` when at least one file
is open, and `file-tree (240px) | 0 | 1fr` (editor collapses) when none are.
Double-click a file in the tree → opens it as an editor tab. Tab strip
mirrors `TerminalsView`'s look (`•` marks dirty buffers). ⌘S saves the
active tab via a new `menu://file-save` event; backend writes through a
sibling-temp + rename for atomicity.

## Consequences

- `docs/plan.md` non-goals updated: "No embedded code editor" line removed.
  Plan's success-metric RAM budget remains the same — CodeMirror's cost
  is within slack (the M8 RAM-optimization backlog gives us margin).
- New Rust commands: `read_text_file`, `write_text_file`. Both registered
  in `main.rs`. 5 MB cap + NUL-byte binary heuristic on read.
- New components: `EditorPane.tsx` (single CodeMirror instance) and
  `EditorTabs.tsx` (container + tab strip). FileTree gets an `onOpenFile`
  prop.
- New menu item: File → Save (⌘S). Standard accelerator; safely no-ops
  when no editor tab is active.
- `CLAUDE.md` invariant ("No embedded code editor in v0.1") is removed.
  The lightweight thesis still holds — we just expanded what "lightweight"
  means to include a syntax-aware buffer.

## Revisit when

- Per-window RAM creeps past the 100 MB target with the editor open and
  one Claude session running. Mitigations available without reverting:
  drop language packs we never use; lazy-import `oneDark` only when a
  file opens; cap concurrent open editor tabs.
- User asks for LSP / IntelliSense. That's a separate, much bigger
  decision and would reopen the Monaco-vs-CodeMirror question.
- We add a desire for resizable split panes (currently fixed 1fr/1fr
  inside the workspace). Would need a draggable column divider.

## Notes on what was deliberately deferred

- **No unsaved-changes prompt on tab close.** The file is on disk; what's
  lost is at most the delta since last save. Worth promoting to a confirm
  dialog later if it bites in real use.
- **No file-watcher.** External edits aren't detected; reopening the file
  shows on-disk contents but a stale open tab won't auto-refresh. Adding
  one is straightforward (`notify` crate) when needed.
- **No language picker UI.** Highlighting is picked from the file
  extension only. Files without a known extension open as plain text.
- **No settings layer.** Theme, tab size (2), and line-wrapping are hard
  coded for v1, matching how every other Lexical setting started.
