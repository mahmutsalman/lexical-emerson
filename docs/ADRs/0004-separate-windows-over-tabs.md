# ADR-0004 — Separate windows over tabbed UI

**Status:** Accepted — 2026-05-15

## Context

Mahmut works on 20–100 projects per week, actively on ~5 at a time. He explicitly mentioned using Cmd-` to cycle between application windows already. The killer feature he wants is fast cycling, not a unified tab strip.

Two structural options:
- **One window with project tabs** (VS Code-style).
- **Separate macOS windows per project** (Sublime/Xcode-style).

## Options considered

### Option A — Tabbed UI
- One Tauri window. Cmd+1..9 switch tabs. File tree updates to reflect active tab. One PTY per tab persists in memory.
- Per-tab RAM cost: cheaper than a full window (~15–25 MB per inactive tab).
- Re-implements window-management UI: focus, z-order, Cmd-`, Mission Control, Stage Manager.

### Option B — Separate windows
- One Tauri window per opened project. Each is a full WKWebView.
- Per-window RAM cost: 55–80 MB.
- macOS WindowServer handles Cmd-`, Mission Control, Stage Manager, exposé, fullscreen, etc. for free.

## Decision

**Separate windows (Option B).**

Reasoning:
1. **Mahmut's existing workflow is Cmd-` cycling.** Building tabs would require him to re-learn his most automatic shortcut.
2. **Window management is operating-system territory.** macOS's WindowServer is faster, more correct, and more accessible than anything we'd build into a webview.
3. **The bucket feature works equally well with both** — a bucket is a logical group; cycling can spawn/focus windows or switch tabs. Windows are simpler to implement.
4. **Per-window RAM is higher than per-tab, but**: Mahmut "actively works on ~5" — at 5 × 70 MB = 350 MB total, we're still 1/3 of VS Code at the same 5 projects.
5. **Independent fault isolation.** If one project's PTY crashes (or `claude` does something pathological), the other windows are unaffected.

## Consequences

- We must spawn a new Tauri window per project, not just swap a panel. `app.handle().get_webview_window(...)` + `WebviewWindowBuilder::new()`.
- A "soft cap" warning is worth showing if the user opens >15 windows ("Lexical Emerson is open in 15 projects. Performance may degrade.")
- The bucket cycle command needs to enumerate currently open windows and decide focus-vs-spawn — implemented in M4.
- The "Recent Projects" sidebar in any window shows the same data — it's process-global, not window-local.

## Revisit when

- Per-window RAM measured >100 MB.
- A user (or future Mahmut) requests tabs as the primary UI.
- We move to Linux/Windows where window management is materially less polished than macOS.
