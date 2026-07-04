// export.rs - single-pass ffmpeg export.
//
// Builds one filter_complex graph that:
//   * per video layer: trims/scales clips, fills gaps with transparent frames,
//     concats them into one full-length stream
//   * composites layers bottom-to-top over a black base with overlay
//   * burns in text clips with drawtext (enable=between(t,..))
//   * mixes all enabled audio tracks with trim/volume/fade/delay + amix
// then encodes once with libx264 + aac. Progress is parsed from
// `-progress pipe:1` and emitted as "export-progress" events.

use serde::{Deserialize, Serialize};
use std::fmt::Write as _;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

use crate::ffmpeg;

#[derive(Default)]
pub struct ExportState {
    pub cancelled: AtomicBool,
    pub child_pid: AtomicU32,
    pub running: Mutex<()>,
}

fn default_one() -> f64 {
    1.0
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportAudioTrack {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub audio_order: u32,
    #[serde(default = "default_one")]
    pub volume: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    pub content: String,
    #[serde(default)]
    pub font: String,
    #[serde(default)]
    pub bold: bool,
    /// font size as a fraction of output height
    pub size: f64,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub outline_color: String,
    /// outline width as a fraction of output height
    #[serde(default)]
    pub outline_width: f64,
    /// normalized center position 0..1
    pub x: f64,
    pub y: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    /// normalized source rectangle 0..1
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportClip {
    pub kind: String, // "video" | "audio" | "text"
    #[serde(default)]
    pub file_path: String,
    pub start_time: f64,
    #[serde(default)]
    pub in_point: f64,
    pub duration: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    /// video stacking order: 0 = bottom layer
    #[serde(default)]
    pub layer: i64,
    /// static clip opacity 0..1 (video clips)
    #[serde(default = "default_one")]
    pub opacity: f64,
    /// crop/zoom source rectangle (video clips)
    #[serde(default)]
    pub crop: Option<CropRect>,
    #[serde(default)]
    pub audio_tracks: Vec<ExportAudioTrack>,
    pub text: Option<TextStyle>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    pub clips: Vec<ExportClip>,
    pub out_path: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    #[serde(default)]
    pub preset: String,
    #[serde(default)]
    pub target_size_bytes: f64,
    pub crf: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    percent: f64,
    current_seconds: f64,
    total_seconds: f64,
    current_frame: u64,
    total_frames: u64,
    eta_seconds: f64,
}

fn f(v: f64) -> String {
    format!("{:.4}", v.max(0.0))
}

/// Escape a value used inside a filtergraph option (wrap in single quotes).
fn q(s: &str) -> String {
    let escaped = s.replace('\\', "/").replace('\'', "\\'");
    format!("'{escaped}'")
}

fn color_hex(c: &str, fallback: &str) -> String {
    let c = c.trim().trim_start_matches('#');
    if c.len() == 6 && c.chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("0x{c}")
    } else {
        format!("0x{fallback}")
    }
}

fn font_file(font: &str, bold: bool) -> &'static str {
    match (font.to_ascii_lowercase().as_str(), bold) {
        ("consolas", false) => "consola.ttf",
        ("consolas", true) => "consolab.ttf",
        ("arial", false) => "arial.ttf",
        ("arial", true) => "arialbd.ttf",
        ("impact", _) => "impact.ttf",
        ("segoe ui", false) => "segoeui.ttf",
        ("segoe ui", true) => "segoeuib.ttf",
        ("courier new", false) => "cour.ttf",
        ("courier new", true) => "courbd.ttf",
        ("times new roman", false) => "times.ttf",
        ("times new roman", true) => "timesbd.ttf",
        ("bahnschrift", _) => "bahnschrift.ttf",
        (_, true) => "consolab.ttf",
        _ => "consola.ttf",
    }
}

fn fonts_dir() -> String {
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:/Windows".into());
    format!("{}/Fonts", windir.replace('\\', "/"))
}

struct EncodeSettings {
    video_bitrate: Option<u64>,
    crf: Option<f64>,
    audio_bitrate: &'static str,
    preset: &'static str,
}

