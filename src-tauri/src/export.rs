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
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use crate::ffmpeg;

#[derive(Default)]
pub struct ExportState {
    pub cancelled: AtomicBool,
    pub finish_requested: AtomicBool,
    pub child_pid: AtomicU32,
    pub worker_pid: AtomicU32,
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
pub struct CharPos {
    /// the glyph
    pub c: String,
    /// normalized center x of the glyph 0..1
    pub x: f64,
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
    #[serde(default)]
    pub shadow_color: String,
    /// shadow offset as a fraction of output height
    #[serde(default)]
    pub shadow_x: f64,
    #[serde(default)]
    pub shadow_y: f64,
    /// shadow opacity 0..1
    #[serde(default = "default_one")]
    pub shadow_opacity: f64,
    /// shadow blur radius as a fraction of output height
    #[serde(default)]
    pub shadow_blur: f64,
    /// per-line per-glyph placement, present when a letter gap is set
    /// (the gap itself is applied by the frontend when computing these)
    #[serde(default)]
    pub chars: Option<Vec<Vec<CharPos>>>,
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
    /// playback rate: 1 = normal, 0.25 = 4x slower
    #[serde(default = "default_one")]
    pub speed: f64,
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

fn default_interp_fps() -> f64 {
    300.0
}

/// Motion blur inspired by f0e/blur: interpolate to a high framerate, blend a
/// window of interpolated frames per output frame, then sample down to the
/// export fps chosen in the render settings.
fn default_method() -> String {
    "rife".into()
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MotionBlur {
    #[serde(default)]
    pub enabled: bool,
    /// "fast": run the whole graph at interp_fps and blend (no motion
    /// estimation); "interpolate": minterpolate to interp_fps (slow)
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default = "default_interp_fps")]
    pub interp_fps: f64,
    /// blend window as a fraction of an output frame interval (1 = full frame)
    #[serde(default = "default_one")]
    pub amount: f64,
    /// equal | gaussian | pyramid | vegas
    #[serde(default)]
    pub weighting: String,
    /// filters use blur-style multipliers where 1 = neutral
    #[serde(default = "default_one")]
    pub brightness: f64,
    #[serde(default = "default_one")]
    pub saturation: f64,
    #[serde(default = "default_one")]
    pub contrast: f64,
    #[serde(default = "default_one")]
    pub gamma: f64,
    /// RIFE gpu_thread override; 0 = auto-detect from VRAM
    #[serde(default)]
    pub gpu_threads: u32,
    /// grayscale mask PNG (base64, no data: prefix); white = keep sharp
    #[serde(default)]
    pub mask_png: Option<String>,
}

#[derive(Deserialize, Clone)]
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
    /// stretch sources to fill the output frame instead of letterboxing
    #[serde(default)]
    pub stretch: bool,
    #[serde(default)]
    pub motion_blur: Option<MotionBlur>,
}

fn blend_weights(mode: &str, n: usize) -> String {
    let weights: Vec<f64> = match mode {
        "gaussian" => {
            let sigma = (n as f64 / 6.0).max(0.5);
            (0..n)
                .map(|i| {
                    let x = i as f64 - (n as f64 - 1.0) / 2.0;
                    (-(x * x) / (2.0 * sigma * sigma)).exp()
                })
                .collect()
        }
        "pyramid" => {
            let half = (n as f64 - 1.0) / 2.0;
            (0..n).map(|i| half - (i as f64 - half).abs() + 1.0).collect()
        }
        "vegas" => (0..n)
            .map(|i| if i == 0 || i == n - 1 { 1.0 } else { 2.0 })
            .collect(),
        _ => vec![1.0; n],
    };
    weights
        .iter()
        .map(|v| format!("{v:.4}"))
        .collect::<Vec<_>>()
        .join(" ")
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
    /// ffmpeg's encoding speed string, e.g. "0.85x"
    speed: String,
    /// what the exporter is currently doing, shown under the frame counter
    stage: String,
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
        "rife-intermediate" => s.preset = "ultrafast",
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

/// blur-style color multipliers (1 = neutral) -> an ffmpeg eq filter, or None
/// when every control sits at neutral.
fn eq_filter(mb: &MotionBlur) -> Option<String> {
    let brightness = (mb.brightness - 1.0).clamp(-1.0, 1.0);
    let saturation = mb.saturation.clamp(0.0, 3.0);
    let contrast = mb.contrast.clamp(-2.0, 2.0);
    let gamma = mb.gamma.clamp(0.1, 10.0);
    if brightness.abs() > 1e-3
        || (saturation - 1.0).abs() > 1e-3
        || (contrast - 1.0).abs() > 1e-3
        || (gamma - 1.0).abs() > 1e-3
    {
        Some(format!(
            "eq=brightness={brightness:.4}:saturation={saturation:.4}:contrast={contrast:.4}:gamma={gamma:.4}"
        ))
    } else {
        None
    }
}

/// Decode the user's painted blur mask (white = protected from blur) into a
/// PNG file inside the build dir. Returns None when no mask is set.
fn write_mask_png(
    mb: &MotionBlur,
    build_dir: &std::path::Path,
) -> Result<Option<std::path::PathBuf>, String> {
    let Some(data) = mb.mask_png.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("blur mask decode: {e}"))?;
    let path = build_dir.join("blur-mask.png");
    std::fs::write(&path, bytes).map_err(|e| format!("blur mask: {e}"))?;
    Ok(Some(path))
}

