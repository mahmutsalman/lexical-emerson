import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import type {
  Bucket,
  DirEntry,
  Project,
  PtyDataEvent,
  PtyExitEvent,
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
): Promise<string> {
  return await invoke<string>("open_terminal", { cwd, cols, rows });
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

export async function requestOpenProject(path: string): Promise<Project> {
  return await invoke<Project>("request_open_project", { path });
}

export async function currentWindowLabel(): Promise<string> {
  return await invoke<string>("current_window_label");
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

// --- menu events -----------------------------------------------------------

export async function onMenuEvent(
  id:
    | "terminal-new"
    | "terminal-close"
    | "terminal-next"
    | "terminal-prev"
    | "quick-switcher"
    | "bucket-next"
    | "bucket-prev"
    | "bucket-new",
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
