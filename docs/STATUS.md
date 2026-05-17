# Status — Lexical Emerson

**Last updated**: 2026-05-17 14:16
**Current phase**: v0.1 shipped + post-v0.1 feature work (M6 notes, M7 workspace, M7.5 session restore)
**Current slice**: M7 polish round 5 — 3D bucket workspace UX, finalised (cylindric tilt restored as a CONSTANT, top inset bumped, ADR-0012 written)

---

## Last Completed Task
M7 polish round 5 finalised — six rolling fixes shipped & verified by user across one session:
(1) Per-project focus timer (commit `bb920dd`).
(2) Enter-routing & stale-focus prevention in 3D mode — parkFocus() helper, modal-aware bail, stopImmediatePropagation in modals, handle-map cleanup, mount-focus gated on .bw-pane.is-facing.
(3) Canvas freeze fix — TerminalPane dropped WebglAddon, always uses CanvasAddon. Composited-layer desync inside preserve-3d ancestors is the failure mode WebGL's onContextLoss didn't catch.
(4) Dome cylinder arrangement — domeLiftPx() helper lifts side slots vertically by ratio × ringHeight × 0.18.
(5) Constant `stackTiltDeg = -4°` instead of per-idx formula. Every project's 3D view now looks identical AND retains the cylindric wrap. Walked through three intermediate states (per-idx tilt → 0 → -4°) with the user to land here.
(6) `.bw-rings.is-3d` top inset bumped 28px → 48px so the facing pane's accent outline isn't clipped against the title-bar / auto-hidden header.

Documented in ADR-0012 and in the new global note `~/.claude/notes/css-3d-cylinder-workspace-feel.md` (cross-project knowledge — three knobs + transform-order gotcha + WebGL-inside-preserve-3d trap).

## Next Concrete Action
Investigate the intermittent one-of-seven-projects Enter/typing drop the user mentioned. Other six work fine in the same 3D view; one project occasionally doesn't receive keystrokes after focus. Use ⌘⌥D event-capture overlay when it reproduces to pinpoint the failing event (parkFocus blur? handle map mismatch? session-id drift?). Low priority — user is unblocked.

## Active Blockers
- none

## Open Questions
- One of seven open projects intermittently drops Enter/typing in 3D mode while the other six work fine. User accepted it as low-priority follow-up; root cause unknown — could be a stale handle (pre-cleanup tab), a session-id mismatch, or registry drift. Worth attaching the ⌘⌥D event-capture overlay next time it reproduces.
- ADR-0001's `allow-unsigned-executable-memory` entitlement was tied to WebGL on hardened runtime. With WebGL retired (ADR-0012), the entitlement is now decorative. Decide whether to remove it (and update the ADR / CLAUDE.md invariants) in a future cleanup pass.
- `@xterm/addon-webgl` is still in `package.json` even though it's no longer imported. Safe to `npm uninstall` next slice; left in place this commit to keep the diff minimal.

## Recent Decisions (last 3)
- **ADR-0012** — Cylindric 3D bucket-workspace geometry (constants + canvas renderer). Codifies the three knobs (FACE_WIDTH_FRAC=0.62, DOME_LIFT_FRAC=0.18, stackTiltDeg=-4°), the CSS transform order rules, the 48px top inset, and the WebGL retirement.
- (this session, no ADR) — Retire `WebglAddon` entirely instead of trying to patch the composited-layer desync. Canvas renderer is fast enough for moderate Claude Code throughput; WebGL's failure mode here is silent and untriggerable by `onContextLoss`. Captured in ADR-0012.
- (this session, no ADR) — Park focus on `.bw-stack` (tabIndex=-1, outline:none) after every 3D navigation — keystrokes between navigations can't reach a stale xterm. Synchronous park inside cycle handlers eliminates the same-frame Enter race against the createEffect microtask.
