# Tasks — Current Slice (M3)

> Regenerated each milestone from `plan.md` + recent ADRs. Do not edit by hand long-term — rewrite at slice boundaries.

## Slice: M3 — Multi-window + Cmd+P switcher

**Exit criteria** (all must hit):

1. Cmd+P from any window opens a fuzzy modal listing all known projects.
2. Pressing Enter on a project either focuses its existing window (if open) or spawns a new one.
3. Clicking a project in the Recent sidebar opens it in a new window (not mutates current).
4. "Switch folder…" button still mutates the current window's project (M2 semantics preserved).
5. ⌘T / ⌘W / ⌘⇧]/[ menu shortcuts affect only the focused window's terminals, not all windows.
6. Closing a project window kills its PTYs (verifiable via `ps`); other windows unaffected.

### Tasks

- [x] Write `ADR-0006-window-project-identity.md`
- [x] Update `plan.md` and `tasks.md`
- [ ] Backend: `store::get_by_id`
- [ ] Backend: commands `request_open_project`, `get_project_by_id`, `mark_focused`
- [ ] Backend: add "Go" submenu with Quick Switcher (Cmd+P)
- [ ] Backend: route `on_menu_event` only to focused window (M2 emitted to all)
- [ ] Frontend: `ipc.ts` — wrappers for `requestOpenProject`, `getProjectById`, `markFocused`, `getCurrentWindowLabel`
- [ ] Frontend: `App.tsx` branches on window label (main vs project-N)
- [ ] Frontend: Recent click + new "Switch folder" semantics
- [ ] Frontend: `QuickSwitcher.tsx` modal — fuzzy fzf-style scoring, keyboard nav
- [ ] Frontend: window-focus listener calls `markFocused`
- [ ] Verify: `cargo check` clean, `tsc --noEmit` clean
- [ ] Manual test: 6 exit criteria above

### Definition of done

All 6 exit criteria hit; commit "M3 — multi-window + Cmd+P switcher"; update `docs/STATUS.md`. After this, M4 (buckets — the killer feature) is next.

### After M3: what comes next

M4 — Buckets. Schema additions: `buckets`, `bucket_projects` with per-bucket cursor. UI: bucket bar at window footer, "Add to bucket" command in switcher. App-scoped accelerators ⌘⇧]/[ already exist for terminal cycling — buckets will need different shortcuts (lean: ⌘⌥]/[) so they don't conflict.