fn encode_settings(p: &ExportPayload, total: f64) -> EncodeSettings {
    let mut s = EncodeSettings {
        video_bitrate: Some(4_000_000),
        crf: None,
        audio_bitrate: "192k",
        preset: "medium",
    };

    let mut target_bytes = p.target_size_bytes;
    match p.preset.as_str() {
        "discord" => {
            target_bytes = 9.0 * 1024.0 * 1024.0;
            s.audio_bitrate = "128k";
            s.preset = "veryfast";
        }
        "normal" => s.video_bitrate = Some(6_000_000),
        "smooth" => s.video_bitrate = Some(10_000_000),
        "hq" => {
            s.video_bitrate = Some(18_000_000);
            s.audio_bitrate = "320k";
        }
        _ => {}
    }

    if let Some(crf) = p.crf {
        if p.preset != "discord" && target_bytes <= 0.0 {
            s.crf = Some(crf);
            s.video_bitrate = None;
            return s;
        }
    }

    if target_bytes > 0.0 {
        let overhead = 0.95;
        let audio_bits: f64 = if s.audio_bitrate == "128k" { 128_000.0 } else { 192_000.0 };
        let target_bits = target_bytes * 8.0 * overhead;
        let v = ((target_bits / total.max(0.1)) - audio_bits).max(100_000.0);
        s.video_bitrate = Some(v as u64);
    }
    s
}

/// Per-clip ffmpeg input: (input index, input seek offset).
/// Each media clip gets its own `-ss`-seeked input so ffmpeg never decodes
/// from the start of the file to reach a trim point — this is what makes
/// exports start instantly instead of hanging on "starting...".
pub type ClipInputs = Vec<Option<(usize, f64)>>;

pub fn plan_inputs(p: &ExportPayload) -> ClipInputs {
    let mut out = Vec::with_capacity(p.clips.len());
    let mut next = 1; // input 0 is the silent audio base
    for c in &p.clips {
        if c.kind == "video" || c.kind == "audio" {
            let seek = (c.in_point - 1.0).max(0.0);
            out.push(Some((next, seek)));
            next += 1;
        } else {
            out.push(None);
        }
    }
    out
}

