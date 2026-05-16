import {
  Component,
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
} from "solid-js";
import type { Accessor } from "solid-js";

import { getNote, listNotes } from "../lib/ipc";
import {
  createReadOnlyQuill,
  NOTES_CHANGED_EVENT,
  setNoteProjectContext,
} from "../lib/notes-quill";
import type { Note, NoteSummary } from "../lib/types";

interface ProjectNotesPanelProps {
  projectId: Accessor<number | null>;
  onOpenEditor: () => void;
}

function displayTitle(n: NoteSummary): string {
  if (n.user_title && n.user_title.trim().length > 0) return n.user_title;
  if (n.title && n.title.trim().length > 0) return n.title;
  return "Untitled note";
}

export const ProjectNotesPanel: Component<ProjectNotesPanelProps> = (props) => {
  const [notes, { refetch }] = createResource<NoteSummary[], number | null>(
    () => props.projectId(),
    async (pid) => (pid != null ? await listNotes(pid) : []),
  );
  const [selectedNoteId, setSelectedNoteId] = createSignal<number | null>(null);
  const [selectedNote, { refetch: refetchSelected }] = createResource<
    Note | null,
    number | null
  >(
    () => selectedNoteId(),
    async (id) => (id != null ? await getNote(id) : null),
  );
  // Quill instance lives in a signal so the render-effect below can react
  // to it landing after the async load.
  const [quill, setQuill] = createSignal<import("quill").default | null>(null);
  let previewEl!: HTMLDivElement;

  // Auto-select first note when the list arrives or invalidates the current
  // selection. Also wipes the preview when the list goes empty.
  createEffect(() => {
    const list = notes();
    const q = quill();
    if (!list || list.length === 0) {
      if (selectedNoteId() != null) setSelectedNoteId(null);
      if (q) q.setContents({ ops: [] } as never, "silent");
      return;
    }
    const curr = selectedNoteId();
    if (curr == null || !list.find((n) => n.id === curr)) {
      setSelectedNoteId(list[0].id);
    }
  });

  // Render selected note's content into the read-only Quill whenever the
  // fetched note or the active project changes. setNoteProjectContext runs
  // FIRST so any image blots created during setContents resolve against the
  // correct project_id.
  createEffect(() => {
    const q = quill();
    const note = selectedNote();
    const pid = props.projectId();
    if (!q || !note || pid == null) return;
    let delta: unknown;
    try {
      delta = JSON.parse(note.content_json);
    } catch {
      delta = { ops: [] };
    }
    setNoteProjectContext(pid);
    q.setContents(delta as never, "silent");
  });

  // Window-level notes-changed event — fired by NotesModal after any
  // mutation. Refetch the list, and if a note is selected, refetch its
  // content too (so edits to the currently-shown note land in the preview).
  const onNotesChanged = (e: Event) => {
    const detail = (e as CustomEvent<{ projectId?: number }>).detail;
    const pid = props.projectId();
    if (pid == null || detail?.projectId !== pid) return;
    refetch();
    if (selectedNoteId() != null) refetchSelected();
  };

  onMount(() => {
    void createReadOnlyQuill(previewEl).then((q) => setQuill(q));
    window.addEventListener(NOTES_CHANGED_EVENT, onNotesChanged);
  });

  onCleanup(() => {
    window.removeEventListener(NOTES_CHANGED_EVENT, onNotesChanged);
  });

  return (
    <aside class="project-notes-rail">
      <header class="pnr-header">
        <span class="pnr-title">Notes</span>
        <button
          type="button"
          class="pnr-edit"
          onClick={() => props.onOpenEditor()}
          title="Open notes editor (⌘⇧N)"
        >
          Edit
        </button>
      </header>
      <ul class="pnr-list">
        <For
          each={notes() ?? []}
          fallback={<li class="pnr-empty">No notes yet</li>}
        >
          {(n) => (
            <li
              class={`pnr-item ${n.id === selectedNoteId() ? "is-selected" : ""}`}
              onClick={() => setSelectedNoteId(n.id)}
              title={displayTitle(n)}
            >
              {displayTitle(n)}
            </li>
          )}
        </For>
      </ul>
      <div class="pnr-preview" ref={previewEl} />
    </aside>
  );
};
