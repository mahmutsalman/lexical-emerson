use std::collections::HashSet;

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, State, TitleBarStyle, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

use crate::projects::folder_basename;
use crate::session_restore;
use crate::store::{Bucket, Note, NoteSummary, PersistedTerminal, Project};
use crate::{AppState, PtyTerminalInfo};

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

#[derive(Serialize)]
pub struct TextFile {
    pub path: String,
    pub content: String,
    pub bytes: u64,
}

// Largest file we'll load into the editor. CodeMirror handles big files but a
// 5 MB cap protects the renderer from someone double-clicking a multi-GB log;
// the user gets a clear error instead of a frozen WKWebView.
const MAX_TEXT_FILE_BYTES: u64 = 5 * 1024 * 1024;

// Cheap binary heuristic — a NUL byte in the first sniff window almost always
// indicates non-text. Catches PNG, jpg, sqlite DBs, executables, etc. without
// pulling in a full MIME detector.
fn looks_binary(sample: &[u8]) -> bool {
    sample.contains(&0u8)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<TextFile, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| format!("stat({path}): {e}"))?;
    if !metadata.is_file() {
        return Err(format!("not a regular file: {path}"));
    }
    let size = metadata.len();
    if size > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "file too large ({} bytes, max {})",
            size, MAX_TEXT_FILE_BYTES
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read({path}): {e}"))?;
    let sniff = &bytes[..bytes.len().min(8192)];
    if looks_binary(sniff) {
        return Err("binary file (contains NUL)".to_string());
    }
    let content = String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())?;
    Ok(TextFile {
        path,
        content,
        bytes: size,
    })
}

// Atomic-ish write: stage to a sibling temp, then rename. Rename within the
// same dir is atomic on macOS, so a crash mid-save leaves either the old or
// the new content — never a truncated half-written file.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<u64, String> {
    let path_buf = std::path::PathBuf::from(&path);
    let parent = path_buf
        .parent()
        .ok_or_else(|| format!("no parent dir: {path}"))?;
    let filename = path_buf
        .file_name()
        .ok_or_else(|| format!("no filename: {path}"))?
        .to_string_lossy()
        .into_owned();
    let tmp = parent.join(format!(".{filename}.lex-tmp"));
    std::fs::write(&tmp, content.as_bytes())
        .map_err(|e| format!("write({}): {e}", tmp.display()))?;
    if let Err(e) = std::fs::rename(&tmp, &path_buf) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename({path}): {e}"));
    }
    Ok(content.len() as u64)
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
pub fn get_global_zoom(state: State<AppState>) -> Result<Option<f64>, String> {
    state.store.get_global_zoom().map_err(|e| e.to_string())
}

// Broadcasts on success so every other open window updates its --ui-zoom
// in the same animation frame. The originating window also receives the
// event; the frontend dedupes against its current signal value.
#[tauri::command]
pub fn set_global_zoom(
    app: AppHandle,
    state: State<AppState>,
    zoom: f64,
) -> Result<f64, String> {
    let clamped = zoom.clamp(0.75, 2.0);
    state
        .store
        .set_global_zoom(clamped)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("zoom://changed", clamped);
    Ok(clamped)
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

// Move the bucket's cursor to point at the given project AND make this
// bucket the active bucket — exactly what should happen when the user
// clicks a project row in the sidebar's expanded bucket view. Window
// spawn/focus is the caller's job (separate IPC) so this stays a
// pure-data update; both actions go out concurrently from the UI.
#[tauri::command]
pub fn set_bucket_cursor_to_project(
    app: AppHandle,
    state: State<AppState>,
    bucket_id: i64,
    project_id: i64,
) -> Result<(), String> {
    state
        .store
        .set_active_bucket(Some(bucket_id))
        .map_err(|e| e.to_string())?;
    state
        .store
        .set_bucket_cursor_to_project(bucket_id, project_id)
        .map_err(|e| e.to_string())?;
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

// --- session restore -------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn set_bucket_auto_restore(
    app: AppHandle,
    state: State<AppState>,
    bucket_id: i64,
    enabled: bool,
) -> Result<(), String> {
    state
        .store
        .set_bucket_auto_restore(bucket_id, enabled)
        .map_err(|e| e.to_string())?;
    emit_buckets_changed(&app);
    Ok(())
}

// Per-tab snapshot the frontend sends at close: the tab's cwd and the
// Claude session UUID the frontend has bound to that specific tab via its
// post-spawn polling. Sent as an array preserving tab order. `cwd` is
// always present; `claude_session_id` is None when the tab never started
// claude (or the bind hasn't fired yet).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistTabInput {
    pub cwd: String,
    pub claude_session_id: Option<String>,
}

