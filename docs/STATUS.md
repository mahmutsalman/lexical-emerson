# Status — Lexical Emerson

**Last updated**: 2026-05-16 20:55
**Current phase**: v0.1 shipped + post-v0.1 feature work (M6 notes, M7 workspace)
**Current slice**: M7 polish — drag-reorder + active-row accent + Edit-button fix

---

## Last Completed Task
Three M7 polish items shipped in commit 6425743: (a) drag-to-reorder of 2D-tabstrip rows, backed by a new Rust IPC `reorder_bucket_projects` + the existing `buckets://changed` broadcast for cross-window sync; (b) per-project accent on the active row (5px solid bar, tinted background, brighter name; uncolored projects fall back to brand blue); (c) the 3D notes-face Edit button now actually opens NotesModal — it was emitting the wrong event (`menu-event`/`notes-open` global) instead of `menu://notes-open` on the current webview window. Drag-drop swapped from native HTML5 DnD (which WebKit refuses to dispatch `drop` for when a CSS-3D ancestor interferes with hit-testing) to `@thisbeyond/solid-dnd` v0.7.5, the Solid port of the dnd-kit family that NotesWithAudioAndVideo already uses on the React side.

## Next Concrete Action
M7 has no remaining known polish items. User has approved each fix as it shipped. Three plausible directions: (1) **v0.2 candidates** — notarization + GitHub Release with prebuilt DMG (ADR-0008 deferred), or Linux/Windows builds, or per-project shell override; (2) **demo GIF for the README** so the bucket workspace is visible to people who land on the repo; (3) **session persistence** for workspace-owned PTYs (currently die with the process). Ask the user which to pick up first when they return.

## Active Blockers
- none

## Open Questions
- Should workspace-owned terminals survive *app quit*, or die with the process like every other PTY? Currently die. No persistence layer for live PTY state.
- Notarization timing — still deferred per ADR-0008.
- v0.2 scope: ship-as-is and gather feedback, or fold in Linux/Windows + per-project shell first?

## Recent Decisions (last 3)
- ADR-0010 — Bucket Workspace + Tauri v2 ACL window-scoping gotcha (load-bearing: future window labels must update capabilities)
- ADR-0009 — Quill.js for the project notes editor (M6)
- ADR-0008 — Release process for v0.1 (ad-hoc-signed, no notarization)
