import { Component, createEffect, onCleanup, onMount } from "solid-js";
import type { Accessor } from "solid-js";

import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  base64ToBytes,
  bytesToBase64,
  closeTerminal,
  onPtyData,
  onPtyExit,
  openTerminal,
  resizeTerminal,
  writeTerminal,
} from "../lib/ipc";

export interface TerminalHandle {
  focus: () => void;
  scrollLines: (lines: number) => void;
  // Force xterm to remeasure and resize against the current host element
  // dimensions. Use this when CSS class changes alter layout in ways that
  // ResizeObserver doesn't reliably catch (WebKit miss on display:none →
  // flex transitions, mode-toggle pane width swaps, etc.). The PTY is
  // resized along with xterm.
  fitNow: () => void;
}

export interface TerminalPaneProps {
  cwd: string;
  // If set, attach to this existing PTY instead of spawning a fresh one.
  // The Bucket Workspace uses this to render xterm instances bound to PTYs
  // that other windows (or its own + button) created.
  sessionId?: string;
  // Default behaviour depends on mode:
  //   - spawn mode (sessionId omitted):  closeOnUnmount defaults to true
  //   - attach mode (sessionId provided): closeOnUnmount defaults to false
  // The workspace can override either way: pass `closeOnUnmount={true}` for
  // workspace-owned terminals it wants to clean up on workspace close.
  closeOnUnmount?: boolean;
  // Project metadata for spawn-mode terminals. When provided AND we spawn
  // a new PTY, the Rust side atomically registers it in the global
  // terminal registry so the workspace can discover it. Optional —
  // omitting these just means the PTY won't appear in the workspace
  // unless it's registered some other way.
  projectId?: number;
  projectPath?: string;
  // Fires when this pane spawned a fresh PTY (spawn mode only). Lets the
  // parent record the session_id even though Rust already did the
  // registry write — handy for sidecar tracking in the parent.
  onSpawned?: (sessionId: string) => void;
  onReady?: (handle: TerminalHandle) => void;
  // Fired exactly once when the pane is being torn down. Lets parents
  // (specifically BucketWorkspace) prune the handle map without having to
  // diff tab arrays in the close path. Idempotent on the caller side.
  onDeregister?: () => void;
  onActivity?: () => void;
  // Per-event activity hooks used by D1 auto-suspend in TerminalsView.
  // onInput fires on every user keystroke captured by term.onData (raw,
  // not debounced — onActivity is debounced for the project-active ping).
  // onOutput fires on every PTY data chunk arriving from Rust, so the
  // parent can distinguish "idle" from "mid-response" (claude is currently
  // streaming output) when deciding whether a tab is suspendable.
  onInput?: () => void;
  onOutput?: () => void;
  zoom?: Accessor<number>;
  accent?: Accessor<string | null>;
}

const BASE_FONT_SIZE = 13;
const DEFAULT_CURSOR = "#e8e8ea";
const DEFAULT_SELECTION = "#2d5cc8";

function buildTheme(accent: string | null) {
  return {
    background: "#0e0e10",
    foreground: "#e8e8ea",
    cursor: accent ?? DEFAULT_CURSOR,
    selectionBackground: accent ?? DEFAULT_SELECTION,
  };
}