// Snapshot a project's ordered terminal tabs to SQLite. Called from the
// frontend window's close-requested handler so the in-window tab order is
// preserved. The gate (`project_has_auto_restore_bucket`) is checked here so
// the frontend doesn't need to know the bucket→project relationship:
//   - gate open  → write one row per tab whose bound UUID still points at a
//                  live .jsonl on disk
//   - gate closed → delete any prior rows for this project
//
// Per-tab UUIDs (not per-cwd FS detect) so two tabs in the same cwd persist
// as two distinct rows pointing at two distinct sessions. The previous
// "scan the cwd and write every UUID we find" path collapsed two tabs onto
// the same `--resume <uuid>` whenever the user had multiple claude sessions
// in the same directory — see the suspend/resume convergence bug.
#[tauri::command(rename_all = "camelCase")]
pub fn persist_project_terminals(
    state: State<AppState>,
    project_id: i64,
    tabs: Vec<PersistTabInput>,
) -> Result<(), String> {
    eprintln!(
        "[persist] enter project_id={} tab_count={}",
        project_id,
        tabs.len()
    );
    let gate = state
        .store
        .project_has_auto_restore_bucket(project_id)
        .map_err(|e| e.to_string())?;
    eprintln!("[persist] gate={}", gate);
    if !gate {
        state
            .store
            .delete_persisted_terminals_for_project(project_id)
            .map_err(|e| e.to_string())?;
        eprintln!("[persist] gate closed: cleared rows, returning");
        return Ok(());
    }

    // Defensive dedupe by (cwd, uuid) — guards against a buggy frontend
    // sending the same binding twice. Tabs without a UUID binding or with
    // a UUID whose .jsonl no longer exists are skipped: there's nothing
    // meaningful to resume on next launch.
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut rows: Vec<(String, Option<String>)> = Vec::new();
    for tab in tabs {
        let uuid = match tab.claude_session_id {
            Some(u) if session_restore::session_file_exists(&tab.cwd, &u) => u,
            Some(u) => {
                eprintln!(
                    "[persist] skipping tab cwd={} uuid={} — session file gone",
                    tab.cwd, u
                );
                continue;
            }
            None => {
                eprintln!(
                    "[persist] skipping tab cwd={} — no UUID bound",
                    tab.cwd
                );
                continue;
            }
        };
        let key = (tab.cwd.clone(), uuid.clone());
        if !seen.insert(key) {
            eprintln!(
                "[persist] dedup: skipping repeat (cwd={}, uuid={})",
                tab.cwd, uuid
            );
            continue;
        }
        rows.push((tab.cwd, Some(uuid)));
    }

    state
        .store
        .replace_persisted_terminals_for_project(project_id, &rows)
        .map_err(|e| e.to_string())?;
    eprintln!("[persist] wrote {} rows, exiting OK", rows.len());
    Ok(())
}

