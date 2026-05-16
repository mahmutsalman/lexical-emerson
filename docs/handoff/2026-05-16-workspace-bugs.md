# Bucket Workspace — two outstanding bugs (2026-05-16 hand-off)

You are continuing work on **Lexical Emerson**, a Tauri v2 + Solid.js + Rust + xterm.js folder/terminal launcher for macOS. Each project opens in its own native window (`project-<id>` label). A new "Bucket Workspace" window (`bucket-3d-<bucket_id>` label) was added in this branch — it's a sibling window that aggregates terminals across every project in a bucket and offers a 2D grouped tab-strip view plus a 3D stacked-arcs view.

The user wants:
1. Per-project terminals registered in the global registry to show up in the workspace.
2. A working 3D arc view where they can see and type into terminals.

After many iterations both bugs persist. Read this, then read the files referenced below, then form your own hypotheses **before** making changes.

---

## Architecture — keep this in your head

### Process / window topology
- Single Rust process backs the app. All windows share `AppState`.
- `AppState` (in `src-tauri/src/main.rs`):
  - `pty_manager: Mutex<PtyManager>` — owns all PTYs.
  - `pty_registry: Mutex<HashMap<String, PtyTerminalInfo>>` — discovery map keyed by `pty_id`. `PtyTerminalInfo` = `{ pty_id, project_id, project_path, title }`. Used by the workspace to find PTYs by bucket.
  - `main_project_id: Mutex<Option<i64>>` — which project the main launcher is showing.
- `pty.rs` emits `pty://data` and `pty://exit` as **global** Tauri events (broadcast). `pty://exit` also drops the matching entry from `pty_registry` and broadcasts `terminals://changed`.

### Per-project view (`src/components/TerminalsView.tsx`)
- Owns `allTabs: Tab[]` (local UI keys, `id` is `tab-N` from a counter — NOT the pty session id).
- Owns `sessionIdByTab: Record<tabId, ptyId>` sidecar map. Tab objects stay reference-stable because Solid `<For>` reconciles by reference equality — mutating `Tab.sessionId` caused remount loops earlier in this branch.
- Renders `<TerminalPane>` for each tab. Spawn mode (no `sessionId` prop) → TerminalPane calls `openTerminal(...)` itself and invokes `props.onSpawned(sid)` so the parent can record it.
- Receives `projectId: number` from `App.tsx` as `projectId={projectId() ?? 0}` where `projectId = () => currentProject()?.id ?? null`.

### Workspace (`src/components/BucketWorkspace.tsx`)
- Two flavors of tab:
  - **Attached** — discovered in registry. `tab.sessionId` set at creation = `pty_id`. TerminalPane runs in attach mode (skips `openTerminal`, just calls `resizeTerminal`).
  - **Owned** — user clicked `+`. `tab.sessionId` undefined at creation; sidecar `sessionIdByLocalTab` holds the post-spawn id. TerminalPane runs in spawn mode.
