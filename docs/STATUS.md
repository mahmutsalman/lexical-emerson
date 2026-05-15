# Status — Lexical Emerson

**Last updated**: 2026-05-15 21:00
**Current phase**: v0.1 — feature-complete, shipped (local + public source)
**Current slice**: none active — M5 closed v0.1.0

---

## Last Completed Task
M5 — v0.1.0 release build (commit `eaff729`, tag `v0.1.0`); pushed source to https://github.com/mahmutsalman/lexical-emerson (public, MIT). Build produced a 13 MB `.app` and 4.7 MB DMG; release-binary idle RAM measured at ~99 MB (under the 100 MB/window target).

## Next Concrete Action
Dogfood the app for ~a week. Drag `src-tauri/target/release/bundle/macos/Lexical Emerson.app` to `/Applications` and use it as the daily driver for real work; file friction as GitHub issues against `mahmutsalman/lexical-emerson`. Use the issue list to decide between v0.1.1 (notarization + GitHub Release with prebuilt DMG) vs v0.2 (Linux/Windows builds, dotfile toggle, per-project shell).

## Active Blockers
- none

## Open Questions
- Demand for prebuilt binaries — if anyone clones and asks about prebuilt DMG, notarization becomes worth the $99/year Developer Program tax (currently deferred per ADR-0008).
- Demo GIF for README — would substantially help adoption but needs ~10 minutes of screen recording.
- Folder pre-population — should `~/Library/Application Support/lexical-emerson/state.db` ship with example buckets, or stay empty?

## Recent Decisions (last 3)
- ADR-0008 — Release process for v0.1 (ad-hoc-signed, no notarization, no GitHub Release with binary asset)
- ADR-0007 — Bucket model: ordered ring with persisted cursor + app-scoped active bucket
- ADR-0006 — Window-project identity (window label = `main` or `project-<id>`) + navigate-vs-mutate split
