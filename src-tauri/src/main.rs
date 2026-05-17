// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod projects;
mod pty;
mod session_restore;
mod store;

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, EventTarget, Manager};

use pty::PtyManager;
use store::Store;

#[derive(Serialize, Deserialize, Clone)]
pub struct PtyTerminalInfo {
    pub pty_id: String,
    pub project_id: i64,
    pub project_path: String,
    pub title: Option<String>,
}

pub struct AppState {
    pub pty_manager: Mutex<PtyManager>,
    pub store: Store,
    // The project id currently displayed in the main launcher window (None
    // when main is in launcher-only mode). Used by spawn_or_focus_project_window
    // so that opening a project that's ALREADY visible in main focuses main
    // rather than creating a duplicate project-N window.
    pub main_project_id: Mutex<Option<i64>>,
    // Live PTY registry keyed by session_id. Source of truth for "what
    // terminals are running, in which project?" — populated by frontends via
    // register_terminal as they spawn, drained on PtyMessage::Exit and on
    // explicit unregister. The Bucket Workspace window queries this to
    // discover and attach to existing PTYs across all projects in a bucket.
    pub pty_registry: Mutex<HashMap<String, PtyTerminalInfo>>,
}

fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::pick_folder,
            commands::list_directory,
            commands::open_terminal,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
            commands::open_project,
            commands::list_recents,
            commands::mark_active,
            commands::mark_focused,
            commands::last_project,
            commands::get_project_by_id,
            commands::request_open_project,
            commands::current_window_label,
            commands::set_main_project,
            commands::set_project_color,
            commands::set_project_zoom,
            commands::get_global_zoom,
            commands::set_global_zoom,
            commands::hide_project,
            commands::reveal_in_finder,
            commands::list_buckets,
            commands::create_bucket,
            commands::delete_bucket,
            commands::rename_bucket,
            commands::add_to_bucket,
            commands::remove_from_bucket,
            commands::reorder_bucket_projects,
            commands::set_active_bucket,
            commands::set_bucket_cursor_to_project,
            commands::get_active_bucket,
            commands::cycle_bucket,
            commands::list_notes,
            commands::get_note,
            commands::create_note,
            commands::update_note,
            commands::delete_note,
            commands::set_note_title,
            commands::save_note_image,
            commands::resolve_note_image,
            commands::register_terminal,
            commands::unregister_terminal,
            commands::list_terminals_for_bucket,
            commands::list_all_registered_terminals,
            commands::rescan_terminals,
            commands::spawn_bucket_3d_workspace,
            commands::debug_insert_fake_registry_entry,
            commands::set_bucket_auto_restore,
            commands::persist_project_terminals,
            commands::list_persisted_terminals,
            commands::delete_persisted_terminals_for_project,
            commands::list_persisted_project_ids,
            commands::load_active_claude_sessions_for_bucket,
            commands::detect_claude_sessions_for_cwd,
            commands::peek_session_transcript,
            commands::read_session_transcript,
        ])
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("could not resolve app_data_dir");
            let db_path = app_data.join("state.db");
            let store = Store::open(&db_path).expect("failed to open state.db");

            app.manage(AppState {
                pty_manager: Mutex::new(PtyManager::new()),
                store,
                main_project_id: Mutex::new(None),
                pty_registry: Mutex::new(HashMap::new()),
            });

            let handle = app.handle().clone();
            pty::install_event_forwarder(handle);

            build_app_menu(app.handle())?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            // Window-cycling is purely native: focus another window. No need
            // to round-trip through a webview, so handle it inline and bail.
            match event.id().as_ref() {
                "window_next" => {
                    cycle_app_windows(app, 1);
                    return;
                }
                "window_prev" => {
                    cycle_app_windows(app, -1);
                    return;
                }
                "window_close" => {
                    // Close the currently-focused window. Triggers the
                    // window's onCloseRequested handler (persist + destroy)
                    // just like clicking the red traffic-light button.
                    for (_, window) in app.webview_windows() {
                        if window.is_focused().unwrap_or(false) {
                            let _ = window.close();
                            break;
                        }
                    }
                    return;
                }
                _ => {}
            }
            let event_name = match event.id().as_ref() {
                "file_open_folder" => "menu://file-open-folder",
                "terminal_new" => "menu://terminal-new",
                "terminal_close" => "menu://terminal-close",
                "terminal_next" => "menu://terminal-next",
                "terminal_prev" => "menu://terminal-prev",
                "terminal_3d" => "menu://terminal-toggle-3d",
                // The arrow shortcuts share the cycle events with ⌘⇧K / ⌘K
                // so typing always follows the visible centred terminal.
                "terminal_rotate_left" => "menu://terminal-prev",
                "terminal_rotate_right" => "menu://terminal-next",
                "bucket_3d_ring_prev" => "menu://bucket-3d-ring-prev",
                "bucket_3d_ring_next" => "menu://bucket-3d-ring-next",
                "go_quick_switcher" => "menu://quick-switcher",
                "bucket_next" => "menu://bucket-next",
                "bucket_prev" => "menu://bucket-prev",
                "bucket_new" => "menu://bucket-new",
                "notes_open" => "menu://notes-open",
                "zoom_in" => "menu://zoom-in",
                "zoom_out" => "menu://zoom-out",
                "zoom_reset" => "menu://zoom-reset",
                _ => return,
            };
            // Route menu events to the focused window only — broadcasting
            // would fire ⌘T (etc.) in every open window simultaneously.
            // See ADR-0006. Note: WebviewWindow::emit() is GLOBAL in Tauri v2,
            // not scoped to the window; we must use emit_to with an explicit
            // EventTarget::WebviewWindow target.
            for (label, window) in app.webview_windows() {
                if window.is_focused().unwrap_or(false) {
                    let _ = app.emit_to(
                        EventTarget::WebviewWindow { label },
                        event_name,
                        (),
                    );
                    return;
                }
            }
            // Fallback if no window claims focus (rare; e.g. all minimized).
            let _ = app.emit(event_name, ());
        })
        .build(tauri::generate_context!())
        .expect("error while building Lexical Emerson")
        .run(|app, event| {
            // On ⌘Q (or any app-level exit request), give every open project
            // window a chance to fire its onCloseRequested handler — that's
            // where persist_project_terminals runs. Without this, Tauri's
            // default ExitRequested behavior tears windows down before their
            // async close handlers can finish snapshotting tabs to SQLite,
            // so quitting via ⌘Q would silently skip session persistence.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                // Close BOTH main and project-* windows: main may also be
                // hosting a project (via lastProject), in which case its
                // TerminalsView holds the only onCloseRequested handler
                // that can persist that project's tabs. Excluding main
                // here silently dropped its persist on ⌘Q.
                let windows: Vec<tauri::WebviewWindow> = app
                    .webview_windows()
                    .into_iter()
                    .filter(|(label, _)| {
                        label.as_str() == "main"
                            || label.starts_with("project-")
                    })
                    .map(|(_, w)| w)
                    .collect();
                if windows.is_empty() {
                    return;
                }
                eprintln!(
                    "[exit] {} window(s) open; closing each before exit",
                    windows.len()
                );
                api.prevent_exit();
                let app = app.clone();
                std::thread::spawn(move || {
                    for win in &windows {
                        let _ = win.close();
                    }
                    // Each window has a 1.5s persist-timeout race in
                    // TerminalsView.tsx, so 3s is generous slack. Poll the
                    // window set so we exit as soon as everyone's gone.
                    let start = std::time::Instant::now();
                    loop {
                        let remaining = app
                            .webview_windows()
                            .iter()
                            .filter(|(label, _)| {
                                label.as_str() == "main"
                                    || label.starts_with("project-")
                            })
                            .count();
                        if remaining == 0 {
                            eprintln!("[exit] all windows destroyed");
                            break;
                        }
                        if start.elapsed() > std::time::Duration::from_secs(3) {
                            eprintln!(
                                "[exit] {} window(s) still open after 3s, forcing exit",
                                remaining
                            );
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    app.exit(0);
                });
            }
        });
}

