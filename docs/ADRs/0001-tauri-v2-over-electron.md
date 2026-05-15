# ADR-0001 — Tauri v2 over Electron

**Status:** Accepted — 2026-05-15

## Context

Lexical Emerson's whole reason to exist is to escape VS Code's ~500 MB-per-project RAM cost. Electron starts at ~250–400 MB idle per window plus ~100–200 MB per renderer, which would erase the win before we even add features.

Mahmut has shipped:
- Multiple Electron apps (TimeTrackerr, NotesWithAudioAndVideo, SmartBook Reader) — `disk-cleanup-mycodingprojects.md` shows 15+ deleted Electron experiments and aggravation with the bloat.
- One Tauri v2 app (OBS Shortcut Controller, `obs-shortcut-controller-dev.md`) — shipped cleanly, no documented complaints.

## Options considered

| Option | Idle RAM (1 window) | Binary | Familiarity | Cross-platform |
|---|---|---|---|---|
| **Tauri v2 + Rust + tiny webview** | 70–130 MB | ~12 MB | High (shipped before) | macOS/Linux/Windows |
| Electron | 250–400 MB | ~150 MB | High | All |
| Swift + SwiftUI (native macOS) | 30–60 MB | ~3 MB | Moderate (no recent use) | macOS only |
| Rust + egui/iced (pure native) | 30–50 MB | ~8 MB | Low (new paradigm) | All |

## Decision

**Tauri v2.** It's the only option that combines:
1. A floor that's already a 5–10× win over VS Code (good enough).
2. Mahmut's shipped muscle memory (no learning tax).
3. Cross-platform optionality preserved for v0.2 (even though v0.1 is macOS-only).
4. Best open-source contributor pool of the candidates.

Native (Swift) would give a lower RAM floor but locks out v0.2 cross-platform and is a new stack. Pure-native Rust (egui) is the steepest learning curve and immediate-mode UI is opinionated.

## Consequences

- We accept the ~70–130 MB per-window RAM floor as a hard limit. If a future v0.x feature pushes us over, we redesign rather than ignore.
- WKWebView baseline (~50 MB) is unavoidable on macOS. Per-window cost grows mostly from this.
- We get hardened-runtime + notarization for free via `cargo tauri build`; Mahmut's notarization pipeline (`macos-notarization-electron-python.md`) applies directly.
- We commit to Rust as the backend language for the lifetime of this project. No Python sidecars, no Node sidecars.

## Revisit when

- Idle RAM measured at >150 MB per window — investigate before any new feature lands.
- Tauri v3 ships with materially different tradeoffs.
- We try to ship Lexical Emerson on a Linux distro that doesn't ship a usable WKGTK/WebKitGTK.
