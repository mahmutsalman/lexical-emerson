import { Component, onCleanup, onMount } from "solid-js";

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
}

export interface TerminalPaneProps {
  cwd: string;
  onReady?: (handle: TerminalHandle) => void;
  onActivity?: () => void;
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
  let disposed = false;

  onMount(async () => {
    term = new Terminal({
      fontFamily: '"SF Mono", "Menlo", "Monaco", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
      theme: {
        background: "#0e0e10",
        foreground: "#e8e8ea",
        cursor: "#e8e8ea",
        selectionBackground: "#2d5cc8",
      },
      allowProposedApi: true,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

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

  onCleanup(() => {
    disposed = true;
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
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
