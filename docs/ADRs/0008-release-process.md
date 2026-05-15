# ADR-0008 — Release process for v0.1

**Status:** Accepted — 2026-05-15

## Context

Lexical Emerson is feature-complete after M4. M5 ships it. The release process for a Tauri v2 macOS app has well-known steps; we lock down what we'll do for v0.1 and what we'll explicitly defer.

## Decisions

### v0.1 ships ad-hoc-signed, NOT notarized

Apple's notarization requires:
- An active Apple Developer Program membership ($99/year).
- A Developer ID Application certificate installed in Keychain.
- An Apple ID app-specific password for `notarytool` submissions.
- A few minutes per submission waiting for Apple's notary service.

For v0.1 — a personal-use tool we're still iterating on — we ship an **ad-hoc-signed `.app` bundle**. Users (currently: Mahmut) download it from a GitHub release, drag to `/Applications`, and on first launch right-click → Open to bypass Gatekeeper. This is the same pattern used by countless open-source macOS apps that don't pay the Apple tax.

When notarization becomes worth it (e.g. broader distribution, or contributors hitting Gatekeeper friction repeatedly), we'll revisit by following the recipe in `~/.claude/notes/macos-notarization-electron-python.md`.

### Build command and bundle path

```
npm run tauri build
```

Produces `src-tauri/target/release/bundle/macos/Lexical Emerson.app`. We do **not** generate a DMG for v0.1 — `.app` zipped is fine for personal distribution. DMG comes when notarization comes (Apple's notary service prefers DMG over ZIP — see notarization notes).

### Icon refresh

Replace the placeholder LE-monogram (a procedurally-drawn block letterform on a blue square) with a refined version: gradient background + cleaner letterform with better proportions. Still LE-based for identity continuity, just less obviously a placeholder. Generated via PIL.

### Release artifacts

For v0.1:
- `Lexical Emerson.app` zipped (artifact for distribution).
- `README.md` with install instructions, screenshots, demo description.
- Git tag `v0.1.0`.
- A future GitHub Release will host the zip; for this session the artifact stays local.

### What we are NOT doing in this milestone

- **No GitHub remote / push.** User decided to push later. The local commits sit on `main` ready when he is.
- **No notarization.** As above.
- **No DMG.** As above.
- **No CI workflow.** `.github/workflows/build.yml` was scaffolded in M1 but stays empty until notarization makes a CI pipeline worth the effort.
- **No auto-update.** v0.1 is download-and-replace.

## Consequences

- The bundled `.app` will trigger Gatekeeper on first launch on any Mac. The workaround (right-click → Open) is documented in the README.
- The release build verifies all M1-M4 features work outside the dev environment — this is a real regression check, not just a packaging exercise. Things that can break here: `frontendDist` paths, missing entitlements, icon loading, native menu accelerators, PTY spawning under a signed-but-not-dev binary.
- RAM measurement happens on the release build (not dev). Dev mode keeps the Vite dev server alive in the process tree; release mode is the real number we'd put in the README.

## Revisit when

- Distribution scales beyond single-user — then notarization + DMG + GitHub Release pipeline.
- A contributor reports the Gatekeeper warning as a meaningful adoption friction.
- Auto-update becomes valuable (probably v0.3+).
