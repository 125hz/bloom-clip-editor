// Bloom Editor - Tauri backend
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod export;
mod ffmpeg;

use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

// -------------------- probe --------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoInfo {
    width: u32,
    height: u32,
    fps: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioStreamInfo {
    order: u32,
    index: u32,
    channels: u32,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    duration: f64,
    video: Option<VideoInfo>,
    audio_streams: Vec<AudioStreamInfo>,
}

fn parse_fps(s: &str) -> f64 {
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() == 2 {
        let a: f64 = parts[0].parse().unwrap_or(0.0);
        let b: f64 = parts[1].parse().unwrap_or(0.0);
        if a > 0.0 && b > 0.0 {
            return a / b;
        }
    }
    s.parse().unwrap_or(0.0)
}

#[tauri::command]
async fn probe_media(path: String) -> Result<ProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = ffmpeg::command("ffprobe")?;
        cmd.args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            &path,
        ]);
        let out = ffmpeg::run(&mut cmd)?;
        let data: serde_json::Value =
            serde_json::from_str(&out).map_err(|e| format!("ffprobe parse: {e}"))?;

        let duration = data["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);

        let empty = Vec::new();
        let streams = data["streams"].as_array().unwrap_or(&empty);

        let video = streams
            .iter()
            .find(|s| s["codec_type"] == "video")
            .map(|s| VideoInfo {
                width: s["width"].as_u64().unwrap_or(0) as u32,
                height: s["height"].as_u64().unwrap_or(0) as u32,
                fps: parse_fps(s["r_frame_rate"].as_str().unwrap_or("")),
            });

        let audio_streams = streams
            .iter()
            .filter(|s| s["codec_type"] == "audio")
            .enumerate()
            .map(|(order, s)| AudioStreamInfo {
                order: order as u32,
                index: s["index"].as_u64().unwrap_or(0) as u32,
                channels: s["channels"].as_u64().unwrap_or(0) as u32,
                title: s["tags"]["title"]
                    .as_str()
                    .or_else(|| s["tags"]["TITLE"].as_str())
                    .unwrap_or("")
                    .to_string(),
            })
            .collect();

        Ok(ProbeResult {
            duration,
            video,
            audio_streams,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// -------------------- audio extraction --------------------

#[tauri::command]
async fn extract_audio(path: String, stream_index: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = ffmpeg::cache_key(&path, &format!("audio-s{stream_index}"));
        let out = ffmpeg::cache_dir().join(format!("audio_{key}.wav"));
        if out.exists() {
            return Ok(out.to_string_lossy().into_owned());
        }
        let mut cmd = ffmpeg::command("ffmpeg")?;
        cmd.args([
            "-y",
            "-v",
            "error",
            "-i",
            &path,
            "-map",
            &format!("0:{stream_index}"),
            "-vn",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-c:a",
            "pcm_s16le",
        ]);
        cmd.arg(&out);
        ffmpeg::run(&mut cmd)?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

// -------------------- thumbnails --------------------

#[tauri::command]
async fn generate_thumbnail(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = ffmpeg::cache_key(&path, "thumb");
        let out = ffmpeg::cache_dir().join(format!("thumb_{key}.jpg"));
        if out.exists() {
            return Ok(out.to_string_lossy().into_owned());
        }
        let mut cmd = ffmpeg::command("ffmpeg")?;
        cmd.args([
            "-y", "-v", "error", "-ss", "0", "-i", &path, "-vframes", "1", "-vf", "scale=-2:120",
        ]);
        cmd.arg(&out);
        ffmpeg::run(&mut cmd)?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

// -------------------- export --------------------

#[tauri::command]
async fn export_project(
    app: tauri::AppHandle,
    payload: export::ExportPayload,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<export::ExportState>();
        export::run_export(&app, &state, payload)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_export(state: tauri::State<export::ExportState>) {
    state.cancelled.store(true, Ordering::SeqCst);
    let pid = state.child_pid.load(Ordering::SeqCst);
    let worker_pid = state.worker_pid.load(Ordering::SeqCst);
    if pid != 0 {
        #[cfg(windows)]
        {
            let mut kill = std::process::Command::new("taskkill");
            kill.args(["/F", "/T", "/PID", &pid.to_string()]);
            kill.creation_flags(0x0800_0000);
            let _ = kill.status();
            if worker_pid != 0 {
                let mut kill_worker = std::process::Command::new("taskkill");
                kill_worker.args(["/F", "/PID", &worker_pid.to_string()]);
                kill_worker.creation_flags(0x0800_0000);
                let _ = kill_worker.status();
            }
        }
    }
}

#[tauri::command]
fn finish_export(state: tauri::State<export::ExportState>) {
    state.finish_requested.store(true, Ordering::SeqCst);
    let worker_pid = state.worker_pid.load(Ordering::SeqCst);
    #[cfg(windows)]
    if worker_pid != 0 {
        let mut kill = std::process::Command::new("taskkill");
        kill.args(["/F", "/PID", &worker_pid.to_string()]);
        kill.creation_flags(0x0800_0000);
        let _ = kill.status();
    }
}

// -------------------- clipboard --------------------

/// Place a file on the Windows clipboard as CF_HDROP, so standard paste
/// targets receive the video file rather than a text path.
#[cfg(windows)]
#[tauri::command]
fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::mem::size_of;
    use std::ptr;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::DROPFILES;

    if !std::path::Path::new(&path).is_file() {
        return Err("exported video file no longer exists".into());
    }

    // DROPFILES is followed by one or more NUL-terminated UTF-16 paths and
    // a final NUL. A single file therefore needs two trailing zeroes.
    let wide: Vec<u16> = OsStr::new(&path)
        .encode_wide()
        .chain(std::iter::once(0))
        .chain(std::iter::once(0))
        .collect();
    let bytes = size_of::<DROPFILES>() + wide.len() * size_of::<u16>();

    unsafe {
        let hmem = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| format!("clipboard allocation failed: {e}"))?;
        let data = GlobalLock(hmem) as *mut u8;
        if data.is_null() {
            let _ = GlobalFree(Some(hmem));
            return Err("clipboard allocation could not be locked".into());
        }
        ptr::write_unaligned(
            data.cast::<DROPFILES>(),
            DROPFILES {
                pFiles: size_of::<DROPFILES>() as u32,
                fWide: BOOL(1),
                ..Default::default()
            },
        );
        ptr::copy_nonoverlapping(
            wide.as_ptr(),
            data.add(size_of::<DROPFILES>()).cast::<u16>(),
            wide.len(),
        );
        let _ = GlobalUnlock(hmem);

        OpenClipboard(None).map_err(|e| {
            let _ = GlobalFree(Some(hmem));
            format!("could not open clipboard: {e}")
        })?;
        if let Err(e) = EmptyClipboard() {
            let _ = CloseClipboard();
            let _ = GlobalFree(Some(hmem));
            return Err(format!("could not clear clipboard: {e}"));
        }
        if let Err(e) = SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hmem.0))) {
            let _ = CloseClipboard();
            let _ = GlobalFree(Some(hmem));
            return Err(format!("could not set clipboard data: {e}"));
        }
        let _ = CloseClipboard();
    }
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn copy_file_to_clipboard(_path: String) -> Result<(), String> {
    Err("copying exported files to the clipboard is currently supported on Windows only".into())
}

// -------------------- project save / load --------------------

#[tauri::command]
fn save_project(path: String, data: String) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| format!("failed to save project: {e}"))
}