/// Build the full filter graph.
fn build_filter_graph(
    p: &ExportPayload,
    clip_inputs: &ClipInputs,
    total: f64,
    build_dir: &std::path::Path,
) -> Result<String, String> {
    let (w, h, fps) = (p.width, p.height, p.fps);
    let mut g = String::new();

    // ---- video layers ----
    let mut video_clips: Vec<(usize, &ExportClip)> = p
        .clips
        .iter()
        .enumerate()
        .filter(|(_, c)| c.kind == "video")
        .collect();
    video_clips.sort_by(|(_, a), (_, b)| {
        a.layer
            .cmp(&b.layer)
            .then(a.start_time.partial_cmp(&b.start_time).unwrap_or(std::cmp::Ordering::Equal))
    });

    let mut layers: Vec<(i64, Vec<(usize, &ExportClip)>)> = Vec::new();
    for (ci, c) in video_clips {
        match layers.last_mut() {
            Some((l, v)) if *l == c.layer => v.push((ci, c)),
            _ => layers.push((c.layer, vec![(ci, c)])),
        }
    }

    let mut seg_n = 0usize;
    let mut layer_labels: Vec<String> = Vec::new();

    for (li, (_, clips)) in layers.iter().enumerate() {
        let mut cursor = 0.0f64;
        let mut segments: Vec<String> = Vec::new();

        for (ci, c) in clips {
            let start = c.start_time.max(cursor);
            let gap = start - cursor;
            if gap > 0.01 {
                let label = format!("vg{seg_n}");
                seg_n += 1;
                writeln!(
                    g,
                    "color=c=black@0.0:s={w}x{h}:r={fps}:d={},format=yuva420p,setsar=1[{label}];",
                    f(gap)
                )
                .unwrap();
                segments.push(label);
            }

            let (idx, seek) = clip_inputs[*ci].ok_or("video clip without input")?;
            let local_in = c.in_point - seek; // input is pre-seeked with -ss
            let crop = match &c.crop {
                Some(r) if r.w < 0.999 || r.h < 0.999 => format!(
                    "crop=w=iw*{:.4}:h=ih*{:.4}:x=iw*{:.4}:y=ih*{:.4},",
                    r.w.clamp(0.01, 1.0),
                    r.h.clamp(0.01, 1.0),
                    r.x.clamp(0.0, 1.0),
                    r.y.clamp(0.0, 1.0)
                ),
                _ => String::new(),
            };
            let mut chain = format!(
                "[{idx}:v]trim=start={}:end={},setpts=PTS-STARTPTS,fps={fps},{crop}\
scale={w}:{h}:force_original_aspect_ratio=decrease,\
pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black@0.0,setsar=1,format=yuva420p",
                f(local_in),
                f(local_in + c.duration)
            );
            if c.opacity < 0.999 {
                write!(chain, ",colorchannelmixer=aa={:.4}", c.opacity.clamp(0.0, 1.0)).unwrap();
            }
            if c.fade_in > 0.001 {
                write!(chain, ",fade=t=in:st=0:d={}:alpha=1", f(c.fade_in)).unwrap();
            }
            if c.fade_out > 0.001 {
                write!(
                    chain,
                    ",fade=t=out:st={}:d={}:alpha=1",
                    f(c.duration - c.fade_out),
                    f(c.fade_out)
                )
                .unwrap();
            }
            let label = format!("vc{seg_n}");
            seg_n += 1;
            writeln!(g, "{chain}[{label}];").unwrap();
            segments.push(label);
            cursor = start + c.duration;
        }

        let tail = total - cursor;
        if tail > 0.01 {
            let label = format!("vg{seg_n}");
            seg_n += 1;
            writeln!(
                g,
                "color=c=black@0.0:s={w}x{h}:r={fps}:d={},format=yuva420p,setsar=1[{label}];",
                f(tail)
            )
            .unwrap();
            segments.push(label);
        }

        let layer_label = format!("vlayer{li}");
        if segments.len() == 1 {
            writeln!(g, "[{}]null[{layer_label}];", segments[0]).unwrap();
        } else {
            let ins: String = segments.iter().map(|s| format!("[{s}]")).collect();
            writeln!(g, "{ins}concat=n={}:v=1:a=0[{layer_label}];", segments.len()).unwrap();
        }
        layer_labels.push(layer_label);
    }

    // base + overlay compositing
    writeln!(
        g,
        "color=c=black:s={w}x{h}:r={fps}:d={},format=yuv420p,setsar=1[vbase];",
        f(total)
    )
    .unwrap();
    let mut prev = "vbase".to_string();
    for (i, l) in layer_labels.iter().enumerate() {
        let out = format!("vov{i}");
        writeln!(g, "[{prev}][{l}]overlay=0:0:eof_action=pass[{out}];").unwrap();
        prev = out;
    }

    // ---- text overlays ----
    let mut text_clips: Vec<&ExportClip> = p
        .clips
        .iter()
        .filter(|c| c.kind == "text" && c.text.is_some())
        .collect();
    text_clips.sort_by(|a, b| {
        a.layer
            .cmp(&b.layer)
            .then(a.start_time.partial_cmp(&b.start_time).unwrap_or(std::cmp::Ordering::Equal))
    });

    let fonts = fonts_dir();
    for (i, c) in text_clips.iter().enumerate() {
        let t = c.text.as_ref().unwrap();
        let font_path = format!("{fonts}/{}", font_file(&t.font, t.bold));
        let size_px = (t.size * h as f64).round().max(4.0);
        let border_px = (t.outline_width * h as f64).round().max(0.0);
        let cx = (t.x.clamp(0.0, 1.0) * w as f64).round();
        let cy = t.y.clamp(0.0, 1.0) * h as f64;

        // fade in/out via time-based alpha expression (shared by all lines)
        let mut alpha = String::new();
        if c.fade_in > 0.001 || c.fade_out > 0.001 {
            let st = c.start_time;
            let en = c.start_time + c.duration;
            let mut expr = String::from("1");
            if c.fade_out > 0.001 {
                expr = format!(
                    "if(gt(t,{}),({}-t)/{},{})",
                    f(en - c.fade_out),
                    f(en),
                    f(c.fade_out),
                    expr
                );
            }
            if c.fade_in > 0.001 {
                expr = format!(
                    "if(lt(t,{}),(t-{})/{},{})",
                    f(st + c.fade_in),
                    f(st),
                    f(c.fade_in),
                    expr
                );
            }
            alpha = format!(":alpha='clip({expr},0,1)'");
        }

        // drawtext left-aligns lines inside a multi-line block, but the
        // preview centers each line — so emit one drawtext per line, each
        // centered horizontally, laid out like the canvas (line height 1.2em)
        let lines: Vec<&str> = t.content.split('\n').collect();
        let line_h = size_px * 1.2;
        let block_h = line_h * lines.len() as f64;

        for (li, line) in lines.iter().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let text_file = build_dir.join(format!("text_{i}_{li}.txt"));
            std::fs::write(&text_file, line.as_bytes())
                .map_err(|e| format!("failed to write text file: {e}"))?;

            let line_cy = (cy - block_h / 2.0 + line_h * (li as f64 + 0.5)).round();
            let out = format!("vtx{i}_{li}");
            let mut dt = format!(
                "[{prev}]drawtext=textfile={}:fontfile={}:fontsize={}:fontcolor={}:\
x={cx}-text_w/2:y={line_cy}-text_h/2",
                q(&format!("text_{i}_{li}.txt")),
                q(&font_path),
                size_px,
                color_hex(&t.color, "ffffff"),
            );
            if border_px >= 1.0 {
                write!(
                    dt,
                    ":borderw={}:bordercolor={}",
                    border_px,
                    color_hex(&t.outline_color, "000000")
                )
                .unwrap();
            }
            dt.push_str(&alpha);
            write!(
                dt,
                ":enable='between(t,{},{})'",
                f(c.start_time),
                f(c.start_time + c.duration)
            )
            .unwrap();
            writeln!(g, "{dt}[{out}];").unwrap();
            prev = out;
        }
    }

    writeln!(g, "[{prev}]format=yuv420p[vout];").unwrap();

    // ---- audio ----
    let mut audio_labels: Vec<String> = Vec::new();
    let mut an = 0usize;
    for (ci, c) in p
        .clips
        .iter()
        .enumerate()
        .filter(|(_, c)| c.kind == "video" || c.kind == "audio")
    {
        let Some((idx, seek)) = clip_inputs[ci] else { continue };
        let local_in = c.in_point - seek;
        for tr in c.audio_tracks.iter().filter(|t| t.enabled) {
            let delay_ms = (c.start_time * 1000.0).round().max(0.0) as u64;
            let label = format!("au{an}");
            an += 1;
            let mut chain = format!(
                "[{idx}:a:{}]atrim=start={}:end={},asetpts=PTS-STARTPTS,volume={:.4},aresample=48000:async=1",
                tr.audio_order,
                f(local_in),
                f(local_in + c.duration),
                tr.volume.clamp(0.0, 4.0)
            );
            if c.fade_in > 0.001 {
                write!(chain, ",afade=t=in:st=0:d={}", f(c.fade_in)).unwrap();
            }
            if c.fade_out > 0.001 {
                write!(
                    chain,
                    ",afade=t=out:st={}:d={}",
                    f(c.duration - c.fade_out),
                    f(c.fade_out)
                )
                .unwrap();
            }
            write!(chain, ",adelay={delay_ms}|{delay_ms}").unwrap();
            writeln!(g, "{chain}[{label}];").unwrap();
            audio_labels.push(label);
        }
    }

    if audio_labels.is_empty() {
        writeln!(g, "[0:a]aformat=channel_layouts=stereo:sample_rates=48000[aout]").unwrap();
    } else {
        let ins: String = audio_labels.iter().map(|s| format!("[{s}]")).collect();
        writeln!(
            g,
            "[0:a]{ins}amix=inputs={}:duration=first:dropout_transition=0:normalize=0[amixed];",
            audio_labels.len() + 1
        )
        .unwrap();
        writeln!(g, "[amixed]aformat=channel_layouts=stereo:sample_rates=48000[aout]").unwrap();
    }

    Ok(g)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dump_sample_graph() {
        let clip = |start: f64, inp: f64, dur: f64, fi: f64, fo: f64| ExportClip {
            kind: "video".into(),
            file_path: "test1.mp4".into(),
            start_time: start,
            in_point: inp,
            duration: dur,
            fade_in: fi,
            fade_out: fo,
            layer: 0,
            opacity: 1.0,
            crop: None,
            audio_tracks: vec![ExportAudioTrack { enabled: true, audio_order: 0, volume: 1.0 }],
            text: None,
        };
        let mut text = clip(0.5, 0.0, 3.0, 0.5, 0.5);
        text.kind = "text".into();
        text.file_path = String::new();
        text.audio_tracks.clear();
        text.text = Some(TextStyle {
            content: "a long centered first line\noh my god\noh my god".into(),
            font: "consolas".into(),
            bold: false,
            size: 0.08,
            color: "#ffffff".into(),
            outline_color: "#000000".into(),
            outline_width: 0.004,
            x: 0.5,
            y: 0.3,
        });
        let p = ExportPayload {
            clips: vec![clip(0.0, 0.0, 2.0, 0.7, 0.0), clip(2.0, 1.0, 2.0, 0.0, 0.7), text],
            out_path: "out.mp4".into(),
            width: 640,
            height: 360,
            fps: 30.0,
            preset: "custom".into(),
            target_size_bytes: 0.0,
            crf: Some(23.0),
        };
        let inputs = plan_inputs(&p);
        let dir = std::env::temp_dir().join("bloom-graph-test");
        std::fs::create_dir_all(&dir).unwrap();
        let g = build_filter_graph(&p, &inputs, 4.0, &dir).unwrap();
        std::fs::write(dir.join("filter.txt"), &g).unwrap();
        let mut args = String::new();
        for (c, input) in p.clips.iter().zip(&inputs) {
            if let Some((_, seek)) = input {
                let read_len = (c.in_point - seek) + c.duration + 2.0;
                args.push_str(&format!("-ss {} -t {} -i {}\n", f(*seek), f(read_len), c.file_path));
            }
        }
        std::fs::write(dir.join("inputs.txt"), &args).unwrap();
        println!("{g}");
    }
}

