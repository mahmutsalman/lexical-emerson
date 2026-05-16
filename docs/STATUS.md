# Status — Lexical Emerson

**Last updated**: 2026-05-16 13:50
**Current phase**: v0.1 shipped + post-v0.1 feature work (M6 notes, M7 workspace)
**Current slice**: M7 — Bucket Workspace — shipped today, awaiting polish

---

## Last Completed Task
M7 — Bucket Workspace (cross-project terminal aggregator). Right-click a bucket → "Open in 3D Workspace" spawns a `bucket-3d-<id>` window that aggregates every live terminal across every project in the bucket. 2D grouped tab strip is the default; ⌘⌥3 (or "Enter 3D" header button) toggles a stacked-arcs 3D view. `+` per project row spawns an owned terminal in that project (kept alive when the workspace closes). Header debug toggle + production devtools left in place for future diagnostics. Tauri v2 ACL gotcha surfaced and fixed (ADR-0010): every new window label family must be in `capabilities/default.json::windows` or `listen()` silently rejects.

## Next Concrete Action
Optional polish for M7, per user's "we can update some style" comment:
- 3D ring transitions feel snappy enough but the dim non-active rings + box-shadow border can read as cluttered; consider tightening or hiding them behind a sub-toggle.
- Per-project accent colour bleeds into the 2D row but not the 3D pane — could carry the accent into the pane's border in 3D mode for at-a-glance project identification.
- Debug strip is gated behind a header toggle (off by default) — fine for now; remove later if it ever feels intrusive.

Or move on to v0.2 candidates: notarization + GitHub Release with prebuilt DMG, or Linux/Windows builds, or per-project shell override.

## Active Blockers
- none

## Open Questions
- Should workspace-owned terminals survive *app quit*, or die with the process like every other PTY? Currently they die (no persistence layer for live PTY state); revisiting would need a session-snapshot system.
- Notarization timing — still deferred per ADR-0008, no external user has asked yet.
- Demo GIF for README — would help if we publicize beyond MIT-source.

## Recent Decisions (last 3)
- ADR-0010 — Bucket Workspace + Tauri v2 ACL window-scoping gotcha (load-bearing: future window labels must update capabilities)
- ADR-0009 — Quill.js for the project notes editor (M6)
- ADR-0008 — Release process for v0.1 (ad-hoc-signed, no notarization)
