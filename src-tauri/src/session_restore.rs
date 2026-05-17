use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Serialize;

// Absolute cutoff for considering a .jsonl plausibly recent at all. 48h
// covers "left it overnight" / "came back after a weekend" cases while
// rejecting jsonl files that have been sitting in the cwd for weeks.
const SESSION_MTIME_WINDOW: Duration = Duration::from_secs(48 * 60 * 60);
// Cluster window — once we find the newest .jsonl, only include other
// .jsonls touched within this window of THAT newest mtime. Filters out
// older-but-still-within-48h conversations that the user isn't actively
// resuming. 1h is enough to keep a parallel session that was idle while
// the user typed in another, but tight enough to exclude sessions from
// earlier in the day.
const ACTIVE_CLUSTER_WINDOW: Duration = Duration::from_secs(60 * 60);

// Encode an absolute cwd the way Claude Code names its per-project dir under
// `~/.claude/projects/`: every `/` becomes `-`. Verified by inspecting the
// directory on disk — `/Users/foo/bar` → `-Users-foo-bar`. Dots and other
// characters are preserved verbatim.
pub fn encode_cwd(cwd: &str) -> String {
    cwd.replace('/', "-")
}

fn claude_project_dir(cwd: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".claude/projects").join(encode_cwd(cwd)))
}

// Find every Claude session `.jsonl` in `cwd`'s project dir that is within
// the SESSION_MTIME_WINDOW, ordered newest-first. Returns just the UUID
// stems (no extension) so callers can inject `claude --resume <uuid>`.
//
// Persist writes one row per returned UUID — that's how a project with
// three active Claude conversations comes back as three tabs even if the
// user only had one terminal tab open at quit time.
pub fn detect_active_claude_sessions(cwd: &str) -> Vec<String> {
    let Some(dir) = claude_project_dir(cwd) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let now = SystemTime::now();
    let Some(cutoff) = now.checked_sub(SESSION_MTIME_WINDOW) else {
        return Vec::new();
    };

    let mut candidates: Vec<(SystemTime, String)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let mtime = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if mtime < cutoff {
            continue;
        }
        candidates.push((mtime, stem));
    }
    // Newest first so persist writes them in the order the user is likely
    // to want to see them (most-recent tab on the left / first restored).
    candidates.sort_by(|a, b| b.0.cmp(&a.0));

    // Cluster filter: anchor on the newest .jsonl and drop anything more
    // than ACTIVE_CLUSTER_WINDOW older than it. Without this, a project
    // dir with five .jsonl files spread across the last day would restore
    // five tabs even if only two were part of the current work session.
    if let Some((newest, _)) = candidates.first().cloned() {
        if let Some(cluster_cutoff) = newest.checked_sub(ACTIVE_CLUSTER_WINDOW) {
            candidates.retain(|(t, _)| *t >= cluster_cutoff);
        }
    }

    candidates.into_iter().map(|(_, s)| s).collect()
}

// Check whether the session file referenced by `claude_session_id` is still
// on disk. The frontend uses this at restore time to decide between
// `claude --resume <uuid>` and a bare `claude` invocation.
pub fn session_file_exists(cwd: &str, claude_session_id: &str) -> bool {
    let Some(dir) = claude_project_dir(cwd) else {
        return false;
    };
    let file = dir.join(format!("{claude_session_id}.jsonl"));
    file.is_file()
}

// Path to a session's JSONL file under ~/.claude/projects/<encoded-cwd>/.
// Returns Err if HOME isn't set or the file doesn't exist.
fn session_jsonl_path(cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    let dir = claude_project_dir(cwd).ok_or_else(|| "HOME not set".to_string())?;
    let path = dir.join(format!("{session_id}.jsonl"));
    if !path.is_file() {
        return Err(format!("session file not found: {}", path.display()));
    }
    Ok(path)
}

// --- D2: transcript reading (suspended-session preview + full viewer) -----

// Returned by peek_session_transcript for SuspendedPlaceholder's preview card.
// Intentionally minimal: only enough to render the card without paying the
// cost of a full parse. The viewer modal calls read_session_transcript when
// the user actually clicks "Read transcript".
#[derive(Serialize)]
pub struct TranscriptPeek {
    pub session_id: String,
    // ISO 8601 timestamp of the most recent line within the tail we scanned.
    // None if no line in the tail carried a `timestamp` field (rare —
    // permission-mode / ai-title lines don't, but user/assistant always do).
    pub last_at: Option<String>,
    // First ~220 chars of the most recent assistant text content block found
    // in the tail. None if the tail contained no assistant message with a
    // text block (e.g. session that ended on a tool result, fresh session
    // with no replies yet).
    pub last_assistant_preview: Option<String>,
    pub total_bytes: u64,
}

// Cap on how many bytes of the JSONL we scan from the END of the file when
// peeking. ~64 KB is large enough to cover the last ~10–60 message lines in
// a typical session (assistant lines are 1–5 KB; some image-bearing lines
// can be 500 KB+ but still rare in the tail). For a 40 MB session this is
// 600× cheaper than full parse — keeps the placeholder snappy.
const PEEK_TAIL_BYTES: u64 = 65_536;