/// Name and dedicated VRAM of the strongest (non-software) display adapter.
#[cfg(windows)]
pub fn gpu_adapter_info() -> Option<(String, u64)> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    unsafe {
        let factory = CreateDXGIFactory1::<IDXGIFactory1>().ok()?;
        let mut best: Option<(String, u64)> = None;
        let mut i = 0;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            if let Ok(desc) = adapter.GetDesc1() {
                let vram = desc.DedicatedVideoMemory as u64;
                let software = desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0;
                if !software && best.as_ref().is_none_or(|(_, b)| vram > *b) {
                    let name = String::from_utf16_lossy(&desc.Description);
                    best = Some((name.trim_end_matches('\0').trim().to_string(), vram));
                }
            }
            i += 1;
        }
        best
    }
}

#[cfg(not(windows))]
pub fn gpu_adapter_info() -> Option<(String, u64)> {
    None
}

/// RIFE gpu_thread choice. A second in-flight inference only helps when the
/// GPU has dedicated VRAM to spare — on iGPUs it overcommits video memory and
/// throughput collapses by orders of magnitude. Auto picks 2 when the
/// strongest adapter has >= 6 GiB of dedicated VRAM, otherwise 1.
pub fn detect_gpu_threads() -> u32 {
    match gpu_adapter_info() {
        Some((_, vram)) if vram >= 6 * 1024 * 1024 * 1024 => 2,
        _ => 1,
    }
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

/// Build the full filter graph. `mask_input` is the ffmpeg input index of the
/// looped blur-mask PNG, when one is set.
fn build_filter_graph(
    p: &ExportPayload,
    clip_inputs: &ClipInputs,
    total: f64,
    build_dir: &std::path::Path,
    mask_input: Option<usize>,
) -> Result<String, String> {
    let (w, h, fps) = (p.width, p.height, p.fps);
    let mb_active = p.motion_blur.as_ref().filter(|m| m.enabled);
    // "fast" motion blur runs the whole graph at the interpolated rate and
    // blends real frames — no motion estimation, so it renders far quicker
    let gfps = match mb_active {
        Some(m) if m.method == "fast" => m.interp_fps.clamp(fps, 960.0),
        _ => fps,
    };
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
                    "color=c=black@0.0:s={w}x{h}:r={gfps}:d={},format=yuva420p,setsar=1[{label}];",
                    f(gap)
                )
                .unwrap();
                segments.push(label);
            }

            let (idx, seek) = clip_inputs[*ci].ok_or("video clip without input")?;
            let local_in = c.in_point - seek; // input is pre-seeked with -ss
            let speed = c.speed.clamp(0.05, 4.0);
            // a slowed clip consumes duration*speed seconds of source and
            // stretches them over `duration` seconds of timeline
            let setpts = if (speed - 1.0).abs() > 1e-3 {
                format!("setpts=(PTS-STARTPTS)/{}", f(speed))
            } else {
                "setpts=PTS-STARTPTS".to_string()
            };
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
            let fit = if p.stretch {
                format!("scale={w}:{h}")
            } else {
                format!(
                    "scale={w}:{h}:force_original_aspect_ratio=decrease,\
pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black@0.0"
                )
            };
            let mut chain = format!(
                "[{idx}:v]trim=start={}:end={},{setpts},fps={gfps},{crop}\
{fit},setsar=1,format=yuva420p",
                f(local_in),
                f(local_in + c.duration * speed)
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
                "color=c=black@0.0:s={w}x{h}:r={gfps}:d={},format=yuva420p,setsar=1[{label}];",
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
        "color=c=black:s={w}x{h}:r={gfps}:d={},format=yuv420p,setsar=1[vbase];",
        f(total)
    )
    .unwrap();
    let mut prev = "vbase".to_string();
    for (i, l) in layer_labels.iter().enumerate() {
        let out = format!("vov{i}");
        writeln!(g, "[{prev}][{l}]overlay=0:0:eof_action=pass[{out}];").unwrap();
        prev = out;
    }

    // ---- motion blur (high-rate frame blend -> output fps) ----
    // Text is burned in *after* this stage: minterpolate (and RIFE) warp the
    // edges of static overlays with motion from the scene behind them, which
    // made exported text look fatter/ghosted compared with the preview.
    if let Some(mb) = mb_active.filter(|m| matches!(m.method.as_str(), "fast" | "interpolate")) {
        let amount = mb.amount.clamp(0.0, 4.0);
        let mut blur = String::new();
        if mb.method == "interpolate" {
            // f0e/blur follows this same shape: create a modest high-FPS
            // stream, blend a short weighted window, then sample to output
            // FPS. The simpler OBMC settings avoid the extremely expensive
            // variable-size adaptive blocks while retaining bidirectional
            // motion-compensated interpolation.
            let interp = mb.interp_fps.clamp(fps, 1920.0);
            let mut frames = ((((interp / fps) * amount).round() as i64).clamp(2, 127)) as usize;
            if frames % 2 == 0 {
                frames += 1;
            }
            write!(
                blur,
                "minterpolate=fps={}:mi_mode=mci:mc_mode=obmc:me_mode=bidir:vsbmc=0:mb_size=16:search_param=12,\
tmix=frames={frames}:weights='{}',fps={fps},",
                f(interp),
                blend_weights(&mb.weighting, frames)
            )
            .unwrap();
        } else {
            // fast: the graph already runs at gfps — just blend and sample down
            let mut frames = ((((gfps / fps) * amount).round() as i64).clamp(2, 127)) as usize;
            if frames % 2 == 0 {
                frames += 1;
            }
            write!(
                blur,
                "tmix=frames={frames}:weights='{}',fps={fps},",
                blend_weights(&mb.weighting, frames)
            )
            .unwrap();
        }
        if let Some(mi) = mask_input {
            // painted mask areas keep the sharp (pre-blur) pixels; the mask
            // PNG comes pre-feathered from the editor so the seam is soft
            writeln!(g, "[{prev}]split=2[mbsrc][mbsharp];").unwrap();
            writeln!(g, "[mbsrc]{blur}null[mbout];").unwrap();
            writeln!(g, "[mbsharp]fps={fps},format=yuva420p[mbsharpf];").unwrap();
            writeln!(g, "[{mi}:v]fps={fps},scale={w}:{h},format=gray[mbmask];").unwrap();
            writeln!(g, "[mbsharpf][mbmask]alphamerge[mbsharpa];").unwrap();
            writeln!(g, "[mbout][mbsharpa]overlay=0:0:eof_action=pass[mbmerged];").unwrap();
            prev = "mbmerged".to_string();
        } else {
            writeln!(g, "[{prev}]{blur}null[mbout];").unwrap();
            prev = "mbout".to_string();
        }
        // color controls apply to the merged result, like the preview shows
        if let Some(eq) = eq_filter(mb) {
            writeln!(g, "[{prev}]{eq}[mbeq];").unwrap();
            prev = "mbeq".to_string();
        }
    }

    // ---- text overlays (after blur so static text stays crisp) ----
    append_text_overlays(&mut g, &mut prev, p, total, fps, build_dir)?;

    writeln!(g, "[{prev}]format=yuv420p[vout];").unwrap();

    // ---- audio ----
    build_audio_graph(&mut g, p, clip_inputs);

    Ok(g)
}

/// Burn text clips into `prev` with drawtext (one per line / glyph), matching
/// the canvas preview's layout. Runs at the output fps, after any motion blur.
fn append_text_overlays(
    g: &mut String,
    prev: &mut String,
    p: &ExportPayload,
    total: f64,
    fps: f64,
    build_dir: &std::path::Path,
) -> Result<(), String> {
    let (w, h) = (p.width, p.height);
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

        // shadow: hard offsets map to drawtext's shadow; a blur radius routes
        // the shadow through its own transparent layer + gblur + overlay
        let shadow_x_px = (t.shadow_x * h as f64).round() as i64;
        let shadow_y_px = (t.shadow_y * h as f64).round() as i64;
        let shadow_op = t.shadow_opacity.clamp(0.0, 1.0);
        let shadow_blur_px = (t.shadow_blur * h as f64).max(0.0);
        let has_shadow =
            (shadow_x_px != 0 || shadow_y_px != 0 || shadow_blur_px >= 0.5) && shadow_op > 0.001;
        let shadow_color = format!("{}@{:.3}", color_hex(&t.shadow_color, "000000"), shadow_op);

        // drawtext left-aligns lines inside a multi-line block, but the
        // preview centers each line — so emit one drawtext per line, each
        // centered horizontally, laid out like the canvas (line height 1.2em)
        let lines: Vec<&str> = t.content.split('\n').collect();
        let line_h = size_px * 1.2;
        let block_h = line_h * lines.len() as f64;

        // one drawtext for (name, text, center, colors)
        let emit_text = |g: &mut String,
                         prev: &mut String,
                         name: String,
                         text: &str,
                         center_x: f64,
                         center_y: f64,
                         font_color: &str,
                         border_color: &str,
                         inline_shadow: bool|
         -> Result<(), String> {
            let file_name = format!("{name}.txt");
            std::fs::write(build_dir.join(&file_name), text.as_bytes())
                .map_err(|e| format!("failed to write text file: {e}"))?;
            // no_hinting: browsers render large text unhinted; freetype's
            // default hinting snaps stems to the pixel grid, which fattens
            // and reshapes glyphs compared with the editor preview.
            // Align against the font's line metrics, not the current text's
            // glyph bounds. Letter-spaced text is emitted one glyph at a time;
            // text_h/ascent/descent therefore vary for "t", "e", etc. and
            // would give each character a different baseline. `y_align=font`
            // makes y the top of one shared, font-defined line box. A canvas
            // `middle` baseline likewise centers the font's em box at line_cy.
            let mut dt = format!(
                "[{prev}]drawtext=textfile={}:fontfile={}:fontsize={}:fontcolor={font_color}:\
ft_load_flags=no_hinting:y_align=font:x={center_x}-text_w/2:y={center_y}-{}/2",
                q(&file_name),
                q(&font_path),
                size_px,
                size_px,
            );
            if border_px >= 1.0 {
                write!(dt, ":borderw={border_px}:bordercolor={border_color}").unwrap();
            }
            if inline_shadow {
                write!(
                    dt,
                    ":shadowcolor={shadow_color}:shadowx={shadow_x_px}:shadowy={shadow_y_px}"
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
            writeln!(g, "{dt}[{name}];").unwrap();
            *prev = name;
            Ok(())
        };

        // the whole block (all lines / glyphs) in one color at an offset
        let emit_block = |g: &mut String,
                          prev: &mut String,
                          tag: &str,
                          x_off: f64,
                          y_off: f64,
                          font_color: &str,
                          border_color: &str,
                          inline_shadow: bool|
         -> Result<(), String> {
            for (li, line) in lines.iter().enumerate() {
                let line_cy = (cy - block_h / 2.0 + line_h * (li as f64 + 0.5) + y_off).round();
                if let Some(char_lines) = &t.chars {
                    // letter gap: per-glyph placement precomputed by the frontend
                    let empty = Vec::new();
                    let chars = char_lines.get(li).unwrap_or(&empty);
                    for (ci, cp) in chars.iter().enumerate() {
                        if cp.c.trim().is_empty() {
                            continue;
                        }
                        let ccx = (cp.x.clamp(0.0, 1.0) * w as f64 + x_off).round();
                        emit_text(
                            g,
                            prev,
                            format!("{tag}_{li}_{ci}"),
                            &cp.c,
                            ccx,
                            line_cy,
                            font_color,
                            border_color,
                            inline_shadow,
                        )?;
                    }
                } else {
                    if line.trim().is_empty() {
                        continue;
                    }
                    emit_text(
                        g,
                        prev,
                        format!("{tag}_{li}"),
                        line,
                        (cx + x_off).round(),
                        line_cy,
                        font_color,
                        border_color,
                        inline_shadow,
                    )?;
                }
            }
            Ok(())
        };

        if has_shadow && shadow_blur_px >= 0.5 {
            // blurred shadow: draw the block in shadow color on its own
            // transparent full-length layer, blur it, overlay under the text
            writeln!(
                g,
                "color=c=black@0.0:s={w}x{h}:r={fps}:d={},format=yuva420p[tsb{i}];",
                f(total)
            )
            .unwrap();
            let mut sh_prev = format!("tsb{i}");
            emit_block(
                g,
                &mut sh_prev,
                &format!("tsd{i}"),
                shadow_x_px as f64,
                shadow_y_px as f64,
                &shadow_color,
                &shadow_color,
                false,
            )?;
            writeln!(
                g,
                "[{sh_prev}]gblur=sigma={:.2}[tsg{i}];",
                (shadow_blur_px / 2.0).max(0.5)
            )
            .unwrap();
            writeln!(g, "[{prev}][tsg{i}]overlay=0:0:eof_action=pass[tso{i}];").unwrap();
            *prev = format!("tso{i}");
        }

        let font_color = color_hex(&t.color, "ffffff");
        let border_color = color_hex(&t.outline_color, "000000");
        let inline_shadow = has_shadow && shadow_blur_px < 0.5;
        emit_block(
            g,
            prev,
            &format!("vtx{i}"),
            0.0,
            0.0,
            &font_color,
            &border_color,
            inline_shadow,
        )?;
    }
    Ok(())
}

/// Trim/fade/delay every enabled audio track and mix them into [aout].
fn build_audio_graph(g: &mut String, p: &ExportPayload, clip_inputs: &ClipInputs) {
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
        let speed = c.speed.clamp(0.05, 4.0);
        // speed changes pitch like the editor does (tape-style): normalize to
        // 48k, relabel the sample rate by the speed factor, resample back
        let mut rate_fx = String::new();
        if (speed - 1.0).abs() > 1e-3 {
            let new_rate = (48000.0 * speed).round().max(1000.0) as i64;
            rate_fx = format!(",aresample=48000,asetrate={new_rate}");
        }
        for tr in c.audio_tracks.iter().filter(|t| t.enabled) {
            let delay_ms = (c.start_time * 1000.0).round().max(0.0) as u64;
            let label = format!("au{an}");
            an += 1;
            let mut chain = format!(
                "[{idx}:a:{}]atrim=start={}:end={},asetpts=PTS-STARTPTS{rate_fx},volume={:.4},aresample=48000:async=1",
                tr.audio_order,
                f(local_in),
                f(local_in + c.duration * speed),
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
            speed: 1.0,
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
            shadow_color: "#000000".into(),
            shadow_x: 0.005,
            shadow_y: 0.005,
            shadow_opacity: 0.8,
            shadow_blur: 0.0,
            chars: None,
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
            stretch: false,
            motion_blur: Some(MotionBlur {
                enabled: true,
                method: "fast".into(),
                interp_fps: 480.0,
                amount: 1.0,
                weighting: "gaussian".into(),
                brightness: 1.0,
                saturation: 1.1,
                contrast: 1.0,
                gamma: 1.0,
                gpu_threads: 0,
                mask_png: None,
            }),
        };
        let inputs = plan_inputs(&p);
        let dir = std::env::temp_dir().join("bloom-graph-test");
        std::fs::create_dir_all(&dir).unwrap();
        let g = build_filter_graph(&p, &inputs, 4.0, &dir, None).unwrap();
        assert!(g.contains("y_align=font"));
        assert!(!g.contains("(ascent+descent)"));
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
    state.finish_requested.store(false, Ordering::SeqCst);
    state.worker_pid.store(0, Ordering::SeqCst);

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

    let result = run_export_inner(app, state, &p, total, &build_dir, 0.0, 1.0, "encoding video");
    // best-effort: a stopped-early file otherwise ends with frozen video
    if result.is_ok() && state.finish_requested.load(Ordering::SeqCst) {
        let _ = trim_frozen_tail(&p.out_path);
    }
    let _ = std::fs::remove_dir_all(&build_dir);
    state.child_pid.store(0, Ordering::SeqCst);
    state.worker_pid.store(0, Ordering::SeqCst);
    result
}

fn run_export_inner(
    app: &AppHandle,
    state: &ExportState,
    p: &ExportPayload,
    total: f64,
    build_dir: &std::path::Path,
    progress_base: f64,
    progress_span: f64,
    stage: &str,
) -> Result<(), String> {
    if p
        .motion_blur
        .as_ref()
        .is_some_and(|m| m.enabled && matches!(m.method.as_str(), "rife" | "balanced"))
    {
        return run_rife_export(app, state, p, total, build_dir, progress_base, progress_span);
    }
    // one pre-seeked input per media clip; input 0 is the silent audio base
    let clip_inputs = plan_inputs(p);
    let mask_path = match p
        .motion_blur
        .as_ref()
        .filter(|m| m.enabled && matches!(m.method.as_str(), "fast" | "interpolate"))
    {
        Some(m) => write_mask_png(m, build_dir)?,
        None => None,
    };
    let mask_input = mask_path
        .as_ref()
        .map(|_| 1 + clip_inputs.iter().flatten().count());
    let graph = build_filter_graph(p, &clip_inputs, total, build_dir, mask_input)?;
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
        // than the clip actually uses (duration*speed source seconds)
        let read_len = (c.in_point - seek) + c.duration * c.speed.clamp(0.05, 4.0) + 2.0;
        cmd.args(["-ss", &f(*seek), "-t", &f(read_len), "-i", &c.file_path]);
    }
    if let Some(mask) = &mask_path {
        cmd.args(["-loop", "1", "-t", &f(total), "-i"]);
        cmd.arg(mask);
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
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("failed to start ffmpeg: {e}"))?;
    state.child_pid.store(child.id(), Ordering::SeqCst);
    let mut child_stdin = child.stdin.take();

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
        let mut speed = String::new();
        let mut finish_sent = false;
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if state.cancelled.load(Ordering::SeqCst) {
                break;
            }
            if state.finish_requested.load(Ordering::SeqCst) && !finish_sent {
                if let Some(stdin) = child_stdin.as_mut() {
                    let _ = stdin.write_all(b"q\n");
                    let _ = stdin.flush();
                }
                finish_sent = true;
            }
            if let Some(v) = line.strip_prefix("frame=") {
                current_frame = v.trim().parse().unwrap_or(current_frame);
            } else if let Some(v) = line.strip_prefix("speed=") {
                speed = v.trim().to_string();
            } else if let Some(v) = line.strip_prefix("out_time_us=") {
                let secs = v.trim().parse::<f64>().unwrap_or(0.0) / 1_000_000.0;
                let pct = (secs / total).clamp(0.0, 1.0);
                // With minterpolate, ffmpeg can keep reporting frame=0 while
                // it buffers the optical-flow window. out_time_us continues
                // to advance, so derive a monotonic output-frame estimate for
                // the UI until ffmpeg reports a concrete frame number.
                let time_frame = (secs * p.fps).floor().max(0.0) as u64;
                current_frame = current_frame.max(time_frame.min(total_frames));
                let elapsed = started.elapsed().as_secs_f64();
                let eta = if pct > 0.02 { elapsed / pct - elapsed } else { 0.0 };
                let _ = app.emit(
                    "export-progress",
                    ProgressEvent {
                        percent: progress_base + pct * progress_span,
                        current_seconds: secs,
                        total_seconds: total,
                        current_frame,
                        total_frames,
                        eta_seconds: eta.max(0.0),
                        speed: speed.clone(),
                        stage: stage.to_string(),
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
            percent: progress_base + progress_span,
            current_seconds: total,
            total_seconds: total,
            current_frame: total_frames,
            total_frames,
            eta_seconds: 0.0,
            speed: String::new(),
            stage: stage.to_string(),
        },
    );
    Ok(())
}

fn runtime_resource(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name);
    if dev_path.exists() {
        return Ok(dev_path);
    }
    app.path()
        .resource_dir()
        .map_err(|e| format!("motion blur runtime path: {e}"))
        .map(|dir| strip_verbatim(dir.join(name)))
}

/// Tauri's resource_dir returns a `\\?\` extended-length path in installed
/// builds. The RIFE plugin joins `model_path + "/flownet.param"`, and Win32
/// skips slash normalization on verbatim paths, so the model fails to load.
fn strip_verbatim(path: std::path::PathBuf) -> std::path::PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        std::path::PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        std::path::PathBuf::from(rest.to_string())
    } else {
        path
    }
}