export const TerminalPane: Component<TerminalPaneProps> = (props) => {
  let hostEl!: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let sessionId: string | undefined;
  let unlistenData: UnlistenFn | undefined;
  let unlistenExit: UnlistenFn | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let resizeTimer: number | undefined;
  let zoomRefitTimer: number | undefined;
  let disposed = false;
  // Capture the "should I kill the PTY on teardown?" decision at mount
  // time. We CANNOT read it from props inside onCleanup: when a Tauri
  // window closes, Solid's props proxy is torn down faster than this
  // component's async setup finishes unwinding, and reads return
  // undefined — which made the `?? (sessionId === undefined)` fallback
  // fire for workspace-owned terminals and kill PTYs that the workspace
  // explicitly asked to keep alive. Snapshot it synchronously and read
  // the closure variable everywhere instead.
  let shouldCloseOnTeardown = false;

  onMount(async () => {
    shouldCloseOnTeardown =
      props.closeOnUnmount ?? (props.sessionId === undefined);
    const initialZoom = props.zoom?.() ?? 1;
    const initialAccent = props.accent?.() ?? null;
    term = new Terminal({
      fontFamily: '"SF Mono", "Menlo", "Monaco", monospace',
      fontSize: Math.max(8, Math.round(BASE_FONT_SIZE * initialZoom)),
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
      theme: buildTheme(initialAccent),
      allowProposedApi: true,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    // macOS shortcuts that aren't standard terminal escape sequences. xterm.js
    // doesn't know about them, so we translate them to the readline byte the
    // shell expects — same trick Terminal.app and iTerm2 use.
    //   Cmd+Backspace      → Ctrl+U (0x15)  delete to start of line
    //   Cmd+Delete (fwd)   → Ctrl+K (0x0b)  delete to end of line
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (!e.metaKey || e.ctrlKey) return true;
      let byte: string | null = null;
      if (e.key === "Backspace") byte = "\x15";
      else if (e.key === "Delete") byte = "\x0b";
      if (byte === null) return true;
      if (sessionId) {
        const bytes = new TextEncoder().encode(byte);
        writeTerminal(sessionId, bytesToBase64(bytes)).catch(() => {});
      }
      e.preventDefault();
      return false;
    });

    term.open(hostEl);

    // Always use the Canvas renderer. The WebGL renderer is faster on
    // heavy output, but xterm's WebGL <canvas> gets promoted to its own
    // GPU composited layer when nested inside ancestors with
    // `transform-style: preserve-3d` + active 3D transforms (the bucket
    // workspace's rings/cylinder/pane stack). WebKit then doesn't
    // re-composite the layer on subsequent draw calls — the user types,
    // the buffer updates, but the canvas appears frozen until a
    // `fitAddon.fit()` triggers reflow. Switching to CanvasAddon
    // sidesteps the issue entirely: the 2D canvas's drawing surface and
    // its composited layer stay in sync. Acceptable trade-off for a
    // Claude-Code launcher with moderate terminal throughput.
    try {
      term.loadAddon(new CanvasAddon());
    } catch (err) {
      console.warn("TerminalPane: canvas addon failed; falling back to DOM renderer:", err);
    }

    fitAddon.fit();
    const { cols, rows } = term;

    if (props.sessionId) {
      // Attach mode: PTY already exists; just bind to it. Resize to match
      // our local geometry so the shell wraps correctly in this window.
      sessionId = props.sessionId;
      resizeTerminal(sessionId, cols, rows).catch(() => {});
    } else {
      // Diagnostic: log the project info we're about to ship to Rust so
      // that the "registry 0" bug can be observed directly in devtools
      // (right-click → Inspect). If projectId/projectPath are undefined
      // or null here, the atomic registration in open_terminal will be
      // skipped and the workspace will never see this PTY.
      console.info("[TerminalPane] openTerminal", {
        cwd: props.cwd,
        projectId: props.projectId,
        projectPath: props.projectPath,
      });
      try {
        sessionId = await openTerminal(
          props.cwd,
          cols,
          rows,
          props.projectId,
          props.projectPath,
        );
        console.info("[TerminalPane] openTerminal OK sessionId=", sessionId);
      } catch (err) {
        term.writeln(`\r\n\x1b[31mFailed to open shell: ${err}\x1b[0m`);
        return;
      }
      if (disposed) {
        // The component was unmounted between openTerminal request and reply.
        // Only kill the just-spawned PTY if our captured policy says so —
        // workspace-owned tabs explicitly opt out so a fast click-and-close
        // doesn't murder the PTY we just registered.
        if (shouldCloseOnTeardown) {
          await closeTerminal(sessionId);
        }
        return;
      }
      props.onSpawned?.(sessionId);
    }

    const activeId = sessionId;

    unlistenData = await onPtyData((evt) => {
      if (evt.session_id !== activeId || !term) return;
      const bytes = base64ToBytes(evt.data_base64);
      // xterm.write accepts string or Uint8Array; Uint8Array is faster.
      term.write(bytes);
      props.onOutput?.();
    });

    unlistenExit = await onPtyExit((evt) => {
      if (evt.session_id !== activeId || !term) return;
      term.writeln(`\r\n\x1b[90m[shell exited: code ${evt.exit_code}]\x1b[0m`);
    });

    term.onData((data) => {
      if (!activeId) return;
      const bytes = new TextEncoder().encode(data);
      writeTerminal(activeId, bytesToBase64(bytes)).catch((err) => {
        console.error("write_terminal failed:", err);
      });
      props.onActivity?.();
      props.onInput?.();
    });

    const fitNow = () => {
      if (!term || !fitAddon || !sessionId) return;
      try {
        fitAddon.fit();
        const c = term.cols;
        const r = term.rows;
        resizeTerminal(sessionId, c, r).catch(() => {});
      } catch (err) {
        console.warn("fitNow failed:", err);
      }
    };

    props.onReady?.({
      focus: () => term?.focus(),
      scrollLines: (lines: number) => term?.scrollLines(lines),
      fitNow,
    });

    // Debounced resize via ResizeObserver on the container.
    resizeObserver = new ResizeObserver(() => {
      if (resizeTimer !== undefined) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(() => {
        if (!term || !fitAddon || !activeId) return;
        try {
          fitAddon.fit();
          const { cols, rows } = term;
          resizeTerminal(activeId, cols, rows).catch((err) => {
            console.error("resize_terminal failed:", err);
          });
        } catch (err) {
          console.warn("fit failed:", err);
        }
      }, 50);
    });
    resizeObserver.observe(hostEl);

    // Auto-focus xterm on mount, but ONLY when this pane is the visually
    // facing one (or we're outside 3D mode where every pane is its own
    // visible terminal). Without this gate, a pane that mounts inside a
    // rotated-away cylinder slot — e.g. when reconcile attaches a tab
    // spawned by another window, or when the bucket workspace boots and
    // mounts every project's tabs at once — steals keyboard focus from
    // whatever the user is currently looking at. The user then types
    // into a hidden terminal until they navigate to it and discover
    // their keystrokes parked there. See ADR planning notes
    // /Users/mahmutsalman/.claude/plans/image-2-and-also-tender-kazoo.md
    // for the failure mode.
    const closestPane = hostEl.closest(".bw-pane");
    const inThreeD = closestPane?.classList.contains("is-3d") ?? false;
    const isFacing = closestPane?.classList.contains("is-facing") ?? false;
    if (!inThreeD || isFacing) {
      term.focus();
    }
  });

  // Update xterm theme (cursor + selection bg) when the project's accent
  // changes. Reassigning options.theme triggers a redraw without disposing
  // the renderer.
  createEffect(() => {
    const accent = props.accent?.() ?? null;
    if (!term) return;
    term.options.theme = buildTheme(accent);
  });

  // Zoom signal subscription: change xterm fontSize, then debounce-refit so
  // FitAddon recomputes cols/rows for the new cell metrics. The terminal
  // subtree is excluded from WebKit's `zoom` (see app.css) so this is the
  // only path that drives the canvas size.
  createEffect(() => {
    const z = props.zoom?.() ?? 1;
    if (!term || !fitAddon) return;
    const nextSize = Math.max(8, Math.round(BASE_FONT_SIZE * z));
    if (term.options.fontSize === nextSize) return;
    term.options.fontSize = nextSize;
    if (zoomRefitTimer !== undefined) clearTimeout(zoomRefitTimer);
    zoomRefitTimer = window.setTimeout(() => {
      if (!term || !fitAddon) return;
      try {
        fitAddon.fit();
        if (sessionId) {
          resizeTerminal(sessionId, term.cols, term.rows).catch(() => {});
        }
      } catch (err) {
        console.warn("zoom refit failed:", err);
      }
    }, 60);
  });

  onCleanup(() => {
    disposed = true;
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    if (zoomRefitTimer !== undefined) clearTimeout(zoomRefitTimer);
    resizeObserver?.disconnect();
    unlistenData?.();
    unlistenExit?.();
    if (sessionId && shouldCloseOnTeardown) {
      // Decision was snapshotted at mount time so it survives Solid's
      // parent teardown — see shouldCloseOnTeardown declaration above.
      closeTerminal(sessionId).catch(() => {});
    }
    term?.dispose();
    term = undefined;
    // Notify the parent so it can drop any cached handle pointing at the
    // about-to-be-disposed pane. Wrapped in try/catch because consumer
    // code shouldn't block xterm teardown.
    try {
      props.onDeregister?.();
    } catch (err) {
      console.warn("TerminalPane onDeregister threw:", err);
    }
  });

  return <div class="xterm" ref={hostEl} />;
};
