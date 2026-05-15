# Status — Lexical Emerson

**Last updated:** 2026-05-15

## Current slice

**M5 — Polish + ad-hoc-signed release build (complete; awaiting commit).**

## Where we are

**v0.1.0 release-build artifact built and verified.**

- Project folder renamed `DevelopmentEnvironment` → `lexical-emerson` (methodology flag dir moved correspondingly).
- Refined LE-monogram icon generated (gradient base, cleaner letterforms, soft drop shadow) and propagated via `npx tauri icon`.
- README expanded with installation steps, ad-hoc-signing Gatekeeper note, full shortcuts table, and a roadmap.
- `npm run tauri build` produced:
  - `src-tauri/target/release/bundle/macos/Lexical Emerson.app` — **13 MB**
  - `src-tauri/target/release/bundle/dmg/Lexical Emerson_0.1.0_aarch64.dmg` — **4.7 MB**
- ADR-0008 captures the v0.1 release scope (ad-hoc-signed, no Apple notarization, no GitHub push yet).

**Idle RAM measurement** (release binary, main launcher window, no project loaded):

```
PID    RSS (KB)  COMMAND
79878  100880    .../Lexical Emerson.app/Contents/MacOS/lexical-emerson
TOTAL  ~99 MB
```

Under the ≤ 100 MB target. Tauri's WKWebView is in-process on macOS — no Chrome-helper bloat. Compare to a single VS Code window: ~500 MB across multiple Code Helper processes.

**Milestone history:**

- M4 (`43825bb`): buckets — schema, sidebar UI, footer cycle bar, `⌘J` / `⌘⇧J`.
- M3 (`58999a8`): multi-window + Cmd+P switcher + Tauri v2 listener-scoping fix.
- M2 (`02c0241`): rusqlite WAL persistence, Recent Projects sidebar, multi-terminal tabs.
- M1 (`3400063`): skeleton window with working PTY-backed terminal.

## Next concrete step

User-driven smoke test of the bundled `.app` (currently running as PID 79878):

1. Drag `Lexical Emerson.app` to `/Applications`.
2. Re-launch from Applications (right-click → Open the first time to bypass Gatekeeper since it's ad-hoc-signed).
3. Run through M1-M4 features end-to-end: pick folder → terminal works → ⌘T tab → Recent populates → ⌘P switches → ⌘⇧B new bucket → ⌘J cycle.
4. Quit and relaunch; confirm last project and active bucket restore correctly.

If all pass: M5 is fully complete, then later GitHub push + notarization remain as v0.1.1 work.

## Recent decisions (last 5)

- 2026-05-15 — Ad-hoc signing only for v0.1; defer notarization until distribution scales (ADR-0008).
- 2026-05-15 — ⌘J / ⌘⇧J as bucket cycle (no macOS system collision, ergonomic).
- 2026-05-15 — Bucket model: ordered ring + persisted cursor + app-scoped active bucket (ADR-0007).
- 2026-05-15 — Window-label identity for project windows; navigate-vs-mutate split (ADR-0006).
- 2026-05-15 — Tauri v2 + Solid + xterm.js + portable-pty stack locked (ADR-0001, 0002, 0003, 0004).

## Open questions

- File tree dotfile visibility (current: hide; v0.2 will add `Cmd+.` toggle).
- Basename collision in Recent ("MyApp" in two parent dirs) — currently both show the same label; v0.2 disambiguation.

## Blockers

None.

## Methodology status

- `methodology-active.md` flag: **set** at `~/.claude/projects/-Users-mahmutsalman-Documents-MyCodingProjects-Projects-EfficiencApps3-lexical-emerson/memory/`.
- `/checkpoint`, `/where-am-i`, `/replan-from-here` skills are active for this project.
