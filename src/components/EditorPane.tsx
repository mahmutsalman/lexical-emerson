import {
  Component,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";

import { readTextFile, writeTextFile } from "../lib/ipc";

// Pick a CodeMirror language extension based on the file extension. Returns
// [] for unknown types so plain-text files still open (no highlighting).
function languageFor(path: string): Extension[] {
  const lower = path.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return [javascript({ jsx: true })];
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    case "rs":
      return [rust()];
    case "md":
    case "markdown":
      return [markdown()];
    case "json":
      return [json()];
    case "css":
      return [css()];
    case "html":
    case "htm":
      return [html()];
    case "py":
      return [python()];
    default:
      return [];
  }
}

export interface EditorPaneHandle {
  // Called by the parent when ⌘S fires on this tab. No-op if not dirty.
  save: () => Promise<void>;
  // Snapshot the current buffer — useful if we ever need an unsaved-on-close
  // prompt. Not used yet.
  getContent: () => string;
}

export interface EditorPaneProps {
  path: string;
  // Surfaces dirty/saved state up to the tab strip so a "•" can render.
  onDirtyChange?: (dirty: boolean) => void;
  // Called once on mount with a handle the parent can use to trigger save.
  onReady?: (handle: EditorPaneHandle) => void;
  // Whether this tab is currently visible. Used to decide when to focus +
  // refresh CodeMirror's layout; hidden tabs keep their state but skip work.
  isActive: () => boolean;
}

export const EditorPane: Component<EditorPaneProps> = (props) => {
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  // Track dirty against the last-saved content so undo back to the saved
  // state clears the marker correctly.
  let savedContent = "";
  let view: EditorView | null = null;
  let hostEl!: HTMLDivElement;

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const current = update.state.doc.toString();
    props.onDirtyChange?.(current !== savedContent);
  });

  const buildState = (initial: string): EditorState => {
    return EditorState.create({
      doc: initial,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorState.tabSize.of(2),
        EditorView.lineWrapping,
        oneDark,
        ...languageFor(props.path),
        updateListener,
      ],
    });
  };

  const save = async () => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === savedContent) return;
    try {
      await writeTextFile(props.path, current);
      savedContent = current;
      props.onDirtyChange?.(false);
    } catch (err) {
      console.error("write_text_file failed:", err);
      // Surface the error inline so the user knows the save didn't happen.
      // A toast layer would be nicer but is out of scope for v1.
      setLoadError(String(err));
    }
  };

  onMount(async () => {
    try {
      const file = await readTextFile(props.path);
      savedContent = file.content;
      const state = buildState(file.content);
      view = new EditorView({ state, parent: hostEl });
      setLoading(false);
      props.onReady?.({
        save,
        getContent: () => view?.state.doc.toString() ?? "",
      });
      // Defer focus so the parent's tab-activation effect doesn't fight us.
      if (props.isActive()) {
        queueMicrotask(() => view?.focus());
      }
    } catch (err) {
      setLoading(false);
      setLoadError(String(err));
    }
  });

  // When this tab becomes the active one, re-focus the editor so typing
  // lands here instead of staying with whatever held focus before the tab
  // click (often the previous editor tab or the terminal).
  createEffect(() => {
    if (props.isActive() && view) {
      queueMicrotask(() => view?.focus());
    }
  });

  onCleanup(() => {
    view?.destroy();
    view = null;
  });

  return (
    <div class="editor-pane">
      <Show when={loadError()}>
        <div class="editor-error">Failed to open file: {loadError()}</div>
      </Show>
      <Show when={loading() && !loadError()}>
        <div class="editor-loading">loading…</div>
      </Show>
      <div class="editor-host" ref={hostEl} />
    </div>
  );
};
