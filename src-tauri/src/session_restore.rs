use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

// How far back of an mtime gap we tolerate when matching a tab's cwd to a
// Claude session file. Anything older than this is assumed to be an
// abandoned/historical conversation we shouldn't auto-resume.
const SESSION_MTIME_WINDOW: Duration = Duration::from_secs(6 * 60 * 60);

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

// Find the most-recently-modified Claude session `.jsonl` in `cwd`'s project
// dir that hasn't already been claimed by another tab in the same persist
// batch. Returns the bare UUID stem (no extension) so the caller can later
// inject `claude --resume <uuid>`. `claimed` is the running set of UUIDs
// already assigned to prior tabs — disambiguates two tabs sharing a cwd.
pub fn detect_claude_session(cwd: &str, claimed: &mut HashSet<String>) -> Option<String> {
    let dir = claude_project_dir(cwd)?;
    let entries = std::fs::read_dir(&dir).ok()?;
    let now = SystemTime::now();
    let cutoff = now.checked_sub(SESSION_MTIME_WINDOW)?;

    let mut best: Option<(SystemTime, String)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if claimed.contains(&stem) {
            continue;
        }
        let mtime = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if mtime < cutoff {
            continue;
        }
        if best.as_ref().map_or(true, |(t, _)| mtime > *t) {
            best = Some((mtime, stem));
        }
    }

    let (_, uuid) = best?;
    claimed.insert(uuid.clone());
    Some(uuid)
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
    fn detect_claude_session_picks_newest_unclaimed() {
        let tmp = tempdir();
        let cwd = "/tmp/my-fake-cwd";
        let encoded = encode_cwd(cwd);
        let claude_dir = tmp.join(".claude/projects").join(&encoded);
        fs::create_dir_all(&claude_dir).unwrap();

        let now = SystemTime::now();

        let older = claude_dir.join("aaaaaaaa.jsonl");
        File::create(&older).unwrap();
        let newer = claude_dir.join("bbbbbbbb.jsonl");
        File::create(&newer).unwrap();
        // Touch the second file ~1 second later so its mtime is strictly newer.
        // We approximate by writing one extra byte and relying on file system
        // mtime granularity.
        std::thread::sleep(Duration::from_millis(10));
        let mut f = File::create(&newer).unwrap();
        f.write_all(b"x").unwrap();
        let _ = now; // mtime cutoff is computed inside detect; no assertion here.

        std::env::set_var("HOME", tmp.to_str().unwrap());
        let mut claimed = HashSet::new();
        assert_eq!(
            detect_claude_session(cwd, &mut claimed),
            Some("bbbbbbbb".to_string())
        );
        // Second call with the same `claimed` set should fall back to the older.
        assert_eq!(
            detect_claude_session(cwd, &mut claimed),
            Some("aaaaaaaa".to_string())
        );
        // Third call: nothing left.
        assert_eq!(detect_claude_session(cwd, &mut claimed), None);
    }

    #[test]
    fn detect_returns_none_when_dir_missing() {
        let tmp = tempdir();
        std::env::set_var("HOME", tmp.to_str().unwrap());
        let mut claimed = HashSet::new();
        assert_eq!(
            detect_claude_session("/tmp/never-existed", &mut claimed),
            None
        );
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
