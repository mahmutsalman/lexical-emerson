import {
  Component,
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import {
  bytesToBase64,
  createNote,
  deleteNote,
  listNotes,
  onMenuEvent,
  saveNoteImage,
  setNoteTitle,
  updateNote,
  getNote,
} from "../lib/ipc";
import {
  ensureQuill,
  notifyNotesChanged,
  setNoteProjectContext,
} from "../lib/notes-quill";
import type { Note, NoteSummary } from "../lib/types";

function displayTitle(n: NoteSummary): string {
  if (n.user_title && n.user_title.trim().length > 0) return n.user_title;
  if (n.title && n.title.trim().length > 0) return n.title;
  return "Untitled note";
}

interface NotesModalProps {
  projectId: number;
}

function formatRelativeTime(iso: string): string {
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC. Parsing
  // requires the explicit "T" and "Z" so Date doesn't fall back to local
  // time interpretation.
  const parsed = new Date(iso.replace(" ", "T") + "Z");
  const ms = Date.now() - parsed.getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return parsed.toLocaleDateString();
}

export const NotesModal: Component<NotesModalProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<number | null>(null);
  const [loadingEditor, setLoadingEditor] = createSignal(false);
  const [titleInput, setTitleInput] = createSignal("");
  // Image lightbox state — null when closed, otherwise the absolute asset
  // URL to render at full size over the modal.
  const [lightboxSrc, setLightboxSrc] = createSignal<string | null>(null);
  // Dirty-state tracking. Independent generation counters per persistable
  // field — combined dirty = either is ahead of its saved generation. Using
  // counters (not booleans) avoids race conditions where a save callback
  // would otherwise overwrite dirty=true caused by a change that arrived
  // during the in-flight RPC.
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let contentGen = 0;
  let contentSavedGen = 0;
  let titleGen = 0;
  let titleSavedGen = 0;
  const refreshDirty = () =>
    setDirty(contentGen > contentSavedGen || titleGen > titleSavedGen);
  const resetGens = () => {
    contentGen = 0;
    contentSavedGen = 0;
    titleGen = 0;
    titleSavedGen = 0;
    refreshDirty();
  };

  const [notes, { mutate, refetch }] = createResource<NoteSummary[], number>(
    () => props.projectId,
    (pid) => listNotes(pid),
  );

  // Tracks which note is currently loaded into Quill. Kept off-signal to
  // avoid Solid effects firing on every keystroke.
  let loadedNoteId: number | null = null;
  let saveTimer: number | undefined;
  // Set by the synchronous `lexical:notes-open-hint` window event that
  // BucketWorkspace dispatches right before emitting `menu://notes-open`
  // when a user double-clicks a specific note in the 3D bucket view.
  // Consumed (and cleared) by the notes-open handler below.
  let pendingOpenNoteId: number | null = null;
  let titleSaveTimer: number | undefined;
  let editorSlot: HTMLDivElement | undefined;
  let textChangeHandler: ((delta: unknown, oldDelta: unknown, source: string) => void) | null = null;

  const onTextChange = (_delta: unknown, _oldDelta: unknown, source: string) => {
    if (source === "silent" || source === "api") return;
    if (loadedNoteId == null) return;
    contentGen++;
    refreshDirty();
    const idToSave = loadedNoteId;
    const issuedGen = contentGen;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      // CRITICAL: if the user switched notes during the 400 ms window, this
      // stale timer would otherwise read the NEW note's content from Quill
      // and save it to the OLD note id — corrupting the old note. Abort if
      // loadedNoteId no longer matches what we scheduled for. The
      // flushPendingSaves() call inside selectNote handles persisting the
      // old note's pending changes correctly.
      if (loadedNoteId !== idToSave) return;
      try {
        const ctx = await ensureQuill();
        const content = JSON.stringify(ctx.quill.getContents());
        const summary = await updateNote(idToSave, content);
        mutate((curr) => {
          if (!curr) return curr;
          const filtered = curr.filter((n) => n.id !== summary.id);
          return [summary, ...filtered];
        });
        if (issuedGen > contentSavedGen) contentSavedGen = issuedGen;
        refreshDirty();
        notifyNotesChanged(props.projectId);
      } catch (err) {
        console.error("updateNote failed:", err);
      }
    }, 400);
  };

  const loadNoteIntoEditor = async (noteId: number) => {
    // Set loadedNoteId to null FIRST so any in-flight auto-save bails out
    // via its `loadedNoteId !== idToSave` guard instead of writing the new
    // note's content over the old note. flushPendingSaves() should have
    // already run before us (called from selectNote / newNote), so anything
    // dirty has been persisted.
    loadedNoteId = null;
    setLoadingEditor(true);
    try {
      const ctx = await ensureQuill();
      const note = await getNote(noteId);
      let delta: unknown;
      try {
        delta = JSON.parse(note.content_json);
      } catch {
        delta = { ops: [] };
      }
      // setContents with 'silent' suppresses text-change so the load itself
      // doesn't trigger a pointless save.
      ctx.quill.setContents(delta as never, "silent");
      setTitleInput(note.user_title ?? "");
      loadedNoteId = noteId;
      // Fresh note loaded — reset the dirty tracker so the Save button
      // starts clean even though setContents bumped Quill internals.
      resetGens();
    } catch (err) {
      console.error("getNote failed:", err);
    } finally {
      setLoadingEditor(false);
    }
  };

  const onTitleInput = (e: InputEvent & { currentTarget: HTMLInputElement }) => {
    const value = e.currentTarget.value;
    setTitleInput(value);
    if (loadedNoteId == null) return;
    titleGen++;
    refreshDirty();
    const idToSave = loadedNoteId;
    const issuedGen = titleGen;
    window.clearTimeout(titleSaveTimer);
    titleSaveTimer = window.setTimeout(async () => {
      // Same stale-write guard as the content auto-save.
      if (loadedNoteId !== idToSave) return;
      try {
        const summary = await setNoteTitle(
          idToSave,
          value.trim().length > 0 ? value : null,
        );
        mutate((curr) => {
          if (!curr) return curr;
          const filtered = curr.filter((n) => n.id !== summary.id);
          return [summary, ...filtered];
        });
        if (issuedGen > titleSavedGen) titleSavedGen = issuedGen;
        refreshDirty();
        notifyNotesChanged(props.projectId);
      } catch (err) {
        console.error("setNoteTitle failed:", err);
      }
    }, 400);
  };

  // Persist any pending changes to the CURRENTLY-loaded note immediately,
  // bypassing the 400 ms debounce. Called before anything that would change
  // what Quill is showing — note switch, modal close, note delete. Without
  // this, the debounced timers either get cancelled (close → silent data
  // loss) or fire against the wrong note (switch → content corruption).
  const flushPendingSaves = async (): Promise<void> => {
    if (loadedNoteId == null) return;
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    window.clearTimeout(titleSaveTimer);
    titleSaveTimer = undefined;
    const idToFlush = loadedNoteId;
    const cGen = contentGen;
    const tGen = titleGen;
    if (cGen <= contentSavedGen && tGen <= titleSavedGen) return;
    try {
      const tasks: Promise<NoteSummary | undefined>[] = [];
      if (cGen > contentSavedGen) {
        const ctx = await ensureQuill();
        const content = JSON.stringify(ctx.quill.getContents());
        tasks.push(updateNote(idToFlush, content));
      }
      if (tGen > titleSavedGen) {
        const value = titleInput();
        tasks.push(
          setNoteTitle(idToFlush, value.trim().length > 0 ? value : null),
        );
      }
      const summaries = (await Promise.all(tasks)).filter(
        (s): s is NoteSummary => s != null,
      );
      const latest = summaries[summaries.length - 1];
      if (latest) {
        mutate((curr) => {
          if (!curr) return curr;
          const filtered = curr.filter((n) => n.id !== latest.id);
          return [latest, ...filtered];
        });
      }
      if (cGen > contentSavedGen) contentSavedGen = cGen;
      if (tGen > titleSavedGen) titleSavedGen = tGen;
      refreshDirty();
      if (latest) notifyNotesChanged(props.projectId);
    } catch (err) {
      console.error("flushPendingSaves failed:", err);
    }
  };

  // Manual save — cancels any pending debounced saves and flushes both
  // content and title in parallel. Snapshot the generations BEFORE the
  // RPCs so we don't clobber dirty state caused by a change that arrives
  // mid-flight.
  const saveNow = async () => {
    if (loadedNoteId == null) return;
    if (saving()) return;
    window.clearTimeout(saveTimer);
    window.clearTimeout(titleSaveTimer);
    const idToSave = loadedNoteId;
    const cGen = contentGen;
    const tGen = titleGen;
    setSaving(true);
    try {
      const tasks: Promise<NoteSummary | undefined>[] = [];
      if (cGen > contentSavedGen) {
        const ctx = await ensureQuill();
        const content = JSON.stringify(ctx.quill.getContents());
        tasks.push(updateNote(idToSave, content));
      }
      if (tGen > titleSavedGen) {
        const value = titleInput();
        tasks.push(
          setNoteTitle(idToSave, value.trim().length > 0 ? value : null),
        );
      }
      const summaries = (await Promise.all(tasks)).filter(
        (s): s is NoteSummary => s != null,
      );
      // Apply the freshest summary to the list (the title save bumps
      // updated_at after the content save in rare cases — pick the last).
      const latest = summaries[summaries.length - 1];
      if (latest) {
        mutate((curr) => {
          if (!curr) return curr;
          const filtered = curr.filter((n) => n.id !== latest.id);
          return [latest, ...filtered];
        });
      }
      if (cGen > contentSavedGen) contentSavedGen = cGen;
      if (tGen > titleSavedGen) titleSavedGen = tGen;
      refreshDirty();
      if (latest) notifyNotesChanged(props.projectId);
    } catch (err) {
      console.error("saveNow failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const selectNote = async (noteId: number) => {
    if (loadedNoteId === noteId) return;
    // Flush whatever's dirty on the OUTGOING note before swapping content,
    // so we never lose typed text just because the user clicked away.
    await flushPendingSaves();
    setSelectedId(noteId);
    await loadNoteIntoEditor(noteId);
  };

  const newNote = async () => {
    try {
      // Same reason as selectNote: any unsaved typing on the previously
      // loaded note must land before we create + select a new one.
      await flushPendingSaves();
      const note: Note = await createNote(props.projectId);
      mutate((curr) => [
        {
          id: note.id,
          project_id: note.project_id,
          title: note.title,
          user_title: note.user_title,
          updated_at: note.updated_at,
        },
        ...(curr ?? []),
      ]);
      notifyNotesChanged(props.projectId);
      await selectNote(note.id);
    } catch (err) {
      console.error("createNote failed:", err);
    }
  };

  const removeNote = async (noteId: number) => {
    if (!window.confirm("Delete this note? This cannot be undone.")) return;
    try {
      // Flush BEFORE deleting. If the user typed into a different note and
      // then deleted it, we still want the typed content saved. If they
      // typed into the same note they're deleting, flushing is wasted work
      // but harmless (the row is gone moments later).
      if (loadedNoteId != null && loadedNoteId !== noteId) {
        await flushPendingSaves();
      } else {
        // Same note: just cancel pending timers; the row is about to vanish.
        window.clearTimeout(saveTimer);
        saveTimer = undefined;
        window.clearTimeout(titleSaveTimer);
        titleSaveTimer = undefined;
      }
      await deleteNote(noteId);
      mutate((curr) => (curr ? curr.filter((n) => n.id !== noteId) : curr));
      notifyNotesChanged(props.projectId);
      if (selectedId() === noteId) {
        setSelectedId(null);
        loadedNoteId = null;
        setTitleInput("");
        const ctx = await ensureQuill();
        ctx.quill.setContents({ ops: [] } as never, "silent");
        resetGens();
      }
    } catch (err) {
      console.error("deleteNote failed:", err);
    }
  };

  const close = async () => {
    // Flush before hiding. The previous version cleared the timers without
    // running them, which silently dropped any sub-400 ms typing — that
    // was the root cause of disappearing notes on Esc-then-reopen.
    await flushPendingSaves();
    setLightboxSrc(null);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (lightboxSrc() != null) {
        setLightboxSrc(null);
        return;
      }
      void close();
    } else if ((e.key === "n" || e.key === "N") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void newNote();
    } else if ((e.key === "s" || e.key === "S") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void saveNow();
    }
  };

  // Listen for Esc / ⌘N / ⌘S at the WINDOW level whenever the modal is
  // open. The previous design attached `onKeyDown` only to the overlay
  // div, which meant the handler only fired if the keydown bubbled up
  // THROUGH the overlay. When the modal opens via the Enter-to-focus
  // gesture in the 3D bucket workspace, the focus is on the workspace
  // window's body (xterm was blurred on navigate, the overlay never
  // received programmatic focus), so Esc never bubbled through the
  // overlay and the close-on-Esc affordance silently broke.
  // Belt-and-suspenders: leave the overlay's onKeyDown wired too so
  // Esc from within the editor still closes via the same handler.
  createEffect(() => {
    if (!open()) return;
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  // Delegated click handler — opens the lightbox when an inline image
  // thumbnail inside the Quill editor is clicked. The src attribute holds
  // the convertFileSrc()-resolved URL, set by our custom NoteImage blot.
  const onEditorClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.tagName !== "IMG") return;
    if (!target.closest(".ql-editor")) return;
    const img = target as HTMLImageElement;
    if (!img.src) return;
    e.preventDefault();
    e.stopPropagation();
    setLightboxSrc(img.src);
  };

  const onPaste = async (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    // Use clipboardData.files, NOT clipboardData.items. macOS puts a single
    // screenshot on the clipboard in several MIME representations (image/png
    // AND image/jpeg AND image/tiff…) — iterating items would treat each as
    // a distinct paste and save the same image 3-4 times. .files collapses
    // representations to one entry per logical file.
    const files = Array.from(e.clipboardData.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();

    if (loadedNoteId == null) {
      // No note selected — create one on the fly so pasted images have
      // somewhere to live.
      await newNote();
      if (loadedNoteId == null) return;
    }

    const ctx = await ensureQuill();
    for (const file of files) {
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        if (buf.byteLength > 20 * 1024 * 1024) {
          console.warn(`pasted image is ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB — large`);
        }
        const b64 = bytesToBase64(buf);
        const ext = (file.type.split("/")[1] ?? "png").toLowerCase();
        const relPath = await saveNoteImage(props.projectId, b64, ext);
        const range = ctx.quill.getSelection(true) ?? {
          index: ctx.quill.getLength() - 1,
          length: 0,
        };
        ctx.quill.insertEmbed(range.index, "image", relPath, "user");
        // Caption line: italic prompt below the image. Plain text — click
        // to edit. A bespoke captioned-image blot is deferred to v2.
        ctx.quill.insertText(range.index + 1, "\n", "user");
        ctx.quill.insertText(
          range.index + 2,
          "caption",
          { italic: true },
          "user",
        );
        ctx.quill.setSelection(range.index + 2 + "caption".length, 0, "user");
      } catch (err) {
        console.error("paste image failed:", err);
      }
    }
  };

  const onNotesOpenHint = (e: Event) => {
    const detail = (e as CustomEvent<{ noteId?: number }>).detail;
    if (detail?.noteId != null) pendingOpenNoteId = detail.noteId;
  };

  onMount(async () => {
    window.addEventListener("lexical:notes-open-hint", onNotesOpenHint);
    const unlisten = await onMenuEvent("notes-open", async () => {
      setNoteProjectContext(props.projectId);
      setOpen(true);
      // Refetch list every time we open so we reflect any rust-side changes.
      refetch();
      // Warm Quill in parallel so the editor pane is usable ASAP.
      const ctx = await ensureQuill();
      // Adopt the persistent host element into the live modal slot.
      if (editorSlot && ctx.host.parentElement !== editorSlot) {
        editorSlot.appendChild(ctx.host);
      }
      // Wire text-change, paste and image-click exactly once.
      if (!textChangeHandler) {
        textChangeHandler = onTextChange;
        ctx.quill.on("text-change", textChangeHandler);
        ctx.quill.root.addEventListener("paste", onPaste, { capture: true });
        ctx.quill.root.addEventListener("click", onEditorClick);
      }
      // Prefer the caller-supplied note id (e.g. double-click in the 3D
      // bucket notes panel); fall back to the most recently updated note.
      // Leave the editor blank with a clear "press + to create" cue if
      // there are no notes at all.
      const list = notes() ?? (await listNotes(props.projectId));
      const hinted = pendingOpenNoteId;
      pendingOpenNoteId = null;
      const target =
        hinted != null && list.some((n) => n.id === hinted)
          ? hinted
          : list.length > 0
            ? list[0].id
            : null;
      if (target != null) {
        selectNote(target);
      } else {
        loadedNoteId = null;
        ctx.quill.setContents({ ops: [] } as never, "silent");
      }
    });
    onCleanup(unlisten);
  });

  onCleanup(() => {
    window.clearTimeout(saveTimer);
    window.clearTimeout(titleSaveTimer);
    window.removeEventListener("lexical:notes-open-hint", onNotesOpenHint);
    if (textChangeHandler) {
      // The Quill instance lives across modal lifetimes; only remove the
      // listener when the modal component itself is being torn down.
      ensureQuill()
        .then((ctx) => {
          if (textChangeHandler) ctx.quill.off("text-change", textChangeHandler);
          ctx.quill.root.removeEventListener("paste", onPaste, { capture: true });
          ctx.quill.root.removeEventListener("click", onEditorClick);
        })
        .catch(() => {});
    }
  });

  return (
    <Show when={open()}>
      <div
        class="notes-overlay"
        onClick={close}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        <div class="notes-modal" onClick={(e) => e.stopPropagation()}>
          <div class="notes-list-panel">
            <div class="notes-list-header">
              <span>Notes</span>
              <button class="notes-new-btn" onClick={newNote} title="New note (⌘N)">
                +
              </button>
            </div>
            <div class="notes-list">
              <For
                each={notes() ?? []}
                fallback={
                  <div class="notes-empty">
                    No notes yet — press <kbd>+</kbd> to create one.
                  </div>
                }
              >
                {(n) => (
                  <div
                    class={`notes-list-item ${
                      selectedId() === n.id ? "selected" : ""
                    }`}
                    onClick={() => selectNote(n.id)}
                  >
                    <div class="notes-list-item-title">{displayTitle(n)}</div>
                    <div class="notes-list-item-meta">
                      {formatRelativeTime(n.updated_at)}
                    </div>
                    <button
                      class="notes-delete-btn"
                      title="Delete note"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeNote(n.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
              </For>
            </div>
          </div>
          <div class="notes-editor-panel">
            <Show when={selectedId() != null}>
              <div class="notes-title-row">
                <input
                  class="notes-title-input"
                  type="text"
                  placeholder="Title…"
                  value={titleInput()}
                  onInput={(e) => onTitleInput(e as unknown as InputEvent & {
                    currentTarget: HTMLInputElement;
                  })}
                />
                <button
                  class="notes-save-btn"
                  classList={{
                    dirty: dirty(),
                    saving: saving(),
                  }}
                  onClick={() => void saveNow()}
                  disabled={saving() || (!dirty() && !saving())}
                  title={
                    saving()
                      ? "Saving…"
                      : dirty()
                        ? "Save changes (⌘S)"
                        : "All changes saved"
                  }
                >
                  {saving() ? "Saving…" : dirty() ? "Save" : "Saved"}
                </button>
              </div>
            </Show>
            {/* The slot is ALWAYS rendered so its ref is bound the moment
                the modal opens. The Quill host gets adopted into this div on
                first open and stays put. When no note is selected, we just
                overlay the placeholder visually. */}
            <div
              class="notes-editor-slot"
              ref={editorSlot}
              style={{ display: selectedId() != null ? "flex" : "none" }}
            />
            <Show when={selectedId() == null}>
              <div class="notes-editor-placeholder">
                {loadingEditor() ? "Loading editor…" : "Select or create a note."}
              </div>
            </Show>
          </div>
          <div class="notes-hint">
            <kbd>⌘N</kbd> new · <kbd>⌘S</kbd> save · <kbd>esc</kbd> close · paste images, click thumbnails to zoom
          </div>
        </div>

        <Show when={lightboxSrc()}>
          {(src) => (
            <div
              class="notes-lightbox"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxSrc(null);
              }}
            >
              <img src={src()} alt="" />
              <div class="notes-lightbox-hint">click anywhere or <kbd>esc</kbd> to close</div>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
};
