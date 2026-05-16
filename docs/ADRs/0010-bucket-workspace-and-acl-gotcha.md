# ADR-0010 — Bucket Workspace window + Tauri v2 ACL window-scoping gotcha

**Status:** Accepted — 2026-05-16

## Context

M7 adds a new window kind beyond the existing `main` and `project-<id>`: the
**Bucket Workspace** (`bucket-3d-<bucket_id>`). It aggregates live terminals
across every project in a bucket into one window — a 2D grouped tab strip by
default, and a 3D stacked-arcs immersive mode (⌘⌥3) for at-a-glance survey of
all terminals at once. The killer use case: you have 3 projects in a bucket,
each running `claude` plus a build watcher; the workspace lets you scan all 6
terminals from one focused workspace without ⌘J-cycling through windows.

This required two new architectural pieces and surfaced one Tauri v2 trap
that was responsible for ~all of the day's debugging time.

## Decisions

### 1. Per-process PTY registry, populated atomically on spawn

`AppState` gains a `Mutex<HashMap<String, PtyTerminalInfo>>` keyed by `pty_id`.
Every `open_terminal` call writes into it from inside the same Rust function
that spawns the PTY — atomic, no two-step "spawn then register" race window.
`PtyMessage::Exit` (PTY reader thread terminating) prunes the entry and
broadcasts `terminals://changed` so every window's listener reconciles.

The registry is **read by the workspace, written by every window**. Both per-
project windows and the workspace itself (when the user clicks `+` for an
owned terminal) call into the same path. Workspace-owned terminals carry a
`closeOnUnmount: false` flag so the workspace closing doesn't kill the PTY —
this means a terminal can outlive the workspace that spawned it (a desired
property; the user might close the workspace expecting "minimize", not "kill").

### 2. Workspace listens via `terminals://changed` broadcast for live updates

The workspace's `reconcile()` is called both on mount (initial snapshot) and
on every `terminals://changed` broadcast (delta updates). This is what lets
the workspace stay in sync as project windows spawn new terminals without
manual refresh.

The same broadcast pattern is reused for menu shortcuts (⌘T spawns an owned
terminal in the active project, ⌘⌥↑/↓ cycles the active ring, etc.) — all of
this depends on `listen()` working in the workspace window.

### 3. **THE GOTCHA — Tauri v2 capabilities are per-window-label**

`src-tauri/capabilities/default.json` has a `windows: [...]` array that lists
which window labels the capability grants apply to. Until 2026-05-16 it was:

```json
"windows": ["main", "project-*"]
```

When we added the `bucket-3d-*` window family, the capability config was
not updated. The new window therefore had **zero permissions** at runtime —
including `core:event:allow-listen`. JS-side `listen("terminals://changed", ...)`
returned a promise that **silently rejected** with:

```
Unhandled Promise Rejection: Command plugin:event|listen not allowed by ACL
```

These rejections only appear in devtools — never in stderr, never in any
visible UI. So the symptom we observed was:
- Per-project terminals spawned and registered correctly (logs proved it).
- Workspace's initial `await reconcile()` worked (it uses `invoke`, which
  is allowed by default).
- Workspace's auto-refresh never fired, so it showed "registry 0" even
  though entries existed.
- Workspace's ⌘T / ⌘⌥3 / ring-navigation also silently broke — same root
  cause, all `listen`-based.

Burned a full session chasing alternate hypotheses (camelCase/snake_case
conversion, state sharing across windows, Option<T> deserialization, stale
build cache) before the in-UI debug panel + production devtools surfaced the
ACL errors.

**Fix:** add the new window pattern to the capability config.

```json
"windows": ["main", "project-*", "bucket-3d-*"]
```

### 4. Production devtools enabled via Tauri's `devtools` feature

Added the `devtools` feature to the tauri crate in `Cargo.toml`. Without it,
the ACL errors and any future runtime issues would only surface in a debug
build — but our release build is what the user actually runs. The performance
and bundle-size cost is negligible (a few hundred KB).

```toml
tauri = { version = "2.0", features = ["macos-private-api", "protocol-asset", "devtools"] }
```

## Consequences

- **Every new window kind requires a capabilities entry.** Future window
  families (e.g. a settings window `settings-*`, a dedicated notes window
  `notes-<id>-*`) must be added to `capabilities/default.json` or they'll
  silently lose all event-based features. Add to the deploy checklist.
- A per-process registry means terminal discovery is bounded to a single
  Tauri app instance. If we ever spin up a sidecar process for sandboxing
  (none planned), we'd need a different IPC.
- xterm.js renders inside CSS-3D-transformed parents in the workspace's 3D
  mode. WebKit doesn't reliably fire `ResizeObserver` on the `display:none →
  flex` transition that mode switches trigger, so a `TerminalHandle.fitNow()`
  helper drives manual fits on mode changes and after handle registration.
  Also: inactive rings get `pointer-events: none` and the active ring gets
  `z-index: 5` to ensure clicks land on the active terminal rather than an
  overlapping inactive ring's empty box.
- The atomic-register-on-spawn pattern means there's no separate
  "registration ack" round trip — `open_terminal` either spawns AND
  registers, or fails. Simpler than the two-call alternative.

## Diagnostic tools left in place

Even after the fix, the workspace keeps a **Debug** toggle in its header.
Clicking it surfaces a strip showing:
- The bucket's project IDs
- Every registry entry: `pty_id · project_id · project_path`
- A **Test-insert** button that inserts a known fake registry entry
- A **Refresh** button that re-queries

`commands.rs` keeps `eprintln!` traces on every registry op
(`[open_terminal]`, `[register_terminal]`, `[list_all_registered_terminals]`,
`[list_terminals_for_bucket]`). They're visible if the app is launched from
a terminal:

```
/Applications/Lexical\ Emerson.app/Contents/MacOS/lexical-emerson
```

Cost is one `eprintln!` per terminal-lifecycle event — negligible. If they
ever feel noisy, gate behind a runtime flag instead of removing.

## Revisit when

- We ever need more than one Tauri-app process (e.g. sandbox per project).
  The single-process registry won't survive that.
- The workspace's reconcile + broadcast becomes slow with hundreds of
  terminals (currently O(n) per change; fine for the 3–5 projects × 1–3
  terminals each that real users will hit).
- We add a third + fourth window kind. At that point consider switching
  capabilities to a single permissive `*` pattern with comment justifying
  why (rather than tracking each window family).
