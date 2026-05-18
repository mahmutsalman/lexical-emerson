export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
}

export interface PtyDataEvent {
  session_id: string;
  data_base64: string;
}

export interface PtyExitEvent {
  session_id: string;
  exit_code: number;
}

export interface Project {
  id: number;
  path: string;
  name: string;
  last_focused_at: string | null;
  last_active_at: string | null;
  color: string | null;
  zoom: number;
}

export interface Bucket {
  id: number;
  name: string;
  cursor: number;
  projects: Project[];
  auto_restore_sessions: boolean;
  idle_suspend_min: number;
}

export interface PersistedTerminal {
  id: number;
  project_id: number;
  cwd: string;
  // null when the on-disk Claude session file no longer exists (or was never
  // detected at save time). Restoration falls back to a bare `claude` in
  // that case.
  claude_session_id: string | null;
  position: number;
  saved_at: string;
}

export interface NoteSummary {
  id: number;
  project_id: number;
  title: string;
  user_title: string | null;
  updated_at: string;
}

export interface Note extends NoteSummary {
  content_json: string;
  created_at: string;
}

export interface PtyTerminalInfo {
  pty_id: string;
  project_id: number;
  project_path: string;
  title: string | null;
}

export interface TextFile {
  path: string;
  content: string;
  bytes: number;
}

// --- D2 transcript reader --------------------------------------------------

// Tail-scan result for the SuspendedPlaceholder preview card. Rust reads
// ~64 KB from the end of the JSONL — fields can be null if the tail held
// no assistant message with text content, or no line with a timestamp.
export interface TranscriptPeek {
  session_id: string;
  last_at: string | null;
  last_assistant_preview: string | null;
  total_bytes: number;
}

// Full transcript payload for the TranscriptModal. `lines` are parsed
// JSONL entries as raw JSON values — the TS types below narrow them at
// render time. `truncated: true` means the file exceeded the 5 MB cap and
// only the tail's worth of lines is included.
export interface TranscriptResponse {
  session_id: string;
  lines: TranscriptLine[];
  truncated: boolean;
  total_bytes: number;
}

// Discriminated union over the eight known line types. Forward compat for
// new types is handled at runtime — the renderer's switch falls through
// to `null` for any type value that doesn't match, so an unrecognised
// line just disappears from the view rather than breaking the render.
export type TranscriptLine =
  | TranscriptUserLine
  | TranscriptAssistantLine
  | TranscriptSystemLine
  | TranscriptAttachmentLine
  | TranscriptFileHistorySnapshotLine
  | TranscriptPermissionModeLine
  | TranscriptAiTitleLine
  | TranscriptLastPromptLine;

export interface TranscriptUserLine {
  type: "user";
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  message?: { role: "user"; content?: ContentBlock[] | string };
  cwd?: string;
  gitBranch?: string;
}

export interface TranscriptAssistantLine {
  type: "assistant";
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  message?: {
    role: "assistant";
    content?: ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    stop_reason?: string | null;
  };
  requestId?: string;
}

export interface TranscriptSystemLine {
  type: "system";
  uuid?: string;
  timestamp?: string;
  level?: string;
  subtype?: string;
  error?: string;
}

export interface TranscriptAttachmentLine {
  type: "attachment";
  uuid?: string;
  timestamp?: string;
  attachment?: {
    name?: string;
    size?: number;
    mimeType?: string;
  };
}

export interface TranscriptFileHistorySnapshotLine {
  type: "file-history-snapshot";
  messageId?: string;
}

export interface TranscriptPermissionModeLine {
  type: "permission-mode";
  permissionMode?: string;
  sessionId?: string;
}

export interface TranscriptAiTitleLine {
  type: "ai-title";
  sessionId?: string;
  aiTitle?: string;
}

export interface TranscriptLastPromptLine {
  type: "last-prompt";
  sessionId?: string;
  leafUuid?: string;
  lastPrompt?: string;
}

// Content blocks inside a user or assistant message's `content` array.
// Same `type` discriminator pattern as the line types. Renderer falls
// through on unknown types via switch default.
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input?: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string | ContentBlock[];
    }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };
