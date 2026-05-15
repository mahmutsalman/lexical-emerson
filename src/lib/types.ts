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
