// Bloom Editor - Tauri backend
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod export;
mod ffmpeg;

use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

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
    if pid != 0 {
        #[cfg(windows)]
        {
            let mut kill = std::process::Command::new("taskkill");
            kill.args(["/F", "/T", "/PID", &pid.to_string()]);
            kill.creation_flags(0x0800_0000);
            let _ = kill.status();
        }
    }
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
            save_project,
            load_project,
            tool_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running bloom editor");
}
