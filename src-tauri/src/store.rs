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
    last_active_at  TEXT,
    color           TEXT,
    zoom            REAL NOT NULL DEFAULT 1.0,
    hidden_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_recent
    ON projects(last_active_at DESC, last_focused_at DESC);

CREATE TABLE IF NOT EXISTS buckets (
    id                    INTEGER PRIMARY KEY,
    name                  TEXT NOT NULL,
    cursor                INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    auto_restore_sessions INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS notes (
    id           INTEGER PRIMARY KEY,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title        TEXT NOT NULL DEFAULT '',
    user_title   TEXT,
    content_json TEXT NOT NULL DEFAULT '{\"ops\":[]}',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_project_recent
    ON notes(project_id, updated_at DESC);

-- Per-project ordered snapshot written at app-quit/window-close when at
-- least one bucket containing the project has auto_restore_sessions=1.
-- One row per terminal tab; restoration spawns a fresh PTY at `cwd` and
-- (if claude_session_id is non-null and the .jsonl still exists) injects
-- `claude --resume <uuid>` so Claude rehydrates the on-disk transcript.
CREATE TABLE IF NOT EXISTS persisted_terminals (
    id                INTEGER PRIMARY KEY,
    project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cwd               TEXT NOT NULL,
    claude_session_id TEXT,
    position          INTEGER NOT NULL DEFAULT 0,
    saved_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_persisted_terminals_project
    ON persisted_terminals(project_id, position);
";

#[derive(Serialize, Clone)]
pub struct Project {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub last_focused_at: Option<String>,
    pub last_active_at: Option<String>,
    pub color: Option<String>,
    pub zoom: f64,
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
        // Additive column migrations for tables that may pre-exist from an
        // earlier dev run. CREATE TABLE IF NOT EXISTS is a no-op once the
        // table exists, so new columns must be ALTERed in by hand.
        migrate_notes_columns(&conn)?;
        migrate_projects_columns(&conn)?;
        migrate_buckets_columns(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn register_or_focus(&self, path: &str, name: &str) -> Result<Project> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        // Re-opening a project clears any prior soft-hide so it returns to the
        // recents list (mirrors the user's mental model of "I opened it again,
        // so it's relevant again").
        conn.execute(
            "INSERT INTO projects (path, name, last_focused_at)
                  VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(path) DO UPDATE SET
                 last_focused_at = datetime('now'),
                 name            = excluded.name,
                 hidden_at       = NULL",
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
            "SELECT id, path, name, last_focused_at, last_active_at, color, zoom
               FROM projects
              WHERE hidden_at IS NULL
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
            "SELECT id, path, name, last_focused_at, last_active_at, color, zoom
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

    pub fn set_project_color(&self, id: i64, color: Option<&str>) -> Result<Project> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "UPDATE projects SET color = ?1 WHERE id = ?2",
            params![color, id],
        )?;
        conn.query_row(
            "SELECT id, path, name, last_focused_at, last_active_at, color, zoom
               FROM projects WHERE id = ?1",
            params![id],
            project_from_row,
        )
        .map_err(Into::into)
    }

    pub fn set_project_zoom(&self, id: i64, zoom: f64) -> Result<Project> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "UPDATE projects SET zoom = ?1 WHERE id = ?2",
            params![zoom, id],
        )?;
        conn.query_row(
            "SELECT id, path, name, last_focused_at, last_active_at, color, zoom
               FROM projects WHERE id = ?1",
            params![id],
            project_from_row,
        )
        .map_err(Into::into)
    }

    // Soft-hide: project keeps its row (notes + bucket memberships survive)
    // but is excluded from the recents list. Reopening the folder clears
    // hidden_at via register_or_focus.
    pub fn hide_project(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "UPDATE projects SET hidden_at = datetime('now') WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    // --- buckets -----------------------------------------------------------

    pub fn list_buckets(&self) -> Result<Vec<Bucket>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, cursor, auto_restore_sessions
               FROM buckets
              ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (id, name, cursor, auto_restore) = r?;
            let projects = load_bucket_projects(&conn, id)?;
            out.push(Bucket {
                id,
                name,
                cursor,
                projects,
                auto_restore_sessions: auto_restore != 0,
            });
        }
        Ok(out)
    }

    pub fn get_bucket(&self, id: i64) -> Result<Option<Bucket>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        match conn.query_row(
            "SELECT id, name, cursor, auto_restore_sessions FROM buckets WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        ) {
            Ok((id, name, cursor, auto_restore)) => {
                let projects = load_bucket_projects(&conn, id)?;
                Ok(Some(Bucket {
                    id,
                    name,
                    cursor,
                    projects,
                    auto_restore_sessions: auto_restore != 0,
                }))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
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
            auto_restore_sessions: false,
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

    /// Move the bucket's cursor to point at `project_id`. Cursor is a
    /// 0-based rank into the position-ordered project list (matches
    /// `load_bucket_projects`'s ORDER BY position ASC), not the
    /// `position` column itself — positions can be sparse after a
    /// `remove_from_bucket`, but the cursor in `cycle_active_bucket`
    /// is bounded by the live project count via modulo, so it's
    /// always interpreted as a rank.
    ///
    /// Returns Err if the project isn't a member of the bucket.
    pub fn set_bucket_cursor_to_project(
        &self,
        bucket_id: i64,
        project_id: i64,
    ) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        // Count members whose position is strictly less than the target —
        // that count IS the target's 0-based rank. Wrapped in a presence
        // check so "first project (rank 0)" and "not in bucket (rank 0)"
        // are disambiguated.
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM bucket_projects
              WHERE bucket_id = ?1 AND project_id = ?2",
            params![bucket_id, project_id],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(anyhow!(
                "project {project_id} is not in bucket {bucket_id}"
            ));
        }
        let rank: i64 = conn.query_row(
            "SELECT COUNT(*) FROM bucket_projects
              WHERE bucket_id = ?1
                AND position < (
                  SELECT position FROM bucket_projects
                   WHERE bucket_id = ?1 AND project_id = ?2
                )",
            params![bucket_id, project_id],
            |row| row.get(0),
        )?;
        conn.execute(
            "UPDATE buckets SET cursor = ?1 WHERE id = ?2",
            params![rank, bucket_id],
        )?;
        Ok(())
    }

    /// Rewrite the position column for every project in `project_ids` so the
    /// bucket's order matches the slice exactly. Ids absent from the slice
    /// are left untouched — callers are expected to pass the full bucket
    /// membership; partial slices would leave stale positions colliding with
    /// the new ones, which the per-row UPDATE wouldn't catch.
    ///
    /// All UPDATEs run inside a single transaction so a half-applied reorder
    /// can't be observed by a concurrent `list_buckets` call. Positions are
    /// zero-based and dense for symmetry with `add_to_bucket`'s
    /// `COALESCE(MAX, -1) + 1` insert path.
    pub fn set_bucket_project_order(
        &self,
        bucket_id: i64,
        project_ids: &[i64],
    ) -> Result<()> {
        let mut conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        let tx = conn.transaction()?;
        for (pos, pid) in project_ids.iter().enumerate() {
            tx.execute(
                "UPDATE bucket_projects
                    SET position = ?1
                  WHERE bucket_id = ?2 AND project_id = ?3",
                params![pos as i64, bucket_id, pid],
            )?;
        }
        tx.commit()?;
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

    // --- session restore --------------------------------------------------

    // Flip the per-bucket "auto-restore Claude sessions" toggle. Idempotent.
    pub fn set_bucket_auto_restore(&self, bucket_id: i64, enabled: bool) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "UPDATE buckets SET auto_restore_sessions = ?1 WHERE id = ?2",
            params![if enabled { 1 } else { 0 }, bucket_id],
        )?;
        Ok(())
    }

    // True when at least one bucket containing `project_id` has the toggle on.
    // The persistence and restore paths both consult this — once the gate
    // closes, neither save nor restore happens for that project.
    pub fn project_has_auto_restore_bucket(&self, project_id: i64) -> Result<bool> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM bucket_projects bp
               JOIN buckets b ON b.id = bp.bucket_id
              WHERE bp.project_id = ?1
                AND b.auto_restore_sessions = 1",
            params![project_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    // Distinct project ids that have any persisted terminal row. Used at
    // launch to decide which project windows to auto-reopen so that each
    // window's TerminalsView can then run its own restore.
    pub fn list_persisted_project_ids(&self) -> Result<Vec<i64>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT project_id
               FROM persisted_terminals
              ORDER BY project_id",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn list_persisted_terminals_for_project(
        &self,
        project_id: i64,
    ) -> Result<Vec<PersistedTerminal>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, cwd, claude_session_id, position, saved_at
               FROM persisted_terminals
              WHERE project_id = ?1
              ORDER BY position ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok(PersistedTerminal {
                id: row.get(0)?,
                project_id: row.get(1)?,
                cwd: row.get(2)?,
                claude_session_id: row.get(3)?,
                position: row.get(4)?,
                saved_at: row.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // Replace all rows for `project_id` with the new ordered list. Uses a
    // single transaction so a concurrent reader can't observe a half-written
    // state. The caller is responsible for filtering to Claude-only tabs and
    // assigning positions before invoking.
    pub fn replace_persisted_terminals_for_project(
        &self,
        project_id: i64,
        rows: &[(String, Option<String>)],
    ) -> Result<()> {
        let mut conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM persisted_terminals WHERE project_id = ?1",
            params![project_id],
        )?;
        for (idx, (cwd, claude_session_id)) in rows.iter().enumerate() {
            tx.execute(
                "INSERT INTO persisted_terminals
                    (project_id, cwd, claude_session_id, position)
                  VALUES (?1, ?2, ?3, ?4)",
                params![project_id, cwd, claude_session_id, idx as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_persisted_terminals_for_project(&self, project_id: i64) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "DELETE FROM persisted_terminals WHERE project_id = ?1",
            params![project_id],
        )?;
        Ok(())
    }

    // --- notes -------------------------------------------------------------

    pub fn list_notes(&self, project_id: i64) -> Result<Vec<NoteSummary>> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        let mut stmt = conn.prepare(
            "SELECT id, project_id, title, user_title, updated_at
               FROM notes
              WHERE project_id = ?1
              ORDER BY updated_at DESC, id DESC",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok(NoteSummary {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                user_title: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_note(&self, id: i64) -> Result<Note> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.query_row(
            "SELECT id, project_id, title, user_title, content_json, created_at, updated_at
               FROM notes WHERE id = ?1",
            params![id],
            note_from_row,
        )
        .map_err(Into::into)
    }

    pub fn create_note(&self, project_id: i64) -> Result<Note> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "INSERT INTO notes (project_id) VALUES (?1)",
            params![project_id],
        )?;
        let id = conn.last_insert_rowid();
        conn.query_row(
            "SELECT id, project_id, title, user_title, content_json, created_at, updated_at
               FROM notes WHERE id = ?1",
            params![id],
            note_from_row,
        )
        .map_err(Into::into)
    }

    pub fn update_note(&self, id: i64, content_json: &str) -> Result<NoteSummary> {
        let title = compute_title_from_delta(content_json);
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "UPDATE notes
                SET content_json = ?1,
                    title        = ?2,
                    updated_at   = datetime('now')
              WHERE id = ?3",
            params![content_json, title, id],
        )?;
        conn.query_row(
            "SELECT id, project_id, title, user_title, updated_at
               FROM notes WHERE id = ?1",
            params![id],
            |row| {
                Ok(NoteSummary {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    title: row.get(2)?,
                    user_title: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(Into::into)
    }

    // User-controlled title. Empty string is stored as NULL so the list-side
    // fallback (user_title || auto title || "Untitled note") works cleanly.
    pub fn set_note_title(
        &self,
        id: i64,
        user_title: Option<&str>,
    ) -> Result<NoteSummary> {
        let normalized: Option<&str> = match user_title {
            Some(s) if !s.trim().is_empty() => Some(s),
            _ => None,
        };
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute(
            "UPDATE notes
                SET user_title = ?1,
                    updated_at = datetime('now')
              WHERE id = ?2",
            params![normalized, id],
        )?;
        conn.query_row(
            "SELECT id, project_id, title, user_title, updated_at
               FROM notes WHERE id = ?1",
            params![id],
            |row| {
                Ok(NoteSummary {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    title: row.get(2)?,
                    user_title: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(Into::into)
    }

    pub fn delete_note(&self, id: i64) -> Result<()> {
        let conn = self.conn.lock().map_err(|_| anyhow!("store poisoned"))?;
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(())
    }
}

// Idempotent: read the current columns and append the new ones if missing.
// Safe to call on every startup; cheap (a single pragma query).
fn migrate_notes_columns(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(notes)")?;
    let column_names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !column_names.iter().any(|n| n == "user_title") {
        conn.execute("ALTER TABLE notes ADD COLUMN user_title TEXT", [])?;
    }
    Ok(())
}

fn migrate_projects_columns(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(projects)")?;
    let column_names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !column_names.iter().any(|n| n == "color") {
        conn.execute("ALTER TABLE projects ADD COLUMN color TEXT", [])?;
    }
    if !column_names.iter().any(|n| n == "zoom") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN zoom REAL NOT NULL DEFAULT 1.0",
            [],
        )?;
        // ALTER ... DEFAULT applies to inserts only; backfill existing rows.
        conn.execute("UPDATE projects SET zoom = 1.0 WHERE zoom IS NULL", [])?;
    }
    if !column_names.iter().any(|n| n == "hidden_at") {
        conn.execute("ALTER TABLE projects ADD COLUMN hidden_at TEXT", [])?;
    }
    Ok(())
}

fn migrate_buckets_columns(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(buckets)")?;
    let column_names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !column_names.iter().any(|n| n == "auto_restore_sessions") {
        conn.execute(
            "ALTER TABLE buckets ADD COLUMN auto_restore_sessions INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}

fn note_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        user_title: row.get(3)?,
        content_json: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

// Walks a Quill Delta JSON document and returns the first non-empty trimmed
// string insert as the note's title (truncated to 80 chars). Empty docs and
// docs whose first inserts are only embeds (e.g. images) fall back to
// "Untitled note".
fn compute_title_from_delta(json: &str) -> String {
    const FALLBACK: &str = "Untitled note";
    const MAX_LEN: usize = 80;

    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return FALLBACK.to_string(),
    };
    let ops = match value.get("ops").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return FALLBACK.to_string(),
    };
    for op in ops {
        if let Some(insert) = op.get("insert").and_then(|v| v.as_str()) {
            // Take the first non-empty line of the run.
            for line in insert.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    return truncate_chars(trimmed, MAX_LEN);
                }
            }
        }
    }
    FALLBACK.to_string()
}

fn truncate_chars(s: &str, max: usize) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max {
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
}

#[derive(Serialize, Clone)]
pub struct Bucket {
    pub id: i64,
    pub name: String,
    pub cursor: i64,
    pub projects: Vec<Project>,
    pub auto_restore_sessions: bool,
}

#[derive(Serialize, Clone)]
pub struct PersistedTerminal {
    pub id: i64,
    pub project_id: i64,
    pub cwd: String,
    pub claude_session_id: Option<String>,
    pub position: i64,
    pub saved_at: String,
}

#[derive(Serialize, Clone)]
pub struct NoteSummary {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub user_title: Option<String>,
    pub updated_at: String,
}

#[derive(Serialize, Clone)]
pub struct Note {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub user_title: Option<String>,
    pub content_json: String,
    pub created_at: String,
    pub updated_at: String,
}

fn load_bucket_projects(
    conn: &Connection,
    bucket_id: i64,
) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.path, p.name, p.last_focused_at, p.last_active_at, p.color, p.zoom
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
        "SELECT id, path, name, last_focused_at, last_active_at, color, zoom
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
        color: row.get(5)?,
        zoom: row.get(6)?,
    })
}
