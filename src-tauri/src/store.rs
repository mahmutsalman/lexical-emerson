use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS projects (
    id              INTEGER PRIMARY KEY,
    path            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    last_focused_at TEXT,
    last_active_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_recent
    ON projects(last_active_at DESC, last_focused_at DESC);

CREATE TABLE IF NOT EXISTS buckets (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    cursor     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bucket_projects (
    bucket_id  INTEGER NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    PRIMARY KEY (bucket_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_bucket_projects_order
    ON bucket_projects(bucket_id, position);

CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
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
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
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

    // --- buckets -----------------------------------------------------------

    pub fn list_buckets(&self) -> Result<Vec<Bucket>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, cursor FROM buckets ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (id, name, cursor) = r?;
            let projects = load_bucket_projects(&conn, id)?;
            out.push(Bucket { id, name, cursor, projects });
        }
        Ok(out)
    }

    pub fn create_bucket(&self, name: &str) -> Result<Bucket> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute("INSERT INTO buckets (name) VALUES (?1)", params![name])?;
        let id = conn.last_insert_rowid();
        Ok(Bucket {
            id,
            name: name.to_string(),
            cursor: 0,
            projects: Vec::new(),
        })
    }

    pub fn delete_bucket(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute("DELETE FROM buckets WHERE id = ?1", params![id])?;
        // Also clear active_bucket_id if it matched.
        conn.execute(
            "DELETE FROM app_meta WHERE key = 'active_bucket_id' AND value = ?1",
            params![id.to_string()],
        )?;
        Ok(())
    }

    pub fn rename_bucket(&self, id: i64, name: &str) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "UPDATE buckets SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }

    pub fn add_to_bucket(&self, bucket_id: i64, project_id: i64) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        // Already in bucket? No-op.
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM bucket_projects WHERE bucket_id = ?1 AND project_id = ?2",
            params![bucket_id, project_id],
            |row| row.get(0),
        )?;
        if exists > 0 {
            return Ok(());
        }
        let next_pos: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM bucket_projects WHERE bucket_id = ?1",
            params![bucket_id],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO bucket_projects (bucket_id, project_id, position)
                  VALUES (?1, ?2, ?3)",
            params![bucket_id, project_id, next_pos],
        )?;
        Ok(())
    }

    pub fn remove_from_bucket(&self, bucket_id: i64, project_id: i64) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "DELETE FROM bucket_projects
              WHERE bucket_id = ?1 AND project_id = ?2",
            params![bucket_id, project_id],
        )?;
        Ok(())
    }

    pub fn set_active_bucket(&self, id: Option<i64>) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        match id {
            Some(id) => {
                conn.execute(
                    "INSERT INTO app_meta (key, value) VALUES ('active_bucket_id', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![id.to_string()],
                )?;
            }
            None => {
                conn.execute(
                    "DELETE FROM app_meta WHERE key = 'active_bucket_id'",
                    [],
                )?;
            }
        }
        Ok(())
    }

    pub fn get_active_bucket(&self) -> Result<Option<i64>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        match conn.query_row(
            "SELECT value FROM app_meta WHERE key = 'active_bucket_id'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            Ok(s) => Ok(s.parse::<i64>().ok()),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    // Advance the active bucket's cursor by `direction` (+1 or -1), persist the
    // new cursor, and return the (project_id, project_path, project_name) at
    // that position. Returns None if there's no active bucket or it's empty.
    pub fn cycle_active_bucket(&self, direction: i32) -> Result<Option<Project>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        let active_id: Option<i64> = match conn.query_row(
            "SELECT value FROM app_meta WHERE key = 'active_bucket_id'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            Ok(s) => s.parse::<i64>().ok(),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.into()),
        };
        let Some(bucket_id) = active_id else {
            return Ok(None);
        };
        let projects = load_bucket_projects(&conn, bucket_id)?;
        if projects.is_empty() {
            return Ok(None);
        }
        let cursor: i64 = conn.query_row(
            "SELECT cursor FROM buckets WHERE id = ?1",
            params![bucket_id],
            |row| row.get(0),
        )?;
        let len = projects.len() as i64;
        let next = ((cursor + direction as i64) % len + len) % len;
        conn.execute(
            "UPDATE buckets SET cursor = ?1 WHERE id = ?2",
            params![next, bucket_id],
        )?;
        Ok(Some(projects[next as usize].clone()))
    }
}

#[derive(Serialize, Clone)]
pub struct Bucket {
    pub id: i64,
    pub name: String,
    pub cursor: i64,
    pub projects: Vec<Project>,
}

fn load_bucket_projects(
    conn: &Connection,
    bucket_id: i64,
) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.path, p.name, p.last_focused_at, p.last_active_at
           FROM bucket_projects bp
           JOIN projects p ON p.id = bp.project_id
          WHERE bp.bucket_id = ?1
          ORDER BY bp.position ASC",
    )?;
    let rows = stmt.query_map(params![bucket_id], project_from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
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
