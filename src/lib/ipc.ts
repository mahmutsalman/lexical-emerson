import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { DirEntry, PtyDataEvent, PtyExitEvent } from "./types";

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