fn probe_duration(path: &std::path::Path) -> Result<f64, String> {
    let mut cmd = ffmpeg::command("ffprobe")?;
    cmd.args(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"]);
    cmd.arg(path);
    let value = ffmpeg::run(&mut cmd)?;
    value.trim().parse::<f64>().map_err(|e| format!("partial export duration: {e}"))
}

fn probe_video_duration(path: &std::path::Path) -> Result<f64, String> {
    let mut cmd = ffmpeg::command("ffprobe")?;
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=duration",
        "-of",
        "default=nw=1:nk=1",
    ]);
    cmd.arg(path);
    let value = ffmpeg::run(&mut cmd)?;
    value.trim().parse::<f64>().map_err(|e| format!("video stream duration: {e}"))
}

/// After "stop & finish" the muxer has usually interleaved audio packets past
/// the last encoded video frame, so players hold the final frame for the
/// remaining audio (~half a second). Remux the file trimmed to the video
/// stream's duration so both streams end together.
fn trim_frozen_tail(out_path: &str) -> Result<(), String> {
    let path = std::path::Path::new(out_path);
    let vdur = probe_video_duration(path)?;
    if vdur <= 0.1 {
        return Ok(());
    }
    let tmp = path.with_extension("finish.mp4");
    let mut cmd = ffmpeg::command("ffmpeg")?;
    cmd.args(["-y", "-hide_banner", "-v", "error", "-i"]);
    cmd.arg(path);
    cmd.args(["-t", &f(vdur), "-c", "copy", "-movflags", "+faststart"]);
    cmd.arg(&tmp);
    ffmpeg::run(&mut cmd)?;
    std::fs::remove_file(path).map_err(|e| format!("replace stopped export: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace stopped export: {e}"))
}

/// The interpolated rate RIFE runs at: the user's "interpolated fps" snapped
/// to a whole multiple of the output fps (so each output frame blends the
/// same number of interpolated samples), at least 2x, capped at 1920.
fn rife_interp_fps(mb: &MotionBlur, fps: f64) -> f64 {
    let mult = (mb.interp_fps.clamp(fps * 2.0, 1920.0) / fps).round().max(2.0);
    (fps * mult).min(1920.0)
}

fn rife_weights(mb: &MotionBlur, fps: f64) -> String {
    let interp = rife_interp_fps(mb, fps);
    // AverageFrames needs an odd, centered window of at most 31 taps
    let mut frames = ((interp / fps * mb.amount.clamp(0.0, 4.0)).round() as usize).clamp(1, 31);
    if frames % 2 == 0 {
        frames = (frames + 1).min(31);
    }
    format!("[{}]", blend_weights(&mb.weighting, frames).replace(' ', ","))
}

/// Follow an ffmpeg `-progress pipe:1` stream, emitting UI progress events
/// mapped into [base, base+span]. `on_finish_request` runs on every progress
/// line while "stop & finish" is pending (e.g. to close the frame source).
/// One immediate event so the UI can announce a stage before its first
/// progress line arrives (e.g. while the RIFE runtime warms up).
fn emit_stage(app: &AppHandle, percent: f64, total: f64, total_frames: u64, stage: &str) {
    let _ = app.emit(
        "export-progress",
        ProgressEvent {
            percent,
            current_seconds: 0.0,
            total_seconds: total,
            current_frame: 0,
            total_frames,
            eta_seconds: 0.0,
            speed: String::new(),
            stage: stage.to_string(),
        },
    );
}

#[allow(clippy::too_many_arguments)]
fn pump_progress(
    app: &AppHandle,
    state: &ExportState,
    out: std::process::ChildStdout,
    fps: f64,
    total: f64,
    total_frames: u64,
    base: f64,
    span: f64,
    stage: &str,
    mut on_finish_request: impl FnMut(),
) {
    let started = std::time::Instant::now();
    let mut current_frame = 0u64;
    let mut speed = String::new();
    for line in BufReader::new(out).lines().map_while(Result::ok) {
        if state.cancelled.load(Ordering::SeqCst) {
            break;
        }
        if state.finish_requested.load(Ordering::SeqCst) {
            on_finish_request();
        }
        if let Some(v) = line.strip_prefix("frame=") {
            current_frame = v.trim().parse().unwrap_or(current_frame);
        } else if let Some(v) = line.strip_prefix("speed=") {
            speed = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("out_time_us=") {
            let secs = v.trim().parse::<f64>().unwrap_or(0.0) / 1_000_000.0;
            current_frame = current_frame.max((secs * fps).floor().max(0.0) as u64);
            let pct = (secs / total.max(0.05)).clamp(0.0, 1.0);
            let elapsed = started.elapsed().as_secs_f64();
            let eta = if pct > 0.02 { elapsed / pct - elapsed } else { 0.0 };
            let _ = app.emit(
                "export-progress",
                ProgressEvent {
                    percent: base + pct * span,
                    current_seconds: secs,
                    total_seconds: total,
                    current_frame: current_frame.min(total_frames),
                    total_frames,
                    eta_seconds: eta.max(0.0),
                    speed: speed.clone(),
                    stage: stage.to_string(),
                },
            );
        }
    }
}

fn collect_stderr(err: Option<std::process::ChildStderr>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(err) = err {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                text.push_str(&line);
                text.push('\n');
                if text.len() > 16_000 {
                    text.drain(..8_000);
                }
            }
        }
        text
    })
}

