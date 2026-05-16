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
