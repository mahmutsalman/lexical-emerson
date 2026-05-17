import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import type {
  Bucket,
  DirEntry,
  Note,
  NoteSummary,
  PersistedTerminal,
  Project,
  PtyDataEvent,
  PtyExitEvent,
  PtyTerminalInfo,
} from "./types";

export async function pickFolder(): Promise<string | null> {
  return await invoke<string | null>("pick_folder");
}

export async function listDirectory(
  path: string,
  showHidden = false,
): Promise<DirEntry[]> {
  return await invoke<DirEntry[]>("list_directory", { path, showHidden });
}

export async function openTerminal(
  cwd: string,
  cols: number,
  rows: number,
  projectId?: number,
  projectPath?: string,
): Promise<string> {
  return await invoke<string>("open_terminal", {
    cwd,
    cols,
    rows,
    projectId: projectId ?? null,
    projectPath: projectPath ?? null,
  });
}

export async function writeTerminal(
  sessionId: string,
  dataBase64: string,
): Promise<void> {
  await invoke("write_terminal", { sessionId, dataBase64 });
}

export async function resizeTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("resize_terminal", { sessionId, cols, rows });
}

export async function closeTerminal(sessionId: string): Promise<void> {
  await invoke("close_terminal", { sessionId });
}

export async function onPtyData(
  cb: (e: PtyDataEvent) => void,
): Promise<UnlistenFn> {
  return await listen<PtyDataEvent>("pty://data", (event) => cb(event.payload));
}

export async function onPtyExit(
  cb: (e: PtyExitEvent) => void,
): Promise<UnlistenFn> {
  return await listen<PtyExitEvent>("pty://exit", (event) => cb(event.payload));
}

// --- project persistence ---------------------------------------------------

export async function openProject(path: string): Promise<Project> {
  return await invoke<Project>("open_project", { path });
}

export async function listRecents(): Promise<Project[]> {
  return await invoke<Project[]>("list_recents");
}

export async function markActive(path: string): Promise<void> {
  await invoke("mark_active", { path });
}

export async function lastProject(): Promise<Project | null> {
  return await invoke<Project | null>("last_project");
}

export async function getProjectById(id: number): Promise<Project | null> {
  return await invoke<Project | null>("get_project_by_id", { id });
}

export async function markFocused(path: string): Promise<void> {
  await invoke("mark_focused", { path });
}

export async function setProjectColor(
  id: number,
  color: string | null,
): Promise<Project> {
  return await invoke<Project>("set_project_color", { id, color });
}

export async function setProjectZoom(
  id: number,
  zoom: number,
): Promise<Project> {
  return await invoke<Project>("set_project_zoom", { id, zoom });
}

export async function getGlobalZoom(): Promise<number | null> {
  return await invoke<number | null>("get_global_zoom");
}

export async function setGlobalZoom(zoom: number): Promise<number> {
  return await invoke<number>("set_global_zoom", { zoom });
}

export async function hideProject(id: number): Promise<void> {
  await invoke("hide_project", { id });
}

export async function revealInFinder(path: string): Promise<void> {
  await invoke("reveal_in_finder", { path });
}

export async function requestOpenProject(path: string): Promise<Project> {
  return await invoke<Project>("request_open_project", { path });
}

export async function currentWindowLabel(): Promise<string> {
  return await invoke<string>("current_window_label");
}

// Tells Rust which project the MAIN launcher window is currently showing
// (null = no project). Used by spawn_or_focus_project_window so we never
// open the same project in two windows.
export async function setMainProject(projectId: number | null): Promise<void> {
  await invoke("set_main_project", { projectId });
}

// --- buckets ---------------------------------------------------------------

export async function listBuckets(): Promise<Bucket[]> {
  return await invoke<Bucket[]>("list_buckets");
}

export async function createBucket(name: string): Promise<Bucket> {
  return await invoke<Bucket>("create_bucket", { name });
}

export async function deleteBucket(id: number): Promise<void> {
  await invoke("delete_bucket", { id });
}

export async function renameBucket(id: number, name: string): Promise<void> {
  await invoke("rename_bucket", { id, name });
}

export async function addToBucket(
  bucketId: number,
  projectId: number,
): Promise<void> {
  await invoke("add_to_bucket", { bucketId, projectId });
}

export async function removeFromBucket(
  bucketId: number,
  projectId: number,
): Promise<void> {
  await invoke("remove_from_bucket", { bucketId, projectId });
}

