use std::collections::HashMap;
use std::io::{Read, Write};
use std::thread;

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use uuid::Uuid;

#[derive(Serialize, Clone)]
pub struct PtyDataEvent {
    pub session_id: String,
    pub data_base64: String,
}

#[derive(Serialize, Clone)]
pub struct PtyExitEvent {
    pub session_id: String,
    pub exit_code: i32,
}

pub enum PtyMessage {
    Data { session_id: String, bytes: Vec<u8> },
    Exit { session_id: String, exit_code: i32 },
}

// The blocking reader's read() unblocks when we drop the master MasterPty
// from the close() path; reader thread observes Err/Ok(0) and exits.
struct PtySession {
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
    tx: UnboundedSender<PtyMessage>,
    rx: Option<UnboundedReceiver<PtyMessage>>,
}

impl PtyManager {
    pub fn new() -> Self {
        let (tx, rx) = unbounded_channel();
        Self {
            sessions: HashMap::new(),
            tx,
            rx: Some(rx),
        }
    }

    fn take_receiver(&mut self) -> Option<UnboundedReceiver<PtyMessage>> {
        self.rx.take()
    }

    pub fn spawn(
        &mut self,
        cwd: &str,
        shell: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell_path = shell.unwrap_or_else(|| {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
        });
        let mut cmd = CommandBuilder::new(&shell_path);
        cmd.arg("-l");
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", home);
        }
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", path);
        }

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let writer = pair.master.take_writer()?;
        let reader = pair.master.try_clone_reader()?;

        let session_id = Uuid::new_v4().to_string();
        let tx = self.tx.clone();
        let reader_id = session_id.clone();

        thread::Builder::new()
            .name(format!("pty-reader-{}", &reader_id[..8]))
            .spawn(move || run_reader(reader, tx, reader_id))?;

        self.sessions.insert(
            session_id.clone(),
            PtySession {
                child,
                master: pair.master,
                writer,
            },
        );
        Ok(session_id)
    }

    pub fn write(&mut self, session_id: &str, data: &[u8]) -> Result<()> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("no such pty session"))?;
        session.writer.write_all(data)?;
        session.writer.flush()?;
        Ok(())
    }

    pub fn resize(&mut self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| anyhow!("no such pty session"))?;
        session.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn close(&mut self, session_id: &str) -> Result<()> {
        if let Some(mut session) = self.sessions.remove(session_id) {
            let _ = session.child.kill();
            drop(session.writer);
            drop(session.master);
        }
        Ok(())
    }
}

fn run_reader(
    mut reader: Box<dyn Read + Send>,
    tx: UnboundedSender<PtyMessage>,
    session_id: String,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tx
                    .send(PtyMessage::Data {
                        session_id: session_id.clone(),
                        bytes: buf[..n].to_vec(),
                    })
                    .is_err()
                {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = tx.send(PtyMessage::Exit {
        session_id,
        exit_code: 0,
    });
}

pub fn install_event_forwarder(app: AppHandle) {
    let rx_opt: Option<UnboundedReceiver<PtyMessage>> = {
        let state = app.state::<crate::AppState>();
        let mut guard = state.pty_manager.lock().expect("pty manager mutex poisoned");
        let rx = guard.take_receiver();
        drop(guard);
        rx
    };
    let Some(mut rx) = rx_opt else {
        log::warn!("install_event_forwarder called twice; ignoring");
        return;
    };
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg {
                PtyMessage::Data { session_id, bytes } => {
                    let payload = PtyDataEvent {
                        session_id,
                        data_base64: general_purpose::STANDARD.encode(&bytes),
                    };
                    if let Err(e) = app.emit("pty://data", payload) {
                        log::warn!("failed to emit pty://data: {e}");
                    }
                }
                PtyMessage::Exit { session_id, exit_code } => {
                    let payload = PtyExitEvent {
                        session_id,
                        exit_code,
                    };
                    if let Err(e) = app.emit("pty://exit", payload) {
                        log::warn!("failed to emit pty://exit: {e}");
                    }
                }
            }
        }
    });
}
