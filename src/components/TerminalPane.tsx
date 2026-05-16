import { Component, createEffect, onCleanup, onMount } from "solid-js";
import type { Accessor } from "solid-js";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
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
}

export interface TerminalPaneProps {
  cwd: string;
  onReady?: (handle: TerminalHandle) => void;
  onActivity?: () => void;
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

  onMount(async () => {
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

    // WebGL renderer must be loaded AFTER open() — needs a live canvas. Falls
    // back to canvas if WebGL isn't available (e.g. missing entitlement).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("WebGL renderer unavailable; falling back to canvas:", err);
    }

    fitAddon.fit();
    const { cols, rows } = term;

    try {
      sessionId = await openTerminal(props.cwd, cols, rows);
    } catch (err) {
      term.writeln(`\r\n\x1b[31mFailed to open shell: ${err}\x1b[0m`);
      return;
    }

    if (disposed) {
      // The component was unmounted between openTerminal request and reply.
      await closeTerminal(sessionId);
      return;
    }

    const activeId = sessionId;

    unlistenData = await onPtyData((evt) => {
      if (evt.session_id !== activeId || !term) return;
      const bytes = base64ToBytes(evt.data_base64);
      // xterm.write accepts string or Uint8Array; Uint8Array is faster.
      term.write(bytes);
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
    });

    props.onReady?.({
      focus: () => term?.focus(),
      scrollLines: (lines: number) => term?.scrollLines(lines),
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

    term.focus();
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
    if (sessionId) {
      closeTerminal(sessionId).catch(() => {});
    }
    term?.dispose();
    term = undefined;
  });

  return <div class="xterm" ref={hostEl} />;
};
