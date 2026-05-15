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
