# Tasks — Current Slice (M4)

> Regenerated each milestone from `plan.md` + recent ADRs. Do not edit by hand long-term — rewrite at slice boundaries.

## Slice: M4 — Buckets (the killer feature)

**Exit criteria** (all must hit):

1. Create a bucket from the sidebar's Buckets section via `+ New bucket`.
2. Add 3 projects to the bucket — visible inline when the bucket is expanded.
3. Click bucket name → that bucket is the active one (highlighted blue, shown in footer bar).
4. `⌘⌥]` cycles forward: opens (or focuses) the next project's window. Wraps at the end.
5. `⌘⌥[` cycles backward.
6. The cursor position persists across app restart.
7. Removing a project from a bucket while it's the active one doesn't crash; cycle continues with the smaller list.
8. The active-bucket setting persists across app restart.

### Tasks

- [x] Write `ADR-0007-bucket-model.md`
- [x] Update `plan.md` + `tasks.md`
- [ ] Backend: schema migrations (`buckets`, `bucket_projects`, `app_meta`)
- [ ] Backend: `store.rs` bucket helpers (CRUD, cursor advance, active bucket get/set)
- [ ] Backend: Tauri commands (`list_buckets`, `create_bucket`, `delete_bucket`, `rename_bucket`, `add_to_bucket`, `remove_from_bucket`, `set_active_bucket`, `get_active_bucket`, `cycle_bucket`)
- [ ] Backend: new "Bucket" submenu in `main.rs` with Cycle Forward (⌘⌥]) + Cycle Backward (⌘⌥[) + separator + New Bucket (⌘⇧B)
- [ ] Frontend: `ipc.ts` wrappers for all bucket commands + `onMenuEvent` cases `bucket-next`, `bucket-prev`, `bucket-new`
- [ ] Frontend: replace sidebar Buckets placeholder with interactive `BucketsList` component
- [ ] Frontend: `BucketBar` footer component shows active bucket + position + cycle arrows
- [ ] Frontend: window-scoped listeners on `menu://bucket-*` call `cycleBucket(direction)` (Rust handles opening / focusing)
- [ ] Verify: `cargo check` clean, `tsc --noEmit` clean
- [ ] Manual test: hit all 8 exit criteria from a fresh app launch

### Definition of done

All exit criteria hit; commit "M4 — buckets (the killer feature)"; update `docs/STATUS.md`. After M4 lands, M5 (notarize + release) is the final slice.

### After M4: what comes next

M5 — Polish, sign, notarize, GitHub release. Reuse `~/.claude/notes/macos-notarization-electron-python.md` for the CI recipe. Add About dialog, app icon refresh (better than the placeholder LE monogram), code-signing entitlements check.
