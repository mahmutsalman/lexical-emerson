// Project persistence layer.
//
// For M1 this is intentionally empty — we have no SQLite store yet, and a
// single window's project context lives only in frontend Solid state.
//
// M2 will add:
//   - `pub struct Project { id, path, name, last_focused_at, last_active_at }`
//   - `pub struct ProjectStore { conn: Mutex<Connection> }` backed by rusqlite WAL.
//   - smart-sort query: ORDER BY MAX(last_active_at, datetime(last_focused_at, '-1 hours')) DESC LIMIT 20
//   - 30s-debounced PTY-stdin activity tracker that updates last_active_at.
//
// See docs/ADRs/0003-rusqlite-over-json.md.
