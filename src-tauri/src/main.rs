// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod projects;
mod pty;
mod store;

use std::sync::Mutex;

use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, EventTarget, Manager};

use pty::PtyManager;
use store::Store;

pub struct AppState {
    pub pty_manager: Mutex<PtyManager>,
    pub store: Store,
    // The project id currently displayed in the main launcher window (None
    // when main is in launcher-only mode). Used by spawn_or_focus_project_window
    // so that opening a project that's ALREADY visible in main focuses main
    // rather than creating a duplicate project-N window.
    pub main_project_id: Mutex<Option<i64>>,
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
            commands::list_buckets,
            commands::create_bucket,
            commands::delete_bucket,
            commands::rename_bucket,
            commands::add_to_bucket,
            commands::remove_from_bucket,
            commands::set_active_bucket,
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
            });

            let handle = app.handle().clone();
            pty::install_event_forwarder(handle);

            build_app_menu(app.handle())?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            let event_name = match event.id().as_ref() {
                "terminal_new" => "menu://terminal-new",
                "terminal_close" => "menu://terminal-close",
                "terminal_next" => "menu://terminal-next",
                "terminal_prev" => "menu://terminal-prev",
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
        .run(tauri::generate_context!())
        .expect("error while running Lexical Emerson");
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

    let file_submenu = SubmenuBuilder::new(app, "File")
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

    let terminal_submenu = SubmenuBuilder::new(app, "Terminal")
        .item(&terminal_new)
        .item(&terminal_close)
        .separator()
        .item(&terminal_next)
        .item(&terminal_prev)
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

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .minimize()
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
