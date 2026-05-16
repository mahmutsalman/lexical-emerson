# Status — Lexical Emerson

**Last updated**: 2026-05-16 20:06
**Current phase**: v0.1 shipped + post-v0.1 feature work (M6 notes, M7 workspace)
**Current slice**: M7 polish — per-project notes face + 3D ring geometry fixes

---

## Last Completed Task
Per-project notes face is now a first-class peer of terminals in the 3D cylinder, in both the per-project TerminalsView and every ring of the Bucket Workspace. ⌘⌥←/→ in the Bucket Workspace cycles [notes, t0, t1, …] instead of skipping the notes slot; projects with zero terminals default to notes-as-active so the face is always reachable. Shared Quill setup extracted into `src/lib/notes-quill.ts` so modal and read-only rail share rendering. Also fixed the bw-rings transform: was `translateY ∘ rotateX`, which left the active ring at non-zero z when tilted, pulling lower rings toward the camera and visually enlarging them via perspective. Swapped to `rotateX ∘ translateY` — active ring is now pinned to z=0 regardless of stack depth. Commit 68de62d.

## Next Concrete Action
Wire the "Edit" button on the 3D workspace notes face so it opens NotesModal for the ring's project. Today it visibly does nothing when clicked. Probable causes (in priority order): (a) `menu-event "notes-open"` is not routed to the BucketWorkspace window's NotesModal — it may only be listened to by App.tsx in per-project windows; (b) ProjectNotesPanel's `onOpenEditor` emit is firing but the modal's listener is scoped wrong; (c) pointer-events on the 3D pane swallow the click before the button receives it (less likely — same issue would block scroll/keyboard, and those work). First check: open devtools in the workspace window, click Edit, confirm whether the menu-event fires.

## Active Blockers
- none

## Open Questions
- Should workspace-owned terminals survive *app quit*, or die with the process like every other PTY? Currently die. No persistence layer for live PTY state.
- Notarization timing — still deferred per ADR-0008.
- Once Edit-button bug is fixed, anything else before moving to v0.2 candidates?

## Recent Decisions (last 3)
- ADR-0010 — Bucket Workspace + Tauri v2 ACL window-scoping gotcha (load-bearing: future window labels must update capabilities)
- ADR-0009 — Quill.js for the project notes editor (M6)
- ADR-0008 — Release process for v0.1 (ad-hoc-signed, no notarization)