// Used at startup by the project window to decide whether to seed the
// terminal panel from prior state. Honors the same per-bucket gate as
// `persist_project_terminals`: a project no longer in any auto-restore
// bucket returns an empty list even if old rows still exist.
//
// Also drops rows whose .jsonl session file is gone from disk OR whose
// cwd no longer exists — restoring those would just spawn a bare shell
// at a broken path or replay a stale prompt-only Claude state.
#[tauri::command(rename_all = "camelCase")]
pub fn list_persisted_terminals(
    state: State<AppState>,
    project_id: i64,
) -> Result<Vec<PersistedTerminal>, String> {
    let gate = state
        .store
        .project_has_auto_restore_bucket(project_id)
        .map_err(|e| e.to_string())?;
    if !gate {
        return Ok(Vec::new());
    }
    let rows = state
        .store
        .list_persisted_terminals_for_project(project_id)
        .map_err(|e| e.to_string())?;
    // Validate cwd existence; null out claude_session_id if file is gone so
    // the frontend falls back to `claude` (vs `claude --resume <uuid>`).
    let filtered: Vec<PersistedTerminal> = rows
        .into_iter()
        .filter(|r| std::path::Path::new(&r.cwd).is_dir())
        .map(|mut r| {
            if let Some(uuid) = r.claude_session_id.as_deref() {
                if !session_restore::session_file_exists(&r.cwd, uuid) {
                    r.claude_session_id = None;
                }
            }
            r
        })
        .collect();
    Ok(filtered)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_persisted_terminals_for_project(
    state: State<AppState>,
    project_id: i64,
) -> Result<(), String> {
    state
        .store
        .delete_persisted_terminals_for_project(project_id)
        .map_err(|e| e.to_string())
}

// Launch-time recovery: returns every project_id that had persisted
// terminals at the last shutdown. Currently unused by the frontend —
// kept for diagnostic/testing use. Restore is driven per-bucket via
// `load_active_claude_sessions_for_bucket` so the user picks which
// bucket to restore instead of auto-spawning every persisted window.
#[tauri::command]
pub fn list_persisted_project_ids(
    state: State<AppState>,
) -> Result<Vec<i64>, String> {
    state
        .store
        .list_persisted_project_ids()
        .map_err(|e| e.to_string())
}

// Read-only probe: return every Claude session UUID currently active in
// `cwd`, newest-first. Used by D1 auto-suspend in TerminalsView to decide
// whether a tab can be safely suspended (we only suspend tabs whose cwd
// has a detectable `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, so we
// know what UUID to inject into `claude --resume` on resume). An empty
// result means "no Claude conversation in this cwd" — caller skips suspend.
#[tauri::command(rename_all = "camelCase")]
pub fn detect_claude_sessions_for_cwd(cwd: String) -> Vec<String> {
    session_restore::detect_active_claude_sessions(&cwd)
}

// D2 — SuspendedPlaceholder's preview card. Reads only the tail of the
// JSONL (~64 KB) so even a 40 MB session resolves in a few ms.
#[tauri::command(rename_all = "camelCase")]
pub fn peek_session_transcript(
    cwd: String,
    session_id: String,
) -> Result<session_restore::TranscriptPeek, String> {
    session_restore::peek_session_transcript(&cwd, &session_id)
}

// D2 — TranscriptModal's full reader. Returns the parsed JSONL lines as
// serde_json::Value, capped at the last 5 MB for very large sessions.
#[tauri::command(rename_all = "camelCase")]
pub fn read_session_transcript(
    cwd: String,
    session_id: String,
) -> Result<session_restore::TranscriptResponse, String> {
    session_restore::read_session_transcript(&cwd, &session_id)
}

// Right-click → "Load active Claude sessions" action on a bucket row.
// Source of truth is the filesystem state of `~/.claude/projects/`, NOT
// the persisted_terminals snapshot — that lets us pick up sessions that
// never went through a graceful persist (app force-killed, ditto install
// over a running process, etc.). For every project in this bucket:
//
//   1. Scan its claude project dir for .jsonl files within the active
//      mtime window (currently 48h).
//   2. If any found, overwrite that project's persisted_terminals rows
//      with one row per .jsonl (newest first).
//   3. Spawn / focus the project window. Its TerminalsView reads the
//      rows we just wrote and injects `claude --resume <uuid>` per tab.
//
// Returns the count of windows opened. Projects with no active sessions
// in the bucket are skipped silently — they don't get a window.
#[tauri::command(rename_all = "camelCase")]
pub fn load_active_claude_sessions_for_bucket(
    app: AppHandle,
    state: State<AppState>,
    bucket_id: i64,
) -> Result<usize, String> {
    let bucket = state
        .store
        .get_bucket(bucket_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("bucket {} not found", bucket_id))?;

    let mut count = 0usize;
    for proj in bucket.projects {
        let uuids = session_restore::detect_active_claude_sessions(&proj.path);
        if uuids.is_empty() {
            eprintln!(
                "[load_active] project_id={} ({}) no active sessions on disk",
                proj.id, proj.name
            );
            continue;
        }
        let rows: Vec<(String, Option<String>)> = uuids
            .into_iter()
            .map(|uuid| (proj.path.clone(), Some(uuid)))
            .collect();
        eprintln!(
            "[load_active] project_id={} ({}) writing {} row(s) from filesystem",
            proj.id,
            proj.name,
            rows.len()
        );
        state
            .store
            .replace_persisted_terminals_for_project(proj.id, &rows)
            .map_err(|e| e.to_string())?;
        spawn_or_focus_project_window(&app, &proj)?;
        count += 1;
    }
    Ok(count)
}
