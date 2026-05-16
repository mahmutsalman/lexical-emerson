use std::collections::HashSet;

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, State, TitleBarStyle, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

use crate::projects::folder_basename;
use crate::store::{Bucket, Note, NoteSummary, Project};
use crate::{AppState, PtyTerminalInfo};

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

// Spawn a PTY and (if project info is provided) atomically register it in
// the global terminal registry. Auto-registering on spawn is more robust
// than a separate frontend call — the only way a PTY can exist without an
// entry now is if the caller explicitly omitted project info.
#[tauri::command(rename_all = "camelCase")]
pub fn open_terminal(
    app: AppHandle,
    state: State<AppState>,
    cwd: String,
    cols: u16,
    rows: u16,
    project_id: Option<i64>,
    project_path: Option<String>,
) -> Result<String, String> {
    // Stderr-trace the deserialized values. With this surfaced, the
    // workspace's "registry 0" symptom can be diagnosed end-to-end when
    // the app is launched from a terminal — if the values arrive None we
    // know the bug is in JS-side serialization; if they arrive Some(...)
    // but the registry stays empty we know the bug is elsewhere.
    eprintln!(
        "[open_terminal] cwd={:?} project_id={:?} project_path={:?}",
        cwd, project_id, project_path
    );
    let pty_id = state
        .pty_manager
        .lock()
        .map_err(|e| e.to_string())?
        .spawn(&cwd, None, cols, rows)
        .map_err(|e| e.to_string())?;

    if let (Some(pid), Some(ppath)) = (project_id, project_path) {
        {
            let mut reg = state
                .pty_registry
                .lock()
                .map_err(|e| e.to_string())?;
            reg.insert(
                pty_id.clone(),
                PtyTerminalInfo {
                    pty_id: pty_id.clone(),
                    project_id: pid,
                    project_path: ppath,
                    title: None,
                },
            );
            eprintln!(
                "[open_terminal] inserted into registry; size={}",
                reg.len()
            );
        }
        let _ = app.emit("terminals://changed", ());
    } else {
        eprintln!(
            "[open_terminal] SKIPPED registry insert — project info missing"
        );
    }

    Ok(pty_id)
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

const COLOR_TAGS: &[&str] = &[
    "amber", "blue", "green", "violet", "orange", "red", "sky", "teal", "pink", "lime",
];

#[tauri::command]
pub fn set_project_color(
    state: State<AppState>,
    id: i64,
    color: Option<String>,
) -> Result<Project, String> {
    if let Some(ref c) = color {
        if !COLOR_TAGS.contains(&c.as_str()) {
            return Err(format!("invalid color tag: {c}"));
        }
    }
    state
        .store
        .set_project_color(id, color.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_project_zoom(
    state: State<AppState>,
    id: i64,
    zoom: f64,
) -> Result<Project, String> {
    let clamped = zoom.clamp(0.75, 2.0);
    state
        .store
        .set_project_zoom(id, clamped)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hide_project(state: State<AppState>, id: i64) -> Result<(), String> {
    state.store.hide_project(id).map_err(|e| e.to_string())
}

// Reveal the project folder in macOS Finder. `open -R` highlights the target
// in its parent window; if the path no longer exists Finder surfaces its own
// dialog, which is the right behavior for a "show me where this was" action.
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open -R {path}: {e}"))
}

// Spawn a dedicated window for the given project, or focus the existing one
// if it's already open. See ADR-0006.
//
// Single-window-per-project invariant: BEFORE checking the dedicated
// `project-<id>` window, we consult `AppState::main_project_id`. If the
// main launcher window is already displaying this project, we focus main
// instead of creating a duplicate project-N window. Without this, two
// windows could write to the same `notes` rows concurrently — see the
// data-loss postmortem in M6.1.
fn spawn_or_focus_project_window(app: &AppHandle, project: &Project) -> Result<(), String> {
    let state: tauri::State<AppState> = app.state();
    let main_pid = *state
        .main_project_id
        .lock()
        .map_err(|e| e.to_string())?;
    if main_pid == Some(project.id) {
        if let Some(main_window) = app.get_webview_window("main") {
            main_window.show().map_err(|e| e.to_string())?;
            main_window.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    let label = format!("project-{}", project.id);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let title = format!("Lexical Emerson — {}", project.name);
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .title_bar_style(TitleBarStyle::Transparent)
        .hidden_title(true)
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
pub fn reorder_bucket_projects(
    app: AppHandle,
    state: State<AppState>,
    bucket_id: i64,
    project_ids: Vec<i64>,
) -> Result<(), String> {
    state
        .store
        .set_bucket_project_order(bucket_id, &project_ids)
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

// Frontend-reported "main is currently displaying project N (or None)". The
// main window calls this on every change to its currentProject signal so
// that spawn_or_focus_project_window can dedup against it. Project-N
// windows never call this (they're locked to a fixed project by label).
#[tauri::command]
pub fn set_main_project(
    state: State<AppState>,
    project_id: Option<i64>,
) -> Result<(), String> {
    *state
        .main_project_id
        .lock()
        .map_err(|e| e.to_string())? = project_id;
    Ok(())
}

// --- notes -----------------------------------------------------------------

#[tauri::command]
pub fn list_notes(
    state: State<AppState>,
    project_id: i64,
) -> Result<Vec<NoteSummary>, String> {
    state
        .store
        .list_notes(project_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_note(state: State<AppState>, id: i64) -> Result<Note, String> {
    state.store.get_note(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_note(
    state: State<AppState>,
    project_id: i64,
) -> Result<Note, String> {
    state.store.create_note(project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_note(
    state: State<AppState>,
    id: i64,
    content_json: String,
) -> Result<NoteSummary, String> {
    state
        .store
        .update_note(id, &content_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_note(state: State<AppState>, id: i64) -> Result<(), String> {
    state.store.delete_note(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_note_title(
    state: State<AppState>,
    id: i64,
    user_title: Option<String>,
) -> Result<NoteSummary, String> {
    state
        .store
        .set_note_title(id, user_title.as_deref())
        .map_err(|e| e.to_string())
}

// Allowlist of extensions that may be written to the per-project notes dir.
// Validated to keep path-extension trickery (`..`, slashes) out of the
// filename.
fn validate_image_ext(ext: &str) -> Result<String, String> {
    let normalized = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    match normalized.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => Ok(normalized),
        other => Err(format!("unsupported image extension: {other}")),
    }
}

fn project_notes_dir(
    app: &AppHandle,
    project_id: i64,
) -> Result<std::path::PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(app_data
        .join("projects")
        .join(project_id.to_string())
        .join("notes"))
}

// Persist a pasted/dropped image to the per-project notes directory and
// return its path *relative to the project notes dir* — e.g. "notes/<uuid>.png"
// — so the Quill Delta stays portable across machines / OS user accounts.
#[tauri::command]
pub fn save_note_image(
    app: AppHandle,
    project_id: i64,
    data_base64: String,
    ext: String,
) -> Result<String, String> {
    let ext = validate_image_ext(&ext)?;
    let bytes = general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("base64: {e}"))?;
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("image too large (>50 MB)".to_string());
    }
    let dir = project_notes_dir(&app, project_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let filename = format!("{}.{ext}", uuid::Uuid::new_v4());
    let abs = dir.join(&filename);
    std::fs::write(&abs, &bytes).map_err(|e| format!("write: {e}"))?;
    Ok(format!("notes/{filename}"))
}

// --- terminal registry & bucket workspace window --------------------------

// Register a PTY session against its owning project. Called by frontends
// immediately after a successful open_terminal so the Bucket Workspace can
// later discover and attach to live terminals across a bucket.
#[tauri::command(rename_all = "camelCase")]
pub fn register_terminal(
    app: AppHandle,
    state: State<AppState>,
    pty_id: String,
    project_id: i64,
    project_path: String,
    title: Option<String>,
) -> Result<(), String> {
    eprintln!(
        "[register_terminal] pty_id={} project_id={} project_path={}",
        pty_id, project_id, project_path
    );
    {
        let mut reg = state
            .pty_registry
            .lock()
            .map_err(|e| e.to_string())?;
        reg.insert(
            pty_id.clone(),
            PtyTerminalInfo {
                pty_id,
                project_id,
                project_path,
                title,
            },
        );
        eprintln!(
            "[register_terminal] registry size now {}",
            reg.len()
        );
    }
    let _ = app.emit("terminals://changed", ());
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn unregister_terminal(
    app: AppHandle,
    state: State<AppState>,
    pty_id: String,
) -> Result<(), String> {
    let removed = {
        let mut reg = state
            .pty_registry
            .lock()
            .map_err(|e| e.to_string())?;
        reg.remove(&pty_id).is_some()
    };
    if removed {
        let _ = app.emit("terminals://changed", ());
    }
    Ok(())
}

// Debug helper: dump the entire registry without bucket filtering. Used by
// the workspace's diagnostic UI to verify that per-project windows are
// actually registering their PTYs (vs. registration silently failing).
#[tauri::command]
pub fn list_all_registered_terminals(
    state: State<AppState>,
) -> Result<Vec<PtyTerminalInfo>, String> {
    let reg = state
        .pty_registry
        .lock()
        .map_err(|e| e.to_string())?;
    let out: Vec<PtyTerminalInfo> = reg.values().cloned().collect();
    eprintln!(
        "[list_all_registered_terminals] returning {} entries",
        out.len()
    );
    Ok(out)
}

// Debug-only: insert a known fake entry into the registry. Lets the user
// verify that the registry READ path (list_all_registered_terminals,
// list_terminals_for_bucket, terminals://changed broadcast) is healthy in
// isolation from the spawn path. If THIS shows up in the workspace,
// the bug is in open_terminal's project_id arrival, not in the
// registry/read side.
#[tauri::command(rename_all = "camelCase")]
pub fn debug_insert_fake_registry_entry(
    app: AppHandle,
    state: State<AppState>,
    project_id: i64,
    project_path: String,
) -> Result<String, String> {
    let pty_id = format!("debug-{}", uuid::Uuid::new_v4());
    eprintln!(
        "[debug_insert_fake] project_id={} project_path={}",
        project_id, project_path
    );
    {
        let mut reg = state
            .pty_registry
            .lock()
            .map_err(|e| e.to_string())?;
        reg.insert(
            pty_id.clone(),
            PtyTerminalInfo {
                pty_id: pty_id.clone(),
                project_id,
                project_path,
                title: Some("DEBUG fake".to_string()),
            },
        );
    }
    let _ = app.emit("terminals://changed", ());
    Ok(pty_id)
}

// Re-broadcast terminals://changed so any window listening for registry
// updates (the workspace) re-reconciles. The frontend invokes this from a
// "Re-scan terminals" button in the workspace so the user can manually
// resync without restarting the app.
#[tauri::command]
pub fn rescan_terminals(app: AppHandle) -> Result<(), String> {
    let _ = app.emit("terminals://rescan-request", ());
    let _ = app.emit("terminals://changed", ());
    Ok(())
}

// List live terminals for every project in `bucket_id`. Used by the Bucket
// Workspace window on mount and on every terminals://changed broadcast to
// reconcile its tab list against the actual PTY set.
#[tauri::command(rename_all = "camelCase")]
pub fn list_terminals_for_bucket(
    state: State<AppState>,
    bucket_id: i64,
) -> Result<Vec<PtyTerminalInfo>, String> {
    let bucket = state
        .store
        .get_bucket(bucket_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "bucket not found".to_string())?;
    let project_ids: HashSet<i64> = bucket.projects.iter().map(|p| p.id).collect();
    let reg = state
        .pty_registry
        .lock()
        .map_err(|e| e.to_string())?;
    let out: Vec<PtyTerminalInfo> = reg
        .values()
        .filter(|t| project_ids.contains(&t.project_id))
        .cloned()
        .collect();
    eprintln!(
        "[list_terminals_for_bucket] bucket_id={} bucket_project_ids={:?} registry_size={} matching={}",
        bucket_id,
        project_ids,
        reg.len(),
        out.len()
    );
    Ok(out)
}

// Open (or focus, if already present) the dedicated Bucket Workspace window
// for the given bucket. Window label format: `bucket-3d-<id>`. Modelled on
// spawn_or_focus_project_window so the routing logic in App.tsx can detect
// the kind by label prefix.
#[tauri::command(rename_all = "camelCase")]
pub fn spawn_bucket_3d_workspace(
    app: AppHandle,
    state: State<AppState>,
    bucket_id: i64,
) -> Result<(), String> {
    let bucket = state
        .store
        .get_bucket(bucket_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "bucket not found".to_string())?;
    let label = format!("bucket-3d-{}", bucket_id);
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let title = format!("Workspace — {}", bucket.name);
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .title_bar_style(TitleBarStyle::Transparent)
        .hidden_title(true)
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .build()
        .map_err(|e| e.to_string())?;
    // Explicit focus so menu accelerators (⌘⌥3 etc.) route here instead
    // of staying with the launcher / project window the user opened the
    // workspace from. Tauri's default focus-on-create is unreliable on
    // macOS when the parent window held keyboard focus.
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

// Resolve a relative path stored in a note's Delta back to an absolute
// filesystem path. The frontend wraps the result in convertFileSrc() so the
// custom asset protocol can serve it to <img src=…>.
#[tauri::command]
pub fn resolve_note_image(
    app: AppHandle,
    project_id: i64,
    rel_path: String,
) -> Result<String, String> {
    // Reject anything that tries to escape the project notes dir.
    if rel_path.contains("..") || rel_path.starts_with('/') {
        return Err("invalid rel_path".to_string());
    }
    let dir = project_notes_dir(&app, project_id)?;
    let base = dir
        .parent()
        .ok_or_else(|| "notes dir has no parent".to_string())?;
    let abs = base.join(rel_path);
    Ok(abs.to_string_lossy().into_owned())
}
