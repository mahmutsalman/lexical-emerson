# Status — Lexical Emerson

**Last updated**: 2026-05-17 13:58
**Current phase**: v0.1 shipped + post-v0.1 feature work (M6 notes, M7 workspace, M7.5 session restore)
**Current slice**: M7 polish round 5 — 3D bucket workspace UX (focus routing, canvas freeze, dome geometry)

---

## Last Completed Task
Three-way fix shipped & verified by user this session:
(1) Enter-routing & stale-focus prevention in 3D mode — `parkFocus()` helper anchors focus on `.bw-stack` after every navigation, modal-aware bail at the top of `onWorkspaceKey`, `stopImmediatePropagation` in `NotesModal` / `TimerModal`, handle-map cleanup via `onDeregister`, `TerminalPane` mount-focus gated on `.bw-pane.is-facing`.
(2) Canvas freeze in 3D mode — `TerminalPane` dropped `WebglAddon` entirely; always loads `CanvasAddon`. xterm's WebGL canvas was being promoted to its own composited GPU layer under `transform-style: preserve-3d` and silently desyncing.
(3) Dome cylinder arrangement — side slots lift vertically proportional to |slot angle| via new `domeLiftPx()` helper (`DOME_LIFT_FRAC = 0.18`). Notes face and terminal slots both updated. Side panes now visibly sit up-and-out from the facing pane.

Per-project focus timer also shipped earlier in this session (commit `bb920dd`): right-edge rail in 3D mode, click opens modal, Enter starts countdown, finish fires a WebAudio bell + radial flash tinted with the project accent.

## Next Concrete Action
Add a bit more top padding/margin to the active terminal in 3D mode — user reports the top frame border is currently clipped against the workspace's top edge. The `.bw-rings.is-3d` rule already insets the stack 28px top+bottom (`bucket-workspace.css:560-561`); likely needs ~16-24px more on top, OR the facing pane needs its own breathing-room rule.

## Active Blockers
- none

## Open Questions
- One of seven open projects intermittently drops Enter/typing in 3D mode while the other six work fine. User accepted it as low-priority follow-up; root cause unknown — could be a stale handle (pre-cleanup tab), a session-id mismatch, or registry drift. Worth attaching the ⌘⌥D event-capture overlay next time it reproduces.
- ADR-0001's `allow-unsigned-executable-memory` entitlement was tied to WebGL on hardened runtime. With WebGL retired, the entitlement is now decorative. Decide whether to remove it (and update the ADR / CLAUDE.md invariants) in a future cleanup pass.
- `@xterm/addon-webgl` is still in `package.json` even though it's no longer imported. Safe to `npm uninstall` next slice; left in place this commit to keep the diff minimal.

## Recent Decisions (last 3)
- (this session, no ADR) — Dome cylinder over flat-cylinder-with-tighter-perspective or flipped-stack-tilt. User picked dome shape directly from a 3-way preview before implementation. Tunable via a single `DOME_LIFT_FRAC` constant.
- (this session, no ADR) — Retire `WebglAddon` entirely instead of trying to patch the composited-layer desync. Canvas renderer is fast enough for moderate Claude Code throughput; WebGL's failure mode here is silent and untriggerable by `onContextLoss`.
- (this session, no ADR) — Park focus on `.bw-stack` (tabIndex=-1, outline:none) after every 3D navigation — keystrokes between navigations can't reach a stale xterm. Synchronous park inside cycle handlers eliminates the same-frame Enter race against the createEffect microtask.
