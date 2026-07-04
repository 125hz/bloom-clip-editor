// ffmpeg.rs - locating and running the bundled ffmpeg/ffprobe sidecar binaries

use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";

/// Resolve a bundled tool. Tauri copies `externalBin` sidecars next to the app
/// executable (both `tauri dev` and bundled installs); fall back to the source
/// binaries dir for plain `cargo run`.
pub fn tool_path(name: &str) -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidates = [
                dir.join(format!("{name}.exe")),
                dir.join(format!("{name}-{TARGET_TRIPLE}.exe")),
            ];
            for c in candidates {
                if c.exists() {
                    return Ok(c);
                }
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-{TARGET_TRIPLE}.exe"));
    if dev.exists() {
        return Ok(dev);
    }
    Err(format!("{name} binary not found next to the application"))
}

pub fn command(name: &str) -> Result<Command, String> {
    let mut cmd = Command::new(tool_path(name)?);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

/// Run to completion, returning stdout. Errors carry the tail of stderr.
pub fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("failed to spawn process: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err
            .lines()
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        Err(if tail.is_empty() {
            format!("process exited with {:?}", out.status.code())
        } else {
            tail
        })
    }
}

/// Stable cache key for derived files (audio extractions, thumbnails).
pub fn cache_key(path: &str, extra: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    extra.hash(&mut h);
    if let Ok(meta) = std::fs::metadata(path) {
        meta.len().hash(&mut h);
        if let Ok(m) = meta.modified() {
            if let Ok(d) = m.duration_since(std::time::UNIX_EPOCH) {
                d.as_secs().hash(&mut h);
            }
        }
    }
    format!("{:016x}", h.finish())
}

pub fn cache_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("bloom-editor-cache");
    let _ = std::fs::create_dir_all(&dir);
    dir
}