fn run_rife_export(
    app: &AppHandle,
    state: &ExportState,
    p: &ExportPayload,
    total: f64,
    build_dir: &std::path::Path,
    progress_base: f64,
    progress_span: f64,
) -> Result<(), String> {
    let mb = p.motion_blur.as_ref().ok_or("missing RIFE settings")?;
    if mb.amount <= 0.0 {
        let mut plain = p.clone();
        plain.motion_blur = None;
        return run_export_inner(
            app,
            state,
            &plain,
            total,
            build_dir,
            progress_base,
            progress_span,
            "encoding video",
        );
    }

    // Size-limited exports (discord preset / custom size cap) get a third
    // stage: the blurred stream lands in a near-lossless mezzanine first and
    // is then encoded with two-pass x264. Single-pass ABR straight off the
    // pipe routinely overshoots the target on short clips, which is what
    // pushed "9 MB" discord exports past the 10 MB upload limit.
    let size_targeted = p.preset == "discord" || p.target_size_bytes > 0.0;
    let (stage1_end, stage2_end) = if size_targeted { (0.20, 0.75) } else { (0.25, 1.0) };

    // Stage 1 composes the editor timeline into a high-quality temporary file.
    // Stage 2 sends that file through bundled VapourSynth RIFE on the GPU.
    // Text stays OUT of stage 1: RIFE warps the edges of static overlays with
    // scene motion, so text is burned in after the blur (stage 2), where it
    // stays crisp and matches the editor preview.
    let intermediate = build_dir.join("rife-timeline.mkv");
    let mut timeline = p.clone();
    timeline.clips.retain(|c| c.kind != "text");
    timeline.motion_blur = None;
    timeline.out_path = intermediate.to_string_lossy().into_owned();
    timeline.preset = "rife-intermediate".into();
    timeline.target_size_bytes = 0.0;
    timeline.crf = Some(12.0);
    if timeline.clips.is_empty() {
        return Err("nothing to export besides text; disable motion blur".into());
    }
    run_export_inner(
        app,
        state,
        &timeline,
        total,
        build_dir,
        progress_base,
        progress_span * stage1_end,
        "compositing timeline",
    )?;
    if state.cancelled.load(Ordering::SeqCst) {
        return Err("cancelled".into());
    }

    let stage1_stopped = state.finish_requested.swap(false, Ordering::SeqCst);
    let render_total = if stage1_stopped {
        probe_duration(&intermediate)?.clamp(0.05, total)
    } else {
        total
    };

    let vs_method = if mb.method == "balanced" { "mvtools" } else { "rife" };
    let vspipe = runtime_resource(app, "vapoursynth/VSPipe.exe")?;
    let script = runtime_resource(app, "rife_blur.vpy")?;
    let model = runtime_resource(app, "rife-models/rife-v4.26_ensembleFalse")?;
    let mut required = vec![&vspipe, &script];
    if vs_method == "rife" {
        required.push(&model);
    }
    for path in required {
        if !path.exists() {
            return Err(format!("bundled motion blur runtime is missing: {}", path.display()));
        }
    }

    let auto_threads = detect_gpu_threads();
    let gpu_threads = if mb.gpu_threads == 0 {
        auto_threads
    } else {
        mb.gpu_threads.clamp(1, 2)
    };
    let stage2_label = if vs_method == "mvtools" {
        "rendering motion blur (motion compensation)".to_string()
    } else if gpu_threads > auto_threads {
        format!(
            "rendering motion blur (RIFE, {gpu_threads} gpu threads — more than this GPU's VRAM supports, expect a very slow render; use auto)"
        )
    } else {
        format!(
            "rendering motion blur (RIFE, {gpu_threads} gpu thread{})",
            if gpu_threads == 1 { "" } else { "s" }
        )
    };

    let mut vspipe_cmd = std::process::Command::new(&vspipe);
    #[cfg(windows)]
    vspipe_cmd.creation_flags(CREATE_NO_WINDOW);
    vspipe_cmd.args([
        "-c",
        "y4m",
        "-a",
        &format!("input_path={}", intermediate.display()),
        "-a",
        &format!("model_path={}", model.display()),
        "-a",
        &format!("interpolated_fps={}", rife_interp_fps(mb, p.fps).round()),
        "-a",
        &format!("output_fps={}", p.fps.round()),
        "-a",
        &format!("weights={}", rife_weights(mb, p.fps)),
        "-a",
        &format!("method={vs_method}"),
        "-a",
        &format!("gpu_thread={gpu_threads}"),
        "-a",
        // uhd mode halves the optical-flow resolution; only worth the
        // quality trade above 1080p, where full-res flow gets very slow
        &format!("uhd={}", u32::from(p.height > 1080)),
        script.to_string_lossy().as_ref(),
        "-",
    ]);
    vspipe_cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut vspipe_child = vspipe_cmd
        .spawn()
        .map_err(|e| format!("failed to start bundled RIFE runtime: {e}"))?;
    state.worker_pid.store(vspipe_child.id(), Ordering::SeqCst);
    let vspipe_out = vspipe_child
        .stdout
        .take()
        .ok_or("bundled RIFE runtime has no output pipe")?;
    let vspipe_err_thread = collect_stderr(vspipe_child.stderr.take());

    let mezzanine = build_dir.join("rife-blurred.mkv");
    let mut enc = encode_settings(p, render_total);
    enc.preset = "veryfast";
    let total_frames = (render_total * p.fps).ceil() as u64;

    // stage-2 finishing graph: mask-merge sharp pixels back in, apply the
    // color controls, then burn in text — all after the blur, like the preview
    let mask_path = write_mask_png(mb, build_dir)?;
    let eq = eq_filter(mb);
    let text_present = p.clips.iter().any(|c| c.kind == "text" && c.text.is_some());
    let use_graph = mask_path.is_some() || eq.is_some() || text_present;

    let mut cmd = ffmpeg::command("ffmpeg")?;
    cmd.current_dir(build_dir);
    cmd.args(["-y", "-hide_banner", "-nostats", "-i", "pipe:0", "-i"]);
    cmd.arg(&intermediate);
    if let Some(mask) = &mask_path {
        cmd.args(["-loop", "1", "-t", &f(render_total), "-i"]);
        cmd.arg(mask);
    }
    if use_graph {
        let (w, h, fps) = (p.width, p.height, p.fps);
        let mut g2 = String::new();
        let mut prev2 = String::from("vrife");
        writeln!(g2, "[0:v]null[vrife];").unwrap();
        if mask_path.is_some() {
            // input 1 (the pre-RIFE intermediate) provides the sharp pixels
            writeln!(g2, "[1:v]format=yuva420p[vsharp];").unwrap();
            writeln!(g2, "[2:v]fps={fps},scale={w}:{h},format=gray[vmask];").unwrap();
            writeln!(g2, "[vsharp][vmask]alphamerge[vsharpa];").unwrap();
            writeln!(g2, "[vrife][vsharpa]overlay=0:0:shortest=1[vmasked];").unwrap();
            prev2 = "vmasked".to_string();
        }
        if let Some(eq) = &eq {
            writeln!(g2, "[{prev2}]{eq}[veq];").unwrap();
            prev2 = "veq".to_string();
        }
        append_text_overlays(&mut g2, &mut prev2, p, render_total, fps, build_dir)?;
        writeln!(g2, "[{prev2}]format=yuv420p[vout];").unwrap();
        std::fs::write(build_dir.join("filter-stage2.txt"), &g2)
            .map_err(|e| format!("filter file: {e}"))?;
        cmd.args(["-filter_complex_script", "filter-stage2.txt"]);
        cmd.args(["-map", "[vout]", "-map", "1:a?"]);
    } else {
        cmd.args(["-map", "0:v", "-map", "1:a?"]);
    }
    if size_targeted {
        cmd.args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-crf", "12"]);
        cmd.args(["-c:a", "copy"]);
    } else {
        cmd.args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", enc.preset]);
        if let Some(crf) = enc.crf {
            cmd.args(["-crf", &format!("{crf}")]);
        } else if let Some(b) = enc.video_bitrate {
            cmd.args(["-b:v", &b.to_string(), "-maxrate", &b.to_string(), "-bufsize", &(b * 2).to_string()]);
        }
        cmd.args(["-c:a", "aac", "-b:a", enc.audio_bitrate, "-movflags", "+faststart"]);
    }
    // audio (input 1) is a complete file even when the RIFE pipe is stopped
    // early — without -shortest ffmpeg keeps muxing audio to its end and the
    // player would hold the last video frame for the remainder
    cmd.args(["-shortest", "-progress", "pipe:1"]);
    if size_targeted {
        cmd.arg(&mezzanine);
    } else {
        cmd.arg(&p.out_path);
    }
    cmd.stdin(Stdio::from(vspipe_out)).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("failed to start final RIFE encode: {e}"))?;
    state.child_pid.store(child.id(), Ordering::SeqCst);
    let stderr_thread = collect_stderr(child.stderr.take());

    // the runtime takes a while to load (model upload / source indexing)
    // before the first frame comes out — tell the UI why
    emit_stage(
        app,
        progress_base + progress_span * stage1_end,
        render_total,
        total_frames,
        if vs_method == "mvtools" {
            "starting motion blur runtime"
        } else {
            "starting RIFE motion blur (loading model)"
        },
    );

    if let Some(out) = child.stdout.take() {
        pump_progress(
            app,
            state,
            out,
            p.fps,
            render_total,
            total_frames,
            progress_base + progress_span * stage1_end,
            progress_span * (stage2_end - stage1_end),
            &stage2_label,
            || {
                let _ = vspipe_child.kill();
            },
        );
    }

    if state.cancelled.load(Ordering::SeqCst) {
        let _ = child.kill();
        let _ = vspipe_child.kill();
        let _ = child.wait();
        let _ = vspipe_child.wait();
        let _ = stderr_thread.join();
        let _ = vspipe_err_thread.join();
        let _ = std::fs::remove_file(&p.out_path);
        return Err("cancelled".into());
    }

    let status = child.wait().map_err(|e| format!("RIFE encode wait failed: {e}"))?;
    let vspipe_status = vspipe_child.wait().map_err(|e| format!("RIFE runtime wait failed: {e}"))?;
    state.worker_pid.store(0, Ordering::SeqCst);
    let stderr_text = stderr_thread.join().unwrap_or_default();
    let vspipe_text = vspipe_err_thread.join().unwrap_or_default();
    if !status.success()
        || (!vspipe_status.success() && !state.finish_requested.load(Ordering::SeqCst))
    {
        let details = format!("{vspipe_text}\n{stderr_text}");
        let tail = details.lines().rev().take(14).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("RIFE motion blur export failed:\n{tail}"));
    }

    if size_targeted {
        run_two_pass_encode(
            app,
            state,
            p,
            &mezzanine,
            build_dir,
            progress_base + progress_span * stage2_end,
            progress_span * (1.0 - stage2_end),
        )?;
    }

    if !state.finish_requested.load(Ordering::SeqCst) {
        let _ = app.emit(
            "export-progress",
            ProgressEvent {
                percent: progress_base + progress_span,
                current_seconds: render_total,
                total_seconds: render_total,
                current_frame: total_frames,
                total_frames,
                eta_seconds: 0.0,
                speed: String::new(),
                stage: "done".into(),
            },
        );
    }
    Ok(())
}

