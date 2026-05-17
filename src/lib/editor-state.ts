import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";

import type { EditorPaneHandle } from "../components/EditorPane";

// One open file in the unified tab strip. `id` is opaque and stable for the
// tab's lifetime — dirty / handle are tracked in sidecar maps on the store
// so mutating them never invalidates the OpenFile reference (and never
// remounts the EditorPane via Solid's <For> reference equality).
export interface OpenFile {
  id: string;
  path: string;
}

let editorTabCounter = 0;
const newEditorTabId = () => `editor-${++editorTabCounter}`;

export interface EditorState {
  files: Accessor<OpenFile[]>;
  // null = no editor visible (terminal view is showing instead).
  activeId: Accessor<string | null>;
  dirty: Accessor<Record<string, boolean>>;
  open: (path: string) => string;
  close: (id: string) => void;
  setActive: (id: string | null) => void;
  setDirty: (id: string, isDirty: boolean) => void;
  setHandle: (id: string, handle: EditorPaneHandle | null) => void;
  saveActive: () => Promise<void>;
}

export function createEditorState(): EditorState {
  const [files, setFiles] = createSignal<OpenFile[]>([]);
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal<Record<string, boolean>>({});
  const handles = new Map<string, EditorPaneHandle>();

  const open = (path: string): string => {
    const existing = files().find((f) => f.path === path);
    if (existing) {
      setActiveId(existing.id);
      return existing.id;
    }
    const file: OpenFile = { id: newEditorTabId(), path };
    setFiles((prev) => [...prev, file]);
    setActiveId(file.id);
    return file.id;
  };

  const close = (id: string) => {
    handles.delete(id);
    setDirty((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setFiles((prev) => prev.filter((f) => f.id !== id));
    if (activeId() === id) {
      // Closed the visible editor → fall back to terminal view. The
      // consumer (TerminalsView) reacts by hiding the editor stack.
      setActiveId(null);
    }
  };

  const setActive = (id: string | null) => setActiveId(id);

  const setDirtyFor = (id: string, isDirty: boolean) => {
    setDirty((prev) => {
      if ((prev[id] ?? false) === isDirty) return prev;
      return { ...prev, [id]: isDirty };
    });
  };

  const setHandle = (id: string, handle: EditorPaneHandle | null) => {
    if (handle) handles.set(id, handle);
    else handles.delete(id);
  };

  const saveActive = async () => {
    const id = activeId();
    if (!id) return;
    await handles.get(id)?.save();
  };

  return {
    files,
    activeId,
    dirty,
    open,
    close,
    setActive,
    setDirty: setDirtyFor,
    setHandle,
    saveActive,
  };
}
