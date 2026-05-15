use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

use crate::projects::folder_basename;
use crate::store::{Bucket, Project};
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

// --- project persistence ---------------------------------------------------

#[tauri::command]
pub fn open_project(state: State<AppState>, path: String) -> Result<Project, String> {
    let name = folder_basename(&path);
    state
        .store
        .register_or_focus(&path, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_recents(state: State<AppState>) -> Result<Vec<Project>, String> {
    state.store.list_recents(20).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_active(state: State<AppState>, path: String) -> Result<(), String> {
    state.store.mark_active(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn last_project(state: State<AppState>) -> Result<Option<Project>, String> {
    state.store.last_project().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_project_by_id(
    state: State<AppState>,
    id: i64,
) -> Result<Option<Project>, String> {
    state.store.get_by_id(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_focused(state: State<AppState>, path: String) -> Result<(), String> {
    state.store.mark_focused(&path).map_err(|e| e.to_string())
}

// Spawn a dedicated window for the given project, or focus the existing one
// if it's already open. See ADR-0006.
fn spawn_or_focus_project_window(app: &AppHandle, project: &Project) -> Result<(), String> {
    let label = format!("project-{}", project.id);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let title = format!("Lexical Emerson — {}", project.name);
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(700.0, 480.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn request_open_project(
    app: AppHandle,
    state: State<AppState>,
    path: String,
) -> Result<Project, String> {
    let name = folder_basename(&path);
    let project = state
        .store
        .register_or_focus(&path, &name)
        .map_err(|e| e.to_string())?;
    spawn_or_focus_project_window(&app, &project)?;
    Ok(project)
}

// --- buckets ---------------------------------------------------------------

// Notify every window that bucket data changed so each can refresh its UI.
fn emit_buckets_changed(app: &AppHandle) {
    let _ = app.emit("buckets://changed", ());
}

#[tauri::command]
pub fn list_buckets(state: State<AppState>) -> Result<Vec<Bucket>, String> {
    state.store.list_buckets().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_bucket(
    app: AppHandle,
    state: State<AppState>,
    name: String,
) -> Result<Bucket, String> {
    let bucket = state.store.create_bucket(&name).map_err(|e| e.to_string())?;
    emit_buckets_changed(&app);
    Ok(bucket)
}

#[tauri::command]
pub fn delete_bucket(
    app: AppHandle,
    state: State<AppState>,
    id: i64,
) -> Result<(), String> {
    state.store.delete_bucket(id).map_err(|e| e.to_string())?;
    emit_buckets_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn rename_bucket(
    app: AppHandle,
    state: State<AppState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    state.store.rename_bucket(id, &name).map_err(|e| e.to_string())?;
    emit_buckets_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn add_to_bucket(
    app: AppHandle,
    state: State<AppState>,
    bucket_id: i64,
    project_id: i64,
) -> Result<(), String> {
    state
        .store
        .add_to_bucket(bucket_id, project_id)
        .map_err(|e| e.to_string())?;
    emit_buckets_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn remove_from_bucket(
    app: AppHandle,
    state: State<AppState>,
    bucket_id: i64,
    project_id: i64,
) -> Result<(), String> {
    state
        .store
        .remove_from_bucket(bucket_id, project_id)
        .map_err(|e| e.to_string())?;
    emit_buckets_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn set_active_bucket(
    app: AppHandle,
    state: State<AppState>,
    id: Option<i64>,
) -> Result<(), String> {
    state.store.set_active_bucket(id).map_err(|e| e.to_string())?;
    emit_buckets_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn get_active_bucket(state: State<AppState>) -> Result<Option<i64>, String> {
    state.store.get_active_bucket().map_err(|e| e.to_string())
}

// Cycle the active bucket: advance its cursor, focus or spawn the resulting
// project's window. Returns the project that was activated, or None if there
// is no active bucket / the bucket is empty.
#[tauri::command]
pub fn cycle_bucket(
    app: AppHandle,
    state: State<AppState>,
    direction: i32,
) -> Result<Option<Project>, String> {
    let project = state
        .store
        .cycle_active_bucket(direction)
        .map_err(|e| e.to_string())?;
    if let Some(ref p) = project {
        spawn_or_focus_project_window(&app, p)?;
    }
    // Cursor changed; let every window refresh its BucketBar.
    emit_buckets_changed(&app);
    Ok(project)
}

#[tauri::command]
pub fn current_window_label(window: tauri::Window) -> String {
    window.label().to_string()
}