// Rewrite the bucket's project order in one go. `projectIds` must be the
// full membership of the bucket in the desired order; partial slices
// would leave the omitted projects with stale positions.
export async function reorderBucketProjects(
  bucketId: number,
  projectIds: number[],
): Promise<void> {
  await invoke("reorder_bucket_projects", { bucketId, projectIds });
}

// Make `bucketId` the active bucket AND point its cursor at the given
// project. Fired alongside requestOpenProject when the user clicks a
// project row inside an expanded bucket — the project window opens AND
// the bucket's `at-cursor` highlight follows the click.
export async function setBucketCursorToProject(
  bucketId: number,
  projectId: number,
): Promise<void> {
  await invoke("set_bucket_cursor_to_project", { bucketId, projectId });
}

export async function setActiveBucket(id: number | null): Promise<void> {
  await invoke("set_active_bucket", { id });
}

export async function getActiveBucket(): Promise<number | null> {
  return await invoke<number | null>("get_active_bucket");
}

export async function cycleBucket(direction: 1 | -1): Promise<Project | null> {
  return await invoke<Project | null>("cycle_bucket", { direction });
}

export async function onBucketsChanged(cb: () => void): Promise<UnlistenFn> {
  return await listen<void>("buckets://changed", () => cb());
}

// --- terminal registry & bucket workspace ----------------------------------

export async function registerTerminal(
  ptyId: string,
  projectId: number,
  projectPath: string,
  title: string | null,
): Promise<void> {
  await invoke("register_terminal", {
    ptyId,
    projectId,
    projectPath,
    title,
  });
}

export async function unregisterTerminal(ptyId: string): Promise<void> {
  await invoke("unregister_terminal", { ptyId });
}

export async function listTerminalsForBucket(
  bucketId: number,
): Promise<PtyTerminalInfo[]> {
  return await invoke<PtyTerminalInfo[]>("list_terminals_for_bucket", {
    bucketId,
  });
}

export async function listAllRegisteredTerminals(): Promise<PtyTerminalInfo[]> {
  return await invoke<PtyTerminalInfo[]>("list_all_registered_terminals");
}

export async function rescanTerminals(): Promise<void> {
  await invoke("rescan_terminals");
}

export async function onRescanRequest(cb: () => void): Promise<UnlistenFn> {
  return await listen<void>("terminals://rescan-request", () => cb());
}

export async function spawnBucket3DWorkspace(bucketId: number): Promise<void> {
  await invoke("spawn_bucket_3d_workspace", { bucketId });
}

// Debug helper exposed in the workspace's diagnostic panel. Inserts a
// fake entry directly into pty_registry — bypasses the spawn path so we
// can verify the read path (list_all_registered_terminals) and the
// terminals://changed broadcast still work end-to-end.
export async function debugInsertFakeRegistryEntry(
  projectId: number,
  projectPath: string,
): Promise<string> {
  return await invoke<string>("debug_insert_fake_registry_entry", {
    projectId,
    projectPath,
  });
}

export async function onTerminalsChanged(cb: () => void): Promise<UnlistenFn> {
  return await listen<void>("terminals://changed", () => cb());
}

// --- session restore -------------------------------------------------------

export async function setBucketAutoRestore(
  bucketId: number,
  enabled: boolean,
): Promise<void> {
  await invoke("set_bucket_auto_restore", { bucketId, enabled });
}

// Snapshot the current ordered list of terminal cwds for `projectId`. Rust
// detects the Claude session UUID per cwd, applies the bucket-gate, and
// writes one row per Claude-running tab. No process is kept alive across
// the call — the PTYs are still torn down by TerminalPane's onCleanup.
export async function persistProjectTerminals(
  projectId: number,
  cwds: string[],
): Promise<void> {
  await invoke("persist_project_terminals", { projectId, cwds });
}

export async function listPersistedTerminals(
  projectId: number,
): Promise<PersistedTerminal[]> {
  return await invoke<PersistedTerminal[]>("list_persisted_terminals", {
    projectId,
  });
}

export async function deletePersistedTerminalsForProject(
  projectId: number,
): Promise<void> {
  await invoke("delete_persisted_terminals_for_project", { projectId });
}

// Distinct project ids with persisted terminal rows. Currently unused
// by UI code — restore is driven per-bucket via
// `loadActiveClaudeSessionsForBucket`. Kept here for diagnostic use.
export async function listPersistedProjectIds(): Promise<number[]> {
  return await invoke<number[]>("list_persisted_project_ids");
}

// Right-click → "Load active Claude sessions" action. Spawns project
// windows for every project in this bucket that has a persisted
// terminal row. Each spawned window's TerminalsView then runs
// `claude --resume <uuid>` on its own. Returns count of windows opened.
export async function loadActiveClaudeSessionsForBucket(
  bucketId: number,
): Promise<number> {
  return await invoke<number>("load_active_claude_sessions_for_bucket", {
    bucketId,
  });
}

// --- notes -----------------------------------------------------------------

export async function listNotes(projectId: number): Promise<NoteSummary[]> {
  return await invoke<NoteSummary[]>("list_notes", { projectId });
}

export async function getNote(id: number): Promise<Note> {
  return await invoke<Note>("get_note", { id });
}

export async function createNote(projectId: number): Promise<Note> {
  return await invoke<Note>("create_note", { projectId });
}

export async function updateNote(
  id: number,
  contentJson: string,
): Promise<NoteSummary> {
  return await invoke<NoteSummary>("update_note", { id, contentJson });
}

export async function deleteNote(id: number): Promise<void> {
  await invoke("delete_note", { id });
}

export async function setNoteTitle(
  id: number,
  userTitle: string | null,
): Promise<NoteSummary> {
  return await invoke<NoteSummary>("set_note_title", { id, userTitle });
}

export async function saveNoteImage(
  projectId: number,
  dataBase64: string,
  ext: string,
): Promise<string> {
  return await invoke<string>("save_note_image", {
    projectId,
    dataBase64,
    ext,
  });
}

export async function resolveNoteImage(
  projectId: number,
  relPath: string,
): Promise<string> {
  return await invoke<string>("resolve_note_image", { projectId, relPath });
}

// --- menu events -----------------------------------------------------------

export type MenuEventId =
  | "terminal-new"
  | "terminal-close"
  | "terminal-next"
  | "terminal-prev"
  | "terminal-toggle-3d"
  | "quick-switcher"
  | "bucket-next"
  | "bucket-prev"
  | "bucket-new"
  | "notes-open"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "file-open-folder"
  | "bucket-3d-ring-prev"
  | "bucket-3d-ring-next";

export async function onMenuEvent(
  id: MenuEventId,
  cb: () => void,
): Promise<UnlistenFn> {
  // Scope to the current webview window. The Rust side emits with
  // EventTarget::WebviewWindow { label } — but the default `listen(...)` from
  // @tauri-apps/api/event uses target=Any, which is a wildcard that catches
  // every emit regardless of target. Using the WebviewWindow instance's own
  // .listen() registers a target-scoped listener so only the focused window
  // reacts. See plan: "Active fix — M3: menu events still fire in every window".
  return await getCurrentWebviewWindow().listen<void>(`menu://${id}`, () => cb());
}

/**
 * Emit a menu-event so only the CURRENT window receives it.
 *
 * `WebviewWindow.emit()` is a global broadcast in Tauri v2 — its target
 * is `Any`, which bypasses the per-window filter that
 * `WebviewWindow.listen()` applies. That meant clicking a note in one
 * window's NotesPanel would also pop the notes modal in every other
 * window that had a NotesModal mounted.
 *
 * `emitTo` with a TYPED target object is the right primitive. We pass
 * the explicit `{ kind: "WebviewWindow", label }` shape because:
 * - `emitTo(stringLabel, ...)` shorthand constructs
 *   `{ kind: "AnyLabel", label }` — a different EventTarget kind.
 * - `WebviewWindow.listen()` registers with
 *   `{ kind: "WebviewWindow", label: this.label }`.
 * - Tauri's runtime treats `AnyLabel` and `WebviewWindow` as DISTINCT
 *   target kinds and won't deliver across them. So the string form
 *   silently drops the event on the floor.
 *
 * Use the explicit object so the kinds match and the listener fires.
 */
export async function emitMenuEventLocal(
  id: MenuEventId,
  payload?: unknown,
): Promise<void> {
  const w = getCurrentWebviewWindow();
  await w.emitTo(
    { kind: "WebviewWindow", label: w.label },
    `menu://${id}`,
    payload,
  );
}

// --- base64 helpers --------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8ToBase64(s: string): string {
  return bytesToBase64(encoder.encode(s));
}

export function base64ToUtf8(b: string): string {
  return decoder.decode(base64ToBytes(b));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