#[tauri::command]
fn load_project(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("failed to read project: {e}"))
}

// -------------------- status --------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuInfo {
    name: String,
    dedicated_bytes: u64,
    auto_threads: u32,
}

#[tauri::command]
fn gpu_info() -> GpuInfo {
    match export::gpu_adapter_info() {
        Some((name, vram)) => GpuInfo {
            name,
            dedicated_bytes: vram,
            auto_threads: export::detect_gpu_threads(),
        },
        None => GpuInfo {
            name: "unknown GPU".into(),
            dedicated_bytes: 0,
            auto_threads: 1,
        },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    ffmpeg_ok: bool,
    ffprobe_ok: bool,
}

#[tauri::command]
fn tool_status() -> ToolStatus {
    ToolStatus {
        ffmpeg_ok: ffmpeg::tool_path("ffmpeg").is_ok(),
        ffprobe_ok: ffmpeg::tool_path("ffprobe").is_ok(),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(export::ExportState::default())
        .setup(|app| {
            // default window size: 75% of the primary monitor, centered
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = win.primary_monitor() {
                    let s = monitor.size();
                    let _ = win.set_size(tauri::PhysicalSize::new(
                        (s.width as f64 * 0.75).round() as u32,
                        (s.height as f64 * 0.75).round() as u32,
                    ));
                    let _ = win.center();
                }
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_media,
            extract_audio,
            generate_thumbnail,
            export_project,
            cancel_export,
            finish_export,
            copy_file_to_clipboard,
            save_project,
            load_project,
            tool_status,
            gpu_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running bloom editor");
}