pub fn peek_session_transcript(
    cwd: &str,
    session_id: &str,
) -> Result<TranscriptPeek, String> {
    let path = session_jsonl_path(cwd, session_id)?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("metadata: {e}"))?;
    let total_bytes = metadata.len();

    let mut file = std::fs::File::open(&path).map_err(|e| format!("open: {e}"))?;
    let read_from_end = PEEK_TAIL_BYTES.min(total_bytes);
    let offset = total_bytes - read_from_end;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("seek: {e}"))?;
    }
    let mut buf = String::new();
    file.read_to_string(&mut buf)
        .map_err(|e| format!("read: {e}"))?;

    // When we seeked into the middle of the file the first line is a partial
    // — skip it. When the file is small enough that we read from offset 0,
    // keep every line.
    let lines: Vec<&str> = if offset == 0 {
        buf.lines().collect()
    } else {
        buf.lines().skip(1).collect()
    };

    // Walk forward, overwriting on every hit, so both fields end up holding
    // the LAST occurrence in the tail by the time we finish.
    let mut last_at: Option<String> = None;
    let mut last_assistant_preview: Option<String> = None;
    for line in lines {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) {
            last_at = Some(ts.to_string());
        }
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(content) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) != Some("text") {
                continue;
            }
            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                let truncated: String = text.chars().take(220).collect();
                last_assistant_preview = Some(truncated);
                break;
            }
        }
    }

    Ok(TranscriptPeek {
        session_id: session_id.to_string(),
        last_at,
        last_assistant_preview,
        total_bytes,
    })
}

// Full transcript for the viewer modal. Applies a 5 MB cap to keep IPC
// payload + JS heap reasonable; oversized files come back with `truncated:
// true` and only the last 5 MB worth of lines. The 95th percentile file is
// ~2.6 MB so this rarely fires; when it does the user sees their most
// recent activity (which is what they want when reviewing).
#[derive(Serialize)]
pub struct TranscriptResponse {
    pub session_id: String,
    pub lines: Vec<serde_json::Value>,
    pub truncated: bool,
    pub total_bytes: u64,
}

const TRANSCRIPT_CAP_BYTES: u64 = 5 * 1024 * 1024;

pub fn read_session_transcript(
    cwd: &str,
    session_id: &str,
) -> Result<TranscriptResponse, String> {
    let path = session_jsonl_path(cwd, session_id)?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("metadata: {e}"))?;
    let total_bytes = metadata.len();
    let truncated = total_bytes > TRANSCRIPT_CAP_BYTES;

    let mut file = std::fs::File::open(&path).map_err(|e| format!("open: {e}"))?;
    let mut buf = String::new();
    if truncated {
        let offset = total_bytes - TRANSCRIPT_CAP_BYTES;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("seek: {e}"))?;
    }
    file.read_to_string(&mut buf)
        .map_err(|e| format!("read: {e}"))?;

    let raw_lines: Vec<&str> = if truncated {
        buf.lines().skip(1).collect()
    } else {
        buf.lines().collect()
    };
    let parsed: Vec<serde_json::Value> = raw_lines
        .into_iter()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect();

    Ok(TranscriptResponse {
        session_id: session_id.to_string(),
        lines: parsed,
        truncated,
        total_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;

    #[test]
    fn encode_cwd_replaces_slashes() {
        assert_eq!(encode_cwd("/Users/me/foo"), "-Users-me-foo");
        assert_eq!(encode_cwd("/a/b.c/d"), "-a-b.c-d");
        assert_eq!(encode_cwd(""), "");
    }

    #[test]
    fn detect_active_returns_all_sessions_newest_first() {
        let tmp = tempdir();
        let cwd = "/tmp/my-fake-cwd";
        let encoded = encode_cwd(cwd);
        let claude_dir = tmp.join(".claude/projects").join(&encoded);
        fs::create_dir_all(&claude_dir).unwrap();

        let older = claude_dir.join("aaaaaaaa.jsonl");
        File::create(&older).unwrap();
        let newer = claude_dir.join("bbbbbbbb.jsonl");
        File::create(&newer).unwrap();
        // Touch the second file ~10 ms later so its mtime is strictly newer.
        std::thread::sleep(Duration::from_millis(10));
        let mut f = File::create(&newer).unwrap();
        f.write_all(b"x").unwrap();

        std::env::set_var("HOME", tmp.to_str().unwrap());
        let result = detect_active_claude_sessions(cwd);
        assert_eq!(
            result,
            vec!["bbbbbbbb".to_string(), "aaaaaaaa".to_string()],
            "expected newest first, then older"
        );
    }

    #[test]
    fn detect_active_returns_empty_when_dir_missing() {
        let tmp = tempdir();
        std::env::set_var("HOME", tmp.to_str().unwrap());
        assert!(detect_active_claude_sessions("/tmp/never-existed").is_empty());
    }

    // Minimal tempdir helper — avoids pulling in the `tempfile` crate just for
    // these tests. Returns a process-unique directory under the OS temp dir;
    // not cleaned up, which is fine for short-lived test runs.
    fn tempdir() -> PathBuf {
        let pid = std::process::id();
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("lexem-test-{pid}-{nanos}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}