// Cycle focus across every open project window (main + project-<id>).
// Ordering: `main` first, then project windows by numeric id ascending —
// stable so forward/backward cycling is predictable regardless of focus
// history. Direction +1 = next, -1 = previous. No-op when fewer than 2
// project windows are open.
fn cycle_app_windows(app: &tauri::AppHandle, direction: i32) {
    fn sort_key(label: &str) -> (u8, i64) {
        if label == "main" {
            (0, 0)
        } else if let Some(rest) = label.strip_prefix("project-") {
            (1, rest.parse().unwrap_or(i64::MAX))
        } else {
            (2, 0)
        }
    }

    let mut windows: Vec<(String, tauri::WebviewWindow)> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label == "main" || label.starts_with("project-"))
        .collect();
    if windows.len() < 2 {
        return;
    }
    windows.sort_by(|(a, _), (b, _)| sort_key(a).cmp(&sort_key(b)));

    let focused = windows
        .iter()
        .position(|(_, w)| w.is_focused().unwrap_or(false));
    let n = windows.len() as i32;
    let next_idx = match focused {
        Some(i) => ((i as i32 + direction).rem_euclid(n)) as usize,
        None => 0,
    };
    let (_, win) = &windows[next_idx];
    let _ = win.show();
    let _ = win.set_focus();
}

fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let about = AboutMetadataBuilder::new()
        .name(Some("Lexical Emerson"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("MIT — Mahmut Salman, 2026"))
        .build();

    let app_submenu = SubmenuBuilder::new(app, "Lexical Emerson")
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_open_folder = MenuItemBuilder::with_id("file_open_folder", "Open Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;

    let file_submenu = SubmenuBuilder::new(app, "File")
        .item(&file_open_folder)
        .separator()
        .close_window()
        .build()?;

    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let terminal_new = MenuItemBuilder::with_id("terminal_new", "New Terminal")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let terminal_close = MenuItemBuilder::with_id("terminal_close", "Close Terminal")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let terminal_next = MenuItemBuilder::with_id("terminal_next", "Next Terminal")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let terminal_prev = MenuItemBuilder::with_id("terminal_prev", "Previous Terminal")
        .accelerator("CmdOrCtrl+Shift+K")
        .build(app)?;
    let terminal_3d = MenuItemBuilder::with_id("terminal_3d", "Toggle 3D Arc View")
        .accelerator("CmdOrCtrl+Alt+3")
        .build(app)?;
    let terminal_rotate_left =
        MenuItemBuilder::with_id("terminal_rotate_left", "Previous Terminal (Arrow)")
            .accelerator("CmdOrCtrl+Alt+Left")
            .build(app)?;
    let terminal_rotate_right =
        MenuItemBuilder::with_id("terminal_rotate_right", "Next Terminal (Arrow)")
            .accelerator("CmdOrCtrl+Alt+Right")
            .build(app)?;
    let bucket_3d_ring_prev =
        MenuItemBuilder::with_id("bucket_3d_ring_prev", "Previous Project Ring")
            .accelerator("CmdOrCtrl+Alt+Up")
            .build(app)?;
    let bucket_3d_ring_next =
        MenuItemBuilder::with_id("bucket_3d_ring_next", "Next Project Ring")
            .accelerator("CmdOrCtrl+Alt+Down")
            .build(app)?;

    let terminal_submenu = SubmenuBuilder::new(app, "Terminal")
        .item(&terminal_new)
        .item(&terminal_close)
        .separator()
        .item(&terminal_next)
        .item(&terminal_prev)
        .separator()
        .item(&terminal_3d)
        .item(&terminal_rotate_left)
        .item(&terminal_rotate_right)
        .separator()
        .item(&bucket_3d_ring_prev)
        .item(&bucket_3d_ring_next)
        .build()?;

    let zoom_in = MenuItemBuilder::with_id("zoom_in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("zoom_out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("zoom_reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .fullscreen()
        .build()?;

    let go_quick_switcher = MenuItemBuilder::with_id("go_quick_switcher", "Quick Switcher…")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let go_submenu = SubmenuBuilder::new(app, "Go")
        .item(&go_quick_switcher)
        .build()?;

    let bucket_next = MenuItemBuilder::with_id("bucket_next", "Cycle Bucket Forward")
        .accelerator("CmdOrCtrl+J")
        .build(app)?;
    let bucket_prev = MenuItemBuilder::with_id("bucket_prev", "Cycle Bucket Backward")
        .accelerator("CmdOrCtrl+Shift+J")
        .build(app)?;
    let bucket_new = MenuItemBuilder::with_id("bucket_new", "New Bucket…")
        .accelerator("CmdOrCtrl+Shift+B")
        .build(app)?;
    let bucket_submenu = SubmenuBuilder::new(app, "Bucket")
        .item(&bucket_next)
        .item(&bucket_prev)
        .separator()
        .item(&bucket_new)
        .build()?;

    let notes_open = MenuItemBuilder::with_id("notes_open", "Open Notes…")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let notes_submenu = SubmenuBuilder::new(app, "Notes")
        .item(&notes_open)
        .build()?;

    let window_next = MenuItemBuilder::with_id("window_next", "Cycle Window Forward")
        .accelerator("CmdOrCtrl+Alt+J")
        .build(app)?;
    let window_prev = MenuItemBuilder::with_id("window_prev", "Cycle Window Backward")
        .accelerator("CmdOrCtrl+Alt+Shift+J")
        .build(app)?;
    // ⌘⇧W follows the Chrome / VS Code / iTerm2 convention when ⌘W is for
    // tab-level close (here: terminal_close). Routes to window.close() which
    // triggers the project window's onCloseRequested → persist → destroy.
    let window_close = MenuItemBuilder::with_id("window_close", "Close Window")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let window_submenu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&window_close)
        .separator()
        .item(&window_next)
        .item(&window_prev)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &go_submenu,
            &terminal_submenu,
            &bucket_submenu,
            &notes_submenu,
            &window_submenu,
        ])
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}
