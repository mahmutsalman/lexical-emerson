import { convertFileSrc } from "@tauri-apps/api/core";

import { resolveNoteImage } from "./ipc";

// Per-window state shared with the custom Quill image blot. Set by any
// consumer (NotesModal, ProjectNotesPanel) BEFORE calling quill.setContents
// so the blot's async src resolution uses the right project_id.
let currentProjectId: number | null = null;

export function setNoteProjectContext(projectId: number | null): void {
  currentProjectId = projectId;
}

export type QuillCtx = {
  quill: import("quill").default;
  host: HTMLDivElement;
};

let quillModulePromise: Promise<typeof import("quill").default> | null = null;
let editorCtxPromise: Promise<QuillCtx> | null = null;
let blotsRegistered = false;

async function loadQuillModule(): Promise<typeof import("quill").default> {
  if (quillModulePromise) return quillModulePromise;
  quillModulePromise = (async () => {
    await import("quill/dist/quill.snow.css");
    const Quill = (await import("quill")).default;
    if (!blotsRegistered) {
      registerNoteImageBlot(Quill);
      blotsRegistered = true;
    }
    return Quill;
  })();
  return quillModulePromise;
}

function registerNoteImageBlot(Quill: typeof import("quill").default): void {
  // Custom Image blot stores the *relative* rel-path inside the Delta
  // (e.g. "notes/<uuid>.png") so the document survives moving the app data
  // dir or sharing the DB. The actual <img src> is resolved at render time
  // via resolveNoteImage + convertFileSrc.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ImageBlot: any = Quill.import("formats/image");

  class NoteImage extends ImageBlot {
    static blotName = "image";
    static create(value: string): HTMLElement {
      const node = document.createElement("img");
      node.setAttribute("data-rel-path", value);
      node.setAttribute("src", "");
      // Capture projectId synchronously at create-time — a later context
      // switch (active project change in BucketWorkspace) must not reroute
      // an in-flight resolve to the wrong project.
      const pid = currentProjectId;
      if (pid != null) {
        resolveNoteImage(pid, value)
          .then((abs) => {
            node.src = convertFileSrc(abs);
          })
          .catch((err) => console.warn("resolve image failed:", err));
      }
      return node;
    }
    static value(node: HTMLElement): string {
      return node.getAttribute("data-rel-path") ?? "";
    }
  }

  // `true` flag tells Quill to overwrite the existing 'formats/image'
  // registration.
  Quill.register("formats/image", NoteImage, true);
}

// Returns the SHARED editable Quill instance (one per window). Used by
// NotesModal — the modal mounts/adopts a single Quill across opens to keep
// the editor warm.
export async function ensureQuill(): Promise<QuillCtx> {
  if (editorCtxPromise) return editorCtxPromise;
  editorCtxPromise = (async () => {
    const Quill = await loadQuillModule();
    const host = document.createElement("div");
    host.className = "notes-quill-host";
    const editorEl = document.createElement("div");
    host.appendChild(editorEl);

    const quill = new Quill(editorEl, {
      theme: "snow",
      placeholder: "Type your note…",
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ["bold", "italic", "underline", "strike"],
          [{ list: "ordered" }, { list: "bullet" }],
          [{ color: [] }, { background: [] }],
          ["link", "code-block", "code"],
          ["clean"],
        ],
      },
    });

    return { quill, host };
  })();
  return editorCtxPromise;
}

// Creates a FRESH read-only Quill instance bound to `host`. Used by the
// ProjectNotesPanel side rail — the rail wants its own surface, not the
// editor singleton.
export async function createReadOnlyQuill(
  host: HTMLElement,
): Promise<import("quill").default> {
  const Quill = await loadQuillModule();
  const editorEl = document.createElement("div");
  host.appendChild(editorEl);
  return new Quill(editorEl, {
    theme: "snow",
    readOnly: true,
    modules: { toolbar: false },
  });
}

// Fired from anywhere a note mutation lands so passive consumers (the side
// rail) can refresh without coupling directly to NotesModal.
export const NOTES_CHANGED_EVENT = "lexical-emerson:notes-changed";

export function notifyNotesChanged(projectId: number): void {
  window.dispatchEvent(
    new CustomEvent(NOTES_CHANGED_EVENT, { detail: { projectId } }),
  );
}