- `reconcile()` is called on mount + every `terminals://changed`. It fetches `list_terminals_for_bucket(bucketId)`, computes `survivors + adds` preserving Tab refs, AND computes the active-tab-per-project selection — all committed in a `batch(() => { setTabs(...); setActiveByProject(...); })` so the first render has the active pane already at `display: flex` (this matters because WebKit doesn't reliably fire `ResizeObserver` on a `display: none → flex` transition, which strands xterm at 0×0).
- 3D geometry: outer `.bw-rings` does `translateY(-activeProjectIdx * ringHeight) rotateX(tilt)`. Each `.bw-ring` is `translateY(pi * ringHeight)`. Each `.bw-cylinder` is `translateZ(-radius) rotateY(rotation)` only when `arr().length >= 2`. Each `.bw-pane.is-3d` has `inset: 0 19%` and `pointer-events: none` by default, with `is-facing` adding `pointer-events: auto` and full opacity.
- The header has visible diagnostics: a `2D` / `3D` badge, a `N tabs · registry M` counter, `Re-scan` button (broadcasts `terminals://rescan-request`), and `Enter 3D` / `Exit 3D` button.

### Atomic registration (latest attempt)
- `open_terminal` Rust command now takes optional `project_id: Option<i64>` and `project_path: Option<String>`. If both are provided, it inserts the new pty into `pty_registry` **inside the same call** before returning the `pty_id`. This removes the silent-fail risk of a two-step spawn-then-register flow.
- Frontend `openTerminal(cwd, cols, rows, projectId?, projectPath?)` passes these through.
- `TerminalPane` props gained `projectId?: number` and `projectPath?: string`. Both per-project and workspace render sites pass them.

### Other relevant pieces
- `App.tsx` routes windows by label: `"main"` / `"project-<id>"` / `"bucket-3d-<bucket_id>"`. The workspace window shell is a separate flexbox column with no sidebar.
- `closeOnUnmount` decision is captured into a closure `let shouldCloseOnTeardown` in `TerminalPane.onMount` (before any awaits) because reading `props.closeOnUnmount` from `onCleanup` after webview teardown was returning `undefined` and silently killing PTYs the workspace wanted to keep alive.
- `spawn_bucket_3d_workspace` explicitly calls `window.set_focus()` after build so `⌘⌥3` (menu accelerator → focused window) routes to the workspace.
- `TerminalHandle.fitNow()` was added. The workspace has a `createEffect(() => { mode(); setTimeout(fitAll, 30); setTimeout(fitAll, 250); })` to force xterm to re-measure after the 2D↔3D class swap.

---

## What the user is observing right now (after `12:12` install + their `⌘Q`+relaunch)

### Bug A — per-project terminals never appear in the workspace's registry
- User opens the per-project window for `lexical-emerson`. Sees a working terminal at the standard prompt `(base) mahmutsalman@192 lexical-emerson %`.
- Opens the bucket workspace via right-click on "first bucket" → "Open in 3D Workspace".
- Workspace header reads `2D · 0 tabs · registry 0`.
- This is from running the bundle installed at `12:12` — the one with the atomic `open_terminal` registration. The per-project window in this session was opened *after* the relaunch, so it should have hit the new code path. Either it didn't, or the registration is happening with the wrong `project_id` (e.g., `0`), or the workspace's filter is excluding entries.

### Bug B — 3D view shows a pane but no terminal content, can't type
- User clicks `+` in the workspace (creates owned terminal — spawns a fresh PTY for that project).
- Clicks `Enter 3D` or presses `⌘⌥3`. Mode badge flips to `3D`. The CSS class on `.bucket-workspace` becomes `mode-3d`, the tab strip hides, and the panes get `.is-3d`.
- User sees a faint pane outline but no shell prompt rendered inside, and keystrokes don't reach the PTY.
- This is *after* the `fitNow()` fix, so xterm should have re-measured. Either the fit isn't actually taking effect, the pane has 0 dimensions for a different reason, or xterm has focus problems under 3D CSS transforms.

---

## Files you'll need

- `src-tauri/src/main.rs` — `AppState`, menu wiring, `on_menu_event` routing to focused window.
- `src-tauri/src/commands.rs` — `open_terminal` (auto-registers), `register_terminal`, `unregister_terminal`, `list_terminals_for_bucket`, `list_all_registered_terminals`, `rescan_terminals`, `spawn_bucket_3d_workspace`.
- `src-tauri/src/pty.rs` — PTY lifecycle. The `install_event_forwarder` task does global broadcasts AND drops registry entries on `PtyMessage::Exit`.
- `src-tauri/src/store.rs` — SQLite. `get_bucket(id)`, `load_bucket_projects(bucket_id)`.
- `src/components/TerminalsView.tsx` — per-project view. Tab interface, addTerminal, handlePaneSpawned, onRescanRequest listener, render.
- `src/components/TerminalPane.tsx` — xterm wrapper. Note the `shouldCloseOnTeardown` capture, the `if (props.sessionId) { attach } else { spawn }` branch, and the new `fitNow` handle exposed via `props.onReady`.
- `src/components/BucketWorkspace.tsx` — the new workspace. Owns mode, reconcile, addOwnedTerminal, the createEffect that calls fitNow on every mode change.
- `src/styles/bucket-workspace.css` — workspace styling. `.bw-pane`, `.bw-pane.is-3d`, `.bw-rings`, etc. The `.bw-pane .xterm { flex: 1; min-height: 0; padding: 8px }` rule mirrors the proven per-project `.terminal-host .xterm` pattern.
- `src/App.tsx` — window-label routing, passes `projectId={projectId() ?? 0}` to per-project `TerminalsView`.
- `src/lib/ipc.ts` — TS wrappers. Note `openTerminal` now passes `projectId ?? null` and `projectPath ?? null`.

### Memory entries to read
- `~/.claude/projects/-Users-mahmutsalman-Documents-MyCodingProjects-Projects-EfficiencApps3-lexical-emerson/memory/feedback_build_install_running_app.md` — **CRITICAL.** Build with `npm run tauri build -- --bundles app`, install with `rm -rf` + `ditto` to `/Applications/Lexical Emerson.app`. Never `killall` the running session — the user's Claude Code lives inside the app process.
- `~/.claude/projects/.../memory/feedback_solid_for_reference_equality.md` — Solid's `<For>` reconciles by item reference; mutating items via `.map` breaks it. Also covers the `props`-in-`onCleanup` teardown trap.

---

## Hypotheses worth testing for Bug A

**H-A1: The user's running process is older than they think.** Even with `⌘Q`+relaunch, the launch could have raced. Confirm: `ps -axm -o pid,start,command | grep "Lexical Emerson"`. If the start time is before the install mtime (`stat -f "%Sm %N" "/Applications/Lexical Emerson.app/Contents/MacOS/lexical-emerson"`), they're on stale code. Don't fix anything yet — just verify.

**H-A2: `project_id` reaching `open_terminal` is `0`.** In `App.tsx`, `projectId={projectId() ?? 0}` uses `0` as a fallback when `currentProject` is null. If the per-project window's first `addTerminal` fires before the Show's gating-on-`projectPath()` causes the prop to read the real id, we'd write `0` into the registry, and `list_terminals_for_bucket` would filter it out. Verify: add a `log::info!("open_terminal pid={:?} ppath={:?}", project_id, project_path)` in `commands.rs::open_terminal`, run from a terminal (`/Applications/Lexical\ Emerson.app/Contents/MacOS/lexical-emerson` directly so stderr is visible), open a project, look at the log line for the first spawn.

**H-A3: The atomic registration write didn't actually deploy.** Verify the installed binary's mtime > the source-file mtime. Verify the bundle has the new resources (the index-*.js hash should be different from the prior build).

**H-A4: `list_terminals_for_bucket` is filtering correctly but the bucket's project ids don't match the registered ids.** Could happen if a project was deleted and re-registered with a new id but the bucket still references the old row — but SQLite FK constraints should cascade. Confirm: query the bucket's `bucket_projects` rows and the `pty_registry` contents (via `list_all_registered_terminals`) and check overlap.

**H-A5: There's an async race where `TerminalPane.onMount` calls `openTerminal` before its containing `<For>` has settled, so it reads props from a transient state.** Less likely after the batch/refactor work, but worth ruling out — log `project_id` from inside `openTerminal` and trace.

## Hypotheses worth testing for Bug B

**H-B1: The active 3D pane has zero box height because the `.bw-rings` `translateY` carries the active ring off-screen.** I compute `stackTranslateY() = -activeProjectIdx * ringHeightPx()` and each ring sits at `translateY(pi * ringHeightPx)`. With `ringHeightPx = max(360, panelWidth*0.42)` and a tall app, the math should land the active ring at viewport y=0. But if `panelWidth` is read before `ResizeObserver` populates it, you get 800 → it could be wrong. Inspect the running app's DOM, look at `.bw-rings` computed transform vs `.bw-ring` per-element transforms, then read off the pane's `getBoundingClientRect`.

**H-B2: `fitNow()` is being called but xterm's renderer is choking on a 3D-transformed parent.** xterm uses WebGL with its own canvas; CSS transforms on the parent can interact badly with WebGL renderer fallback. Try forcing the canvas renderer in 3D mode, or check the WebGL addon's error console.

**H-B3: xterm doesn't get keyboard focus after the 3D class swap.** Click-to-focus in xterm relies on `getBoundingClientRect` mapping to internal cells. CSS 3D transforms make `getBoundingClientRect` return the un-transformed box, but clicks land on the transformed surface — the math goes wrong. The per-project 3D view handles this with `padding: 0` on `.terminal-host.is-3d .xterm`; I copied that in `bucket-workspace.css`. Verify it actually applied to the workspace pane and check whether clicks inside the 3D pane focus the xterm at all (look at `document.activeElement`).

**H-B4: My `createEffect(() => { mode(); setTimeout(fitAll, 30); setTimeout(fitAll, 250); })` doesn't actually iterate the right handles.** `handles` is a `Map`; the `onReady` callback writes into it but there's no cleanup on unmount, and if the same `tab.id` mounts twice (shouldn't but check) the second one overwrites the first. Audit and add an `onCleanup(() => handles.delete(tab.id))` at the pane site.

**H-B5: The pane truly is at correct dimensions and xterm is rendering, but it's behind a sibling `.bw-ring` with higher stacking. In 3D mode all rings are `display:flex` with `position:absolute inset:0`, all the same z-index. Later siblings paint on top.** Could try `z-index` on `.bw-ring.is-active` to bring it forward, or set `pointer-events: none` on non-active rings entirely.

---

## How to debug effectively

1. **Run the dev build with stderr visible.** Not the installed `.app`, but `cd src-tauri && cargo run` (or `npm run tauri dev`) so `log::info!` and `console.log` are observable.
2. **Add temporary `log::info!` lines** in `open_terminal`, `register_terminal`, and `list_terminals_for_bucket`. Watch them as the user opens windows.
3. **Open the webview devtools.** In dev builds Tauri exposes a right-click → Inspect menu; in production it's gated by `tauri.conf.json`. For this debug session, flip it on temporarily so you can see DOM, computed styles, and `console.log` output.
4. **Test 3D geometry isolated.** Hard-code a single project with two terminals, see if the simpler case works before stress-testing with the user's three-project bucket.
5. **Verify the obvious first.** Confirm the running process is the new bundle (PID start time vs binary mtime). I keep forgetting and chasing fixes that never deployed.

---

## What NOT to do

- Don't `killall lexical-emerson`. The user's `claude` session is hosted inside the running app — see the memory entry.
- Don't introduce new Tab-object mutations on a `<For>` item; that caused the spawn-close-spawn PTY loop earlier in this branch.
- Don't read `props.x` inside `onCleanup`. Snapshot at mount.
- Don't add a database column or schema migration without checking `store.rs`'s migration pattern — additive only.
- Don't change the per-project view's working behavior. The per-project 3D arc view *does* work for that user; whatever's broken is workspace-specific.

---

## Suggested first step

Get the user to send you the output of:

```bash
ps -axm -o pid,start,command | grep "Lexical Emerson" | grep -v grep
stat -f "%Sm %N" "/Applications/Lexical Emerson.app/Contents/MacOS/lexical-emerson"
```

If the PID start time is **after** the binary mtime, they're on the new bundle and these bugs are real code issues. If **before**, they need to `⌘Q` and relaunch, and you should not change anything yet.

Then ask them to launch the app from a terminal (`/Applications/Lexical\ Emerson.app/Contents/MacOS/lexical-emerson`) so you can see stderr, open a project window, and report the first `info` log line. If `project_id` is `0` or `None`, you've found Bug A. From there, fix in `App.tsx` (the `projectId() ?? 0` fallback) or `TerminalsView.tsx` (defer `addTerminal` until `props.projectId > 0`).

For Bug B, after isolating, the cheapest test is to temporarily replace the 3D geometry with `display: grid` of 3 panes (no transforms) and confirm xterm renders + accepts input. If that works, the bug is in the CSS-3D path specifically.
