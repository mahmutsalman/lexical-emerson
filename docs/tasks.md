# Tasks — Current Slice (M5)

> Regenerated each milestone from `plan.md` + recent ADRs. Do not edit by hand long-term — rewrite at slice boundaries.

## Slice: M5 — Polish + ad-hoc-signed release build

**Exit criteria** (all must hit):

1. Project folder renamed `DevelopmentEnvironment` → `lexical-emerson`. Methodology flag dir moved correspondingly.
2. Refined LE-monogram icon replaces the placeholder.
3. README expanded with: what it is, why (RAM comparison), install instructions, the 4 main shortcuts (⌘P, ⌘T, ⌘J, ⌘⇧B), screenshots placeholder note.
4. About dialog metadata refreshed (version, copyright already wired via `AboutMetadataBuilder`).
5. `npm run tauri build` produces a working `.app` at `src-tauri/target/release/bundle/macos/Lexical Emerson.app`.
6. The release `.app` launches outside dev, runs through smoke test: pick folder, terminal works, recents persist, ⌘P, ⌘T tabs, ⌘J bucket cycle.
7. RAM measurement on release build, captured in STATUS.

### Tasks

- [x] Rename folder + methodology flag dir
- [x] Write `ADR-0008-release-process.md`
- [x] Update `plan.md` + `tasks.md`
- [ ] Generate refined LE-monogram icon (1024×1024 source PNG, run `npx tauri icon`)
- [ ] Expand README with install instructions + shortcut reference
- [ ] About dialog: confirm AboutMetadataBuilder fields are current
- [ ] `npm run tauri build` (release build)
- [ ] Smoke test the bundled `.app` (drag to `/Applications`, launch, run through M1-M4 features)
- [ ] Measure release-build RAM via `ps -axm | grep -i lexical`
- [ ] Commit M5

### Definition of done

All exit criteria met; commit "M5 — polish + ad-hoc-signed release build"; update `docs/STATUS.md` with v0.1.0-ready status. After M5 lands locally, GitHub push and notarization remain as future v0.1.1 / v0.2 work whenever the user decides.

### Out of scope for this slice (explicitly deferred)

- GitHub remote creation and push (user will do later).
- Code-signing with Developer ID.
- Notarization with Apple notary service.
- DMG packaging.
- CI workflow (`.github/workflows/build.yml`).
- Auto-update.

See ADR-0008 for the reasoning.
