// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod projects;
mod pty;
mod store;

use std::sync::Mutex;

use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

use pty::PtyManager;
use store::Store;

pub struct AppState {
    pub pty_manager: Mutex<PtyManager>,
    pub store: Store,
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
            commands::last_project,
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
            });

            let handle = app.handle().clone();
            pty::install_event_forwarder(handle);

            build_app_menu(app.handle())?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "terminal_new" => {
                    let _ = app.emit("menu://terminal-new", ());
                }
                "terminal_close" => {
                    let _ = app.emit("menu://terminal-close", ());
                }
                "terminal_next" => {
                    let _ = app.emit("menu://terminal-next", ());
                }
                "terminal_prev" => {
                    let _ = app.emit("menu://terminal-prev", ());
                }
                _ => {}
            }
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
        .accelerator("CmdOrCtrl+Shift+]")
        .build(app)?;
    let terminal_prev = MenuItemBuilder::with_id("terminal_prev", "Previous Terminal")
        .accelerator("CmdOrCtrl+Shift+[")
        .build(app)?;

    let terminal_submenu = SubmenuBuilder::new(app, "Terminal")
        .item(&terminal_new)
        .item(&terminal_close)
        .separator()
        .item(&terminal_next)
        .item(&terminal_prev)
        .build()?;

    let view_submenu = SubmenuBuilder::new(app, "View")
        .fullscreen()
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
            &terminal_submenu,
            &window_submenu,
        ])
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}
