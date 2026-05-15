// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pty;
mod commands;
mod projects;

use std::sync::Mutex;

use pty::PtyManager;

pub struct AppState {
    pub pty_manager: Mutex<PtyManager>,
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            pty_manager: Mutex::new(PtyManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_folder,
            commands::list_directory,
            commands::open_terminal,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Forward PTY data events back to the main window. Subscribers in the
            // frontend listen on "pty://data" with payload { session_id, data_base64 }.
            pty::install_event_forwarder(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Lexical Emerson");
}