/// Stage 3 for size-limited RIFE exports: two-pass x264 from the mezzanine
/// file to the target bitrate. Two-pass hits the average within a couple of
/// percent, so the 9 MB discord budget stays safely under the 10 MB limit.
fn run_two_pass_encode(
    app: &AppHandle,
    state: &ExportState,
    p: &ExportPayload,
    mezzanine: &std::path::Path,
    build_dir: &std::path::Path,
    base: f64,
    span: f64,
) -> Result<(), String> {
    let duration = probe_duration(mezzanine)?.max(0.05);
    let enc = encode_settings(p, duration);
    let bitrate = enc.video_bitrate.ok_or("size-limited export without a target bitrate")?;
    let passlog = build_dir.join("x264-2pass");
    let total_frames = (duration * p.fps).ceil() as u64;

    for pass in 1..=2u32 {
        let mut cmd = ffmpeg::command("ffmpeg")?;
        cmd.args(["-y", "-hide_banner", "-nostats", "-i"]);
        cmd.arg(mezzanine);
        cmd.args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium"]);
        cmd.args([
            "-b:v",
            &bitrate.to_string(),
            "-maxrate",
            &(bitrate * 3 / 2).to_string(),
            "-bufsize",
            &(bitrate * 3).to_string(),
        ]);
        cmd.args(["-pass", &pass.to_string(), "-passlogfile"]);
        cmd.arg(&passlog);
        if pass == 1 {
            cmd.args(["-an", "-f", "null", "-progress", "pipe:1", "NUL"]);
        } else {
            cmd.args(["-c:a", "aac", "-b:a", enc.audio_bitrate]);
            cmd.args(["-movflags", "+faststart", "-progress", "pipe:1"]);
            cmd.arg(&p.out_path);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("failed to start size-targeted encode: {e}"))?;
        state.child_pid.store(child.id(), Ordering::SeqCst);
        let stderr_thread = collect_stderr(child.stderr.take());

        if let Some(out) = child.stdout.take() {
            let pass_base = base + span * if pass == 1 { 0.0 } else { 0.5 };
            let stage = if pass == 1 {
                "fitting size limit (analysis pass 1/2)"
            } else {
                "fitting size limit (final encode 2/2)"
            };
            emit_stage(app, pass_base, duration, total_frames, stage);
            pump_progress(
                app, state, out, p.fps, duration, total_frames, pass_base, span * 0.5, stage,
                || {},
            );
        }

        if state.cancelled.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_thread.join();
            let _ = std::fs::remove_file(&p.out_path);
            return Err("cancelled".into());
        }
        let status = child.wait().map_err(|e| format!("size-targeted encode wait failed: {e}"))?;
        let stderr_text = stderr_thread.join().unwrap_or_default();
        if !status.success() {
            let tail = stderr_text
                .lines()
                .rev()
                .take(10)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(format!("size-targeted encode failed:\n{tail}"));
        }
    }
    Ok(())
}