pub fn run_export(app: &AppHandle, state: &ExportState, p: ExportPayload) -> Result<(), String> {
    let _guard = state
        .running
        .try_lock()
        .map_err(|_| "an export is already running".to_string())?;
    state.cancelled.store(false, Ordering::SeqCst);

    if p.clips.is_empty() {
        return Err("no clips to export".into());
    }
    let total = p
        .clips
        .iter()
        .map(|c| c.start_time + c.duration)
        .fold(0.0f64, f64::max);
    if total <= 0.0 {
        return Err("timeline is empty".into());
    }

    let build_dir = std::env::temp_dir().join(format!(
        "bloom-export-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&build_dir).map_err(|e| format!("temp dir: {e}"))?;

    let result = run_export_inner(app, state, &p, total, &build_dir);
    let _ = std::fs::remove_dir_all(&build_dir);
    state.child_pid.store(0, Ordering::SeqCst);
    result
}

fn run_export_inner(
    app: &AppHandle,
    state: &ExportState,
    p: &ExportPayload,
    total: f64,
    build_dir: &std::path::Path,
) -> Result<(), String> {
    // one pre-seeked input per media clip; input 0 is the silent audio base
    let clip_inputs = plan_inputs(p);
    let graph = build_filter_graph(p, &clip_inputs, total, build_dir)?;
    let filter_path = build_dir.join("filter.txt");
    std::fs::write(&filter_path, &graph).map_err(|e| format!("filter file: {e}"))?;

    let enc = encode_settings(p, total);
    let total_frames = (total * p.fps).ceil() as u64;

    let mut cmd = ffmpeg::command("ffmpeg")?;
    cmd.current_dir(build_dir);
    cmd.args(["-y", "-hide_banner", "-nostats"]);
    cmd.args([
        "-f",
        "lavfi",
        "-t",
        &f(total),
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
    ]);
    for (c, input) in p.clips.iter().zip(&clip_inputs) {
        let Some((_, seek)) = input else { continue };
        // fast input seeking + bounded read: never decode more of the source
        // than the clip actually uses
        let read_len = (c.in_point - seek) + c.duration + 2.0;
        cmd.args(["-ss", &f(*seek), "-t", &f(read_len), "-i", &c.file_path]);
    }
    cmd.args(["-filter_complex_script", "filter.txt"]);
    cmd.args(["-map", "[vout]", "-map", "[aout]"]);
    cmd.args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", enc.preset]);
    if let Some(crf) = enc.crf {
        cmd.args(["-crf", &format!("{crf}")]);
    } else if let Some(b) = enc.video_bitrate {
        cmd.args([
            "-b:v",
            &b.to_string(),
            "-maxrate",
            &b.to_string(),
            "-bufsize",
            &(b * 2).to_string(),
        ]);
    }
    cmd.args(["-c:a", "aac", "-b:a", enc.audio_bitrate]);
    cmd.args(["-movflags", "+faststart", "-t", &f(total)]);
    cmd.args(["-progress", "pipe:1"]);
    cmd.arg(&p.out_path);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("failed to start ffmpeg: {e}"))?;
    state.child_pid.store(child.id(), Ordering::SeqCst);

    // collect stderr on a thread for error reporting
    let stderr = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(err) = stderr {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                buf.push_str(&line);
                buf.push('\n');
                if buf.len() > 16_000 {
                    buf.drain(..8_000);
                }
            }
        }
        buf
    });

    // parse -progress key=value stream
    let started = std::time::Instant::now();
    if let Some(out) = child.stdout.take() {
        let mut current_frame: u64 = 0;
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if state.cancelled.load(Ordering::SeqCst) {
                break;
            }
            if let Some(v) = line.strip_prefix("frame=") {
                current_frame = v.trim().parse().unwrap_or(current_frame);
            } else if let Some(v) = line.strip_prefix("out_time_us=") {
                let secs = v.trim().parse::<f64>().unwrap_or(0.0) / 1_000_000.0;
                let pct = (secs / total).clamp(0.0, 1.0);
                let elapsed = started.elapsed().as_secs_f64();
                let eta = if pct > 0.02 { elapsed / pct - elapsed } else { 0.0 };
                let _ = app.emit(
                    "export-progress",
                    ProgressEvent {
                        percent: pct,
                        current_seconds: secs,
                        total_seconds: total,
                        current_frame,
                        total_frames,
                        eta_seconds: eta.max(0.0),
                    },
                );
            }
        }
    }

    if state.cancelled.load(Ordering::SeqCst) {
        let _ = child.kill();
        let _ = child.wait();
        let _ = stderr_thread.join();
        let _ = std::fs::remove_file(&p.out_path);
        return Err("cancelled".into());
    }

    let status = child.wait().map_err(|e| format!("ffmpeg wait failed: {e}"))?;
    let stderr_text = stderr_thread.join().unwrap_or_default();

    if !status.success() {
        let tail: String = stderr_text
            .lines()
            .rev()
            .take(10)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("export failed:\n{tail}"));
    }

    let _ = app.emit(
        "export-progress",
        ProgressEvent {
            percent: 1.0,
            current_seconds: total,
            total_seconds: total,
            current_frame: total_frames,
            total_frames,
            eta_seconds: 0.0,
        },
    );
    Ok(())
}
