# Status — Lexical Emerson

**Last updated**: 2026-05-17 11:35
**Current phase**: v0.1 shipped + post-v0.1 feature work (M6 notes, M7 workspace, M7.5 session restore)
**Current slice**: M7 polish round 4 — 3D bucket workspace usability (focus model, notes opening, WebGL recovery)

---

## Last Completed Task
Window-level Esc-to-close for `NotesModal` (commit `615ae87`). Bundled into the prior commit `7ea36ad` — 3D bucket workspace usability overhaul: single-click `.pnr-item` opens the editor on that specific note (button + window-CustomEvent hint), wheel scroll on facing terminal, always-visible active-project chip (top-left, fades on header hover, reactive via createMemo), toggleable event-capture overlay (⌘⌥D), Enter-to-focus model with blur-on-navigate (⌘⌥ rotation no longer steals or leaks focus; Enter steps in, Esc steps out), WebGL→Canvas fallback in `TerminalPane` on context loss, and `emitMenuEventLocal` using the explicit `{kind:"WebviewWindow", label}` target so cross-window broadcasts stop. Verified end-to-end by the user.

## Next Concrete Action
Fix the notes-panel button clicks in the bucket-workspace 3D view. Symptom: clicking `.pnr-item` tiles and the "Edit" button inside the 3D-rotated notes pane still does nothing, even though pointer-events are `auto` end-to-end and the `<button>` element should be hit-testable. User explicitly deferred to this slice. The ⌘⌥D debug overlay is already wired — first step is to open it in the failing state, click a tile, and read which events (or lack thereof) reach the workspace, before assuming a fix.

## Active Blockers
- none

## Open Questions
- Why do `.pnr-item` button clicks in the bucket-workspace 3D notes pane fail despite pointer-events chain being `auto` end-to-end? Likely a CSS-3D hit-test quirk (cousin of ADR-0011) but unconfirmed. Use ⌘⌥D overlay to gather event-capture data before guessing.
- WebGL canvas fallback: needs in-production stress-test (3+ per-project windows + bucket workspace open simultaneously) to confirm the lost terminals re-render. Verified type/build path only.
- Per-project `TerminalsView` still uses its original auto-focus pattern on `⌘⌥→`. Intentionally untouched this slice but mention if the user wants the Enter-to-focus model extended there for consistency.

## Recent Decisions (last 3)
- (this session, no ADR) — Enter-to-focus over auto-focus in 3D bucket workspace: navigation rotates only; Enter explicitly takes focus; Esc returns it. Decouples cylinder rotation from xterm focus so clicks don't race and Enter doesn't leak into prior terminal.
- (this session, no ADR) — Window-scoped menu emits via explicit `{kind:"WebviewWindow", label}` target. String-label form silently mismatches `webview.listen()`'s WebviewWindow filter. Captured in feedback memory `feedback_tauri_event_target_kinds.md`.
- ADR-0011 — Pointer-event DnD (solid-dnd) inside CSS-3D ancestors; native HTML5 DnD is off-limits.
