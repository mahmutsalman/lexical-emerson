# ADR-0009 — Quill.js for the project notes editor

**Status:** Accepted — 2026-05-15

## Context

M6 adds a per-project notes feature: a Cmd+Shift+N modal containing a list of
rich-text notes per project, with image-paste-from-clipboard for capturing
screenshots alongside captions. The intended use is fast-recall reference
material — start/stop commands, design decisions, terminal incantations — that
doesn't belong in the committed repo README.

CLAUDE.md spells out a load-bearing invariant for v0.1:

> No embedded code editor in v0.1. The terminal is the editor. Adding
> Monaco/CodeMirror is the surest way to balloon to VS Code's RAM profile.

Shipping a rich-text editor inside Lexical Emerson looks, at first glance, like
a violation of that invariant. This ADR explains why it isn't, and pins the
constraint so future readers don't relitigate it.

## Decision

Use **Quill.js 2.x** (Snow theme) for the notes editor, lazy-loaded on first
modal open. Store content as Quill Delta JSON in SQLite.

## Why this doesn't violate the "no editor" invariant

The invariant in CLAUDE.md is aimed at *source-code editors*. The reason a
Monaco-equipped window weighs 250 MB+ is not "it lets you type text" — it's
the machinery a code editor needs to be useful:

- Tokenizer / syntax tree per language
- Language server protocol client + an LSP server process per project
- Inline diagnostics, hover providers, completion providers
- A web worker per language for syntax + format + lint
- Webpack-bundled language packs

Quill has none of that. It's a contenteditable wrapper with a toolbar:

- **Bundle:** ~45 KB gzipped (Quill core) + ~12 KB Snow CSS.
- **Runtime heap:** ~3–5 MB for a single instance (measured on similar
  embeddings). No worker, no AST, no LSP, no language servers.
- **Idle cost when modal closed:** zero (lazy-loaded on first Cmd+Shift+N).

The mental model: Quill is to a rich-text note what a date-picker is to a
form — a focused content-authoring widget, not an IDE component. Embedding it
keeps Lexical Emerson under the 100 MB/window target.

## Lazy-load detail

Quill is imported via dynamic `import('quill')` on the first modal open, and
its CSS via `import('quill/dist/quill.snow.css')`. Until a user actually opens
the notes modal — which most users won't do on every session — the Quill
bundle never enters the JS heap.

The Quill instance, once constructed, lives in a detached host element that
is adopted into / out of the modal slot on open/close. Subsequent opens are
instant. The Quill instance survives modal closes but dies with the window.

## Alternatives considered (rejected)

- **CodeMirror 6 / Monaco:** correct rejection — they're source-code editors,
  exactly what the invariant forbids. Wrong tool for prose.
- **Lexical (Facebook) or TipTap:** modern, more flexible — but heavier (~80 KB+
  baseline) and require React or a heavier integration. Quill's Solid
  integration is one line (`new Quill(div)`).
- **Plain Markdown + `marked` preview:** lighter (~10 KB), but Mahmut's VS Code
  Notes extension is explicitly Quill-styled, and he wants visible WYSIWYG
  bold/italic/lists/colour. A markdown editor is the right call for a code
  comment box; this is a richer notebook.
- **Contenteditable + a hand-rolled toolbar:** zero bundle cost, but inserting
  images cleanly, preserving formatting across copy/paste, and serializing
  to a stable format are exactly the problems Quill exists to solve. Hand-
  rolled would cost more time than the bundle saves.

## Consequences

- Notes content format is **Quill Delta JSON**, not Markdown or HTML. The DB
  is no longer trivially viewable in a text editor — but the JSON is
  human-readable enough for emergency debugging.
- Images are stored as files on disk under
  `~/Library/Application Support/lexical-emerson/projects/<id>/notes/<uuid>.<ext>`
  with a *relative* path embedded in the Delta. The custom asset protocol
  (`tauri.conf.json > app.security.assetProtocol`) serves them to the
  webview. **This required adding asset-protocol scope to tauri.conf.json.**
- A custom Quill `Image` blot subclass translates rel-paths to
  `convertFileSrc(...)` URLs at render time. The blot is registered once
  globally per webview and reads the current project id from a module-scoped
  variable (one project per window — this is safe; see ADR-0004).
- Orphan image cleanup is **deferred to v2**: deleting a note leaves its
  pasted image files on disk. Acceptable cost for v1.
- The "no editor" invariant in CLAUDE.md is amended in spirit: it forbids
  source-code editors specifically. A note editor is a separate category.

## Future-proofing

If Quill 2.x becomes unmaintained or the project outgrows Delta (e.g. wants
to export as Markdown, or share notes across a server), a Delta → Markdown
or Delta → HTML migration is a tractable script — Delta is JSON. The bigger
lift would be moving off Quill entirely; that would be a v2+ decision.
