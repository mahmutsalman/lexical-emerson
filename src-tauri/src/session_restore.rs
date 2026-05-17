use std::path::PathBuf;
use std::time::{Duration, SystemTime};

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
