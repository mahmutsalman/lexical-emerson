use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS projects (
    id              INTEGER PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    last_focused_at TEXT,
    last_active_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_recent
    ON projects(last_active_at DESC, last_focused_at DESC);
";

#[derive(Serialize, Clone)]
pub struct Project {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub last_focused_at: Option<String>,
    pub last_active_at: Option<String>,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA_V1)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn register_or_focus(&self, path: &str, name: &str) -> Result<Project> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "INSERT INTO projects (path, name, last_focused_at)
                  VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(path) DO UPDATE SET
                 last_focused_at = datetime('now'),
                 name            = excluded.name",
            params![path, name],
        )?;
        select_by_path(&conn, path)
    }

    pub fn mark_active(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "UPDATE projects SET last_active_at = datetime('now') WHERE path = ?1",
            params![path],
        )?;
        Ok(())
    }

    pub fn list_recents(&self, limit: usize) -> Result<Vec<Project>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        // Smart sort: MAX of (last_active_at, last_focused_at - 1h).
        // Focus events are demoted by 1h so they only outrank an active event
        // if they're more than an hour newer (i.e. the user definitely came
        // back to the project but hasn't typed yet).
        let mut stmt = conn.prepare(
            "SELECT id, path, name, last_focused_at, last_active_at
               FROM projects
              ORDER BY MAX(
                  COALESCE(last_active_at, '1970-01-01'),
                  datetime(COALESCE(last_focused_at, '1970-01-01'), '-1 hours')
              ) DESC
              LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], project_from_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn last_project(&self) -> Result<Option<Project>> {
        let recents = self.list_recents(1)?;
        Ok(recents.into_iter().next())
    }

    pub fn get_by_id(&self, id: i64) -> Result<Option<Project>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        match conn.query_row(
            "SELECT id, path, name, last_focused_at, last_active_at
               FROM projects WHERE id = ?1",
            params![id],
            project_from_row,
        ) {
            Ok(p) => Ok(Some(p)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn mark_focused(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "UPDATE projects SET last_focused_at = datetime('now') WHERE path = ?1",
            params![path],
        )?;
        Ok(())
    }
}

fn select_by_path(conn: &Connection, path: &str) -> Result<Project> {
    conn.query_row(
        "SELECT id, path, name, last_focused_at, last_active_at
           FROM projects WHERE path = ?1",
        params![path],
        project_from_row,
    )
    .map_err(Into::into)
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        last_focused_at: row.get(3)?,
        last_active_at: row.get(4)?,
    })
}
