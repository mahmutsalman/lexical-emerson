use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::AppState;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let picked = rx.await.map_err(|e| e.to_string())?;
    let path = picked.and_then(|fp| fp.into_path().ok());
    Ok(path.map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn list_directory(path: String, show_hidden: Option<bool>) -> Result<Vec<DirEntry>, String> {
    let show_hidden = show_hidden.unwrap_or(false);
    let read = std::fs::read_dir(&path).map_err(|e| format!("read_dir({path}): {e}"))?;

    let mut out: Vec<DirEntry> = Vec::new();
    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        // Use symlink_metadata so symlinked dirs are flagged distinctly.
        let metadata = match entry.path().symlink_metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let file_type = metadata.file_type();
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
            is_symlink: file_type.is_symlink(),
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
pub fn open_terminal(
    state: State<AppState>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    state
        .pty_manager
        .lock()
        .map_err(|e| e.to_string())?
        .spawn(&cwd, None, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_terminal(
    state: State<AppState>,
    session_id: String,
    data_base64: String,
) -> Result<(), String> {
    let bytes = general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("base64: {e}"))?;
    state
        .pty_manager
        .lock()
        .map_err(|e| e.to_string())?
        .write(&session_id, &bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_terminal(
    state: State<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .pty_manager
        .lock()
        .map_err(|e| e.to_string())?
        .resize(&session_id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_terminal(state: State<AppState>, session_id: String) -> Result<(), String> {
    state
        .pty_manager
        .lock()
        .map_err(|e| e.to_string())?
        .close(&session_id)
        .map_err(|e| e.to_string())
}
