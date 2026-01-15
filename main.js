// main.js
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

// Bundled binaries
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

let mainWindow;

// --- EXPORT STATE MANAGEMENT ---
let currentExport = {
  process: null,
  cancelled: false
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: "#121212",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Hide the menu bar by default (Windows/Linux). Users can still reveal it via Alt if desired.
  try { mainWindow.setMenuBarVisibility(false); } catch { }

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => (mainWindow = null));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// -------------------- Helpers --------------------
function runProcess(cmd, args, { timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    const to = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { }
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(to);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(to);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `${cmd} exited with code ${code}`));
    });
  });
}

async function canRunBinary(binPath) {
  return new Promise((resolve) => {
    if (!binPath) return resolve(false);
    const child = spawn(binPath, ["-version"], { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// -------------------- IPC: status --------------------
ipcMain.handle("ffmpeg-status", async () => {
  const ffmpegOk = await canRunBinary(ffmpegPath);
  const ffprobeOk = await canRunBinary(ffprobePath);
  return { ffmpegOk, ffprobeOk, ffmpegPath, ffprobePath };
});

// -------------------- IPC: dialogs --------------------
ipcMain.handle("open-file-dialog", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Media", extensions: ["mp4", "mkv", "mov", "webm", "ogg", "mp3", "wav", "m4a", "flac"] }],
  });
  if (result.canceled || !result.filePaths?.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("save-export-dialog", async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export video",
    defaultPath: path.join(app.getPath("videos"), `export_${Date.now()}.mp4`),
    filters: [{ name: "MP4", extensions: ["mp4"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

// -------------------- IPC: Thumbnails --------------------
ipcMain.handle("generate-thumbnail", async (_evt, filePath) => {
  const ok = await canRunBinary(ffmpegPath);
  if (!ok) return null;

  const tmpName = `thumb_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
  const tmpPath = path.join(os.tmpdir(), tmpName);

  try {
    await runProcess(ffmpegPath, [
      "-y", "-ss", "00:00:00", "-i", filePath,
      "-vframes", "1", "-vf", "scale=-1:60", tmpPath
    ], { timeoutMs: 5000 });
    return `file://${tmpPath.replace(/\\/g, "/")}`;
  } catch (e) {
    return null;
  }
});

// -------------------- IPC: probe --------------------
ipcMain.handle("probe-media", async (_evt, filePath) => {
  const ok = await canRunBinary(ffprobePath);
  if (!ok) return { ok: false, error: "ffprobe_not_found", duration: 0, video: null, audioStreams: [] };

  try {
    const out = await runProcess(
      ffprobePath,
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath],
      { timeoutMs: 20_000 }
    );

    const data = JSON.parse(out.stdout || "{}") || {};
    const streams = Array.isArray(data.streams) ? data.streams : [];

    const v0 = streams.find((s) => s.codec_type === "video");
    const video = v0
      ? {
        width: Number(v0.width) || 0,
        height: Number(v0.height) || 0,
        r_frame_rate: typeof v0.r_frame_rate === "string" ? v0.r_frame_rate : "",
      }
      : null;

    const duration = Number(data?.format?.duration) || 0;

    const audioOnly = streams.filter((s) => s.codec_type === "audio");
    const audioStreams = audioOnly.map((s, order) => ({
      order,
      index: Number(s.index) || 0,
      channels: Number(s.channels) || 0,
    }));

    return { ok: true, duration, video, audioStreams };
  } catch (e) {
    return { ok: false, error: "ffprobe_failed", duration: 0, video: null, audioStreams: [] };
  }
});

// -------------------- IPC: extract audio stream --------------------
ipcMain.handle("extract-audio-stream", async (_evt, args) => {
  const ok = await canRunBinary(ffmpegPath);
  if (!ok) return { ok: false, error: "ffmpeg_not_found", outPath: null };

  try {
    const filePath = args?.filePath;
    const streamIndex = Number(args?.streamIndex);
    if (!filePath || !Number.isFinite(streamIndex)) {
      return { ok: false, error: "bad_args", outPath: null };
    }

    const tmpDir = path.join(os.tmpdir(), "pro-video-editor-audio");
    fs.mkdirSync(tmpDir, { recursive: true });

    const outPath = path.join(
      tmpDir,
      `audio_${Date.now()}_${Math.random().toString(16).slice(2)}_s${streamIndex}.wav`
    );

    await runProcess(
      ffmpegPath,
      [
        "-y", "-i", filePath,
        "-map", `0:${streamIndex}`,
        "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le",
        outPath,
      ],
      { timeoutMs: 120_000 }
    );

    return { ok: true, error: null, outPath };
  } catch (e) {
    return { ok: false, error: "ffmpeg_failed", outPath: null, detail: String(e?.message || e) };
  }
});

// -------------------- Export Preset Window --------------------
ipcMain.handle("open-export-presets", async (_evt, args) => {
  const win = new BrowserWindow({
    width: 520, height: 700,
    resizable: false, minimizable: false, maximizable: false,
    parent: mainWindow || undefined,
    modal: true, show: true,
    backgroundColor: "#121212",
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  try { win.setMenuBarVisibility(false); } catch { }

  win.loadFile(path.join(__dirname, "export.html"));
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("export-presets-init", { 
      allow120: !!args?.allow120,
      duration: args?.duration || 0
    });
  });

  return await new Promise((resolve) => {
    ipcMain.once("export-preset-selected", (_e, payload) => {
      try { if (!win.isDestroyed()) win.close(); } catch { }
      resolve(payload || null);
    });
    win.on("closed", () => resolve(null));
  });
});

ipcMain.on("cancel-export", () => {
  if (currentExport.process) {
    console.log("Export cancellation requested...");
    currentExport.cancelled = true;
    try { currentExport.process.kill("SIGKILL"); } catch (e) { }
  }
});

// -------------------- IPC: Export (Professional Mix Strategy) --------------------
ipcMain.handle("export-project", async (_evt, payload) => {
  currentExport.cancelled = false;
  currentExport.process = null;

  const ok = await canRunBinary(ffmpegPath);
  if (!ok) return { ok: false, error: "ffmpeg_not_found" };

  const { clips, outPath, width, height, fps, preset } = payload || {};
  if (!Array.isArray(clips) || clips.length === 0) return { ok: false, error: "no_clips" };
  if (!outPath) return { ok: false, error: "no_output" };

  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-build-"));
  const audioOutPath = path.join(buildDir, "master_audio.wav");

  const videoClips = clips.filter(c => c.type !== 'audio').sort((a, b) => a.startTime - b.startTime);
  
  let totalDuration = videoClips.reduce((acc, c) => acc + (c.duration || 0), 0);
  
  if (totalDuration === 0) {
      totalDuration = clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0) || 1;
  }

  // PRESET BITRATE TABLE (Mbps)
  // Ensures size estimation in UI matches actual export size.
  const BITRATES = {
    normal: 6_000_000,   // 6 Mbps
    smooth: 10_000_000,  // 10 Mbps (High FPS needs more)
    hq: 18_000_000,      // 18 Mbps (1440p needs more)
    discord: null,       // Calculated dynamically below
    custom: null         // Calculated below or via targetBytes
  };

  let videoBitrate = "4M"; // Fallback
  let audioBitrate = "192k";
  let videoPreset = "medium";
  let videoCRF = null; // Default to CBR/VBR-max mode instead of CRF for predictability

  let targetBytes = payload?.targetSizeBytes || 0;
  
  if (payload?.crf !== undefined && payload.crf !== null) {
      videoCRF = `${payload.crf}`;
      videoBitrate = null; 
  }

  if (preset === "discord") {
    targetBytes = 9 * 1024 * 1024;
    audioBitrate = "128k";
    videoPreset = "veryfast";
    videoCRF = null; // Enforce bitrate mode
  } 
  
  if (targetBytes > 0) {
    const overhead = 0.95; 
    const targetBits = targetBytes * 8 * overhead;
    const aBitrateVal = (audioBitrate === "128k") ? 128000 : 192000;
    const vBitrateVal = Math.max(100_000, Math.floor((targetBits / totalDuration) - aBitrateVal));
    videoBitrate = `${vBitrateVal}`;
    videoCRF = null; // Bitrate mode active
  } else if (BITRATES[preset]) {
     // Fixed Bitrate Presets
     videoBitrate = `${BITRATES[preset]}`;
     videoCRF = null;
     if (preset === "hq") {
       audioBitrate = "320k"; // HQ gets better audio
     }
  } 
  
  if (videoCRF !== null) {
      videoBitrate = null;
  } else if (!videoBitrate && targetBytes <= 0 && !BITRATES[preset]) {
      videoBitrate = "4M";
  }

  try {
    mainWindow?.webContents.send("export-progress", { percent: 0, currentSeconds: 0, totalSeconds: totalDuration, etaSeconds: 0 });

    const audioInputs = [];
    const filterComplex = [];
    
    audioInputs.push("-f", "lavfi", "-t", String(totalDuration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    
    let inputMap = new Map();
    let nextInputIdx = 1; 

    // Gather unique file inputs
    clips.forEach(c => {
        if (!inputMap.has(c.filePath)) {
            inputMap.set(c.filePath, nextInputIdx++);
            audioInputs.push("-i", c.filePath);
        }
    });

    // Build Mixing Graph
    let currentMixLabel = "[0:a]"; // Start with silence
    let mixCount = 0;

    clips.forEach((c, i) => {
        const inputIdx = inputMap.get(c.filePath);
        const tracks = (c.audioTracks || []).filter(t => t.enabled);

        tracks.forEach((t, trackIdx) => {
            // Trim source
            const trimLabel = `[clip${i}_t${trackIdx}]`;
            const delayLabel = `[delayed${i}_t${trackIdx}]`;
            
            // Calculate timing
            const start = c.inPoint;
            const duration = c.duration;
            const delayMs = Math.floor(c.startTime * 1000);
            const volume = t.volume ?? 1.0;

            filterComplex.push(
                `[${inputIdx}:a:${t.audioOrder || 0}]` +
                `atrim=start=${start}:end=${start + duration},` +
                `asetpts=PTS-STARTPTS,` +
                `volume=${volume},` + 
                `aresample=48000:async=1` +
                // --- FADE IN/OUT ---
                (c.fadeIn > 0 ? `,afade=t=in:ss=0:d=${c.fadeIn}` : "") +
                (c.fadeOut > 0 ? `,afade=t=out:st=${duration - c.fadeOut}:d=${c.fadeOut}` : "") +
                // -------------------
                `${trimLabel}`
            );

            filterComplex.push(
                `${trimLabel}adelay=${delayMs}|${delayMs}${delayLabel}`
            );

            // Mix into main chain
            // duration=first ensures we never extend past the silence base (which is totalDuration)
            const nextMixLabel = `[mix_${mixCount++}]`;
            filterComplex.push(
                `${currentMixLabel}${delayLabel}amix=inputs=2:duration=first:dropout_transition=0:normalize=0${nextMixLabel}`
            );
            currentMixLabel = nextMixLabel;
        });
    });

    // Final Output Node
    filterComplex.push(`${currentMixLabel}aformat=channel_layouts=stereo[aout]`);

    // Write Filter Script to file to avoid CLI length limits
    const filterPath = path.join(buildDir, "audio_filter.txt");
    fs.writeFileSync(filterPath, filterComplex.join(";"));

    const audioArgs = [
        "-y", 
        ...audioInputs, 
        "-filter_complex_script", filterPath,
        "-map", "[aout]",
        "-c:a", "pcm_s16le", // Lossless intermediate
        audioOutPath
    ];

    await new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, audioArgs, { windowsHide: true });
        currentExport.process = child;
        child.on("close", (code) => {
            if (currentExport.cancelled) return reject("cancelled");
            if (code === 0) resolve(); else reject("Audio Render Failed");
        });
        child.on("error", reject);
    });

    // =========================================================
    // RENDER VIDEO CHUNKS
    // =========================================================
    const chunks = [];
    let globalDecodedFrames = 0;
    let globalDurationProcessed = 0;
    
    // Total Expected Frames
    const totalFrames = Math.ceil(totalDuration * Number(fps));
    
    // ETA Calculation State
    const exportStartTime = Date.now();

    for (let i = 0; i < videoClips.length; i++) {
        if (currentExport.cancelled) throw new Error("Export Cancelled");

        const c = videoClips[i];
        const chunkName = `vchunk_${i}.mov`;
        const chunkPath = path.join(buildDir, chunkName);
        
        const seekStart = Math.max(0, c.inPoint - 1.0);
        const trimStart = c.inPoint - seekStart;
        const dur = c.duration;
        const readDuration = dur + trimStart + 5.0;

        const W = Number(width);
        const H = Number(height);
        const F = Number(fps);
        
        // Frames in this chunk (approx)
        const chunkFrames = Math.ceil(dur * F);
        const chunkStartGlobalTime = globalDurationProcessed;
        const chunkStartGlobalFrames = globalDecodedFrames;

        const args = [
            "-y", 
            "-ss", `${seekStart}`, "-i", c.filePath, "-t", `${readDuration}`,
            "-filter_complex", 
            `[0:v]trim=start=${trimStart}:end=${trimStart + dur},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1,format=yuv420p,fps=${F}[vSrc];` +
            `color=c=black:s=${W}x${H}:r=${F}:d=${dur}[vBg];` +
            `[vBg][vSrc]overlay=(W-w)/2:(H-h)/2:shortest=0:eof_action=repeat` +
            // --- FADE VISUALS ---
            (c.fadeIn > 0 ? `,fade=t=in:st=0:d=${c.fadeIn}` : "") +
            (c.fadeOut > 0 ? `,fade=t=out:st=${dur - c.fadeOut}:d=${c.fadeOut}` : "") +
            `[vOut]`,
            "-map", "[vOut]",
            "-an", // NO AUDIO in video chunks
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", videoPreset
        ];

        if (videoCRF) args.push("-crf", videoCRF);
        else args.push("-b:v", videoBitrate, "-maxrate", videoBitrate, "-bufsize", `${parseInt(videoBitrate) * 2}`);
        
        args.push(chunkPath);

        await new Promise((resolve, reject) => {
            const child = spawn(ffmpegPath, args, { windowsHide: true });
            currentExport.process = child;
            
            // Progress Logic
            const timeRe = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/;
            const frameRe = /frame=\s*(\d+)/;
            
            child.stderr.on("data", (buf) => {
              const s = buf.toString();
              const tm = s.match(timeRe);
              const fm = s.match(frameRe);
              
              if (tm) {
                const hh = Number(tm[1]), mm = Number(tm[2]), ss = Number(tm[3]);
                const curChunkTime = hh * 3600 + mm * 60 + ss;
                
                // Calculate Global Percent
                const overallBase = 0.1; 
                const overallRange = 0.8; 
                
                const doneDur = chunkStartGlobalTime + Math.min(curChunkTime, dur);
                const pct = overallBase + (doneDur / totalDuration) * overallRange;

                let curFrame = 0;
                if (fm) {
                    curFrame = chunkStartGlobalFrames + Number(fm[1]);
                } else {
                    // Fallback estimate
                    curFrame = Math.floor(doneDur * F);
                }
                
                // ETA Calculation (Simple Linear)
                const elapsedMs = Date.now() - exportStartTime;
                let eta = 0;
                if (pct > 0.1 && pct < 1.0) {
                    // Normalized progress within the render phase (0.1 to 0.9)
                    const renderProgress = (pct - 0.1) / 0.8;
                    if (renderProgress > 0.01) {
                         const totalEstTime = elapsedMs / renderProgress;
                         eta = (totalEstTime - elapsedMs) / 1000;
                    }
                }

                mainWindow?.webContents.send("export-progress", {
                  percent: pct,
                  currentSeconds: doneDur, 
                  totalSeconds: totalDuration,
                  currentFrame: curFrame,
                  totalFrames: totalFrames,
                  etaSeconds: Math.ceil(eta)
                });
              }
            });

            child.on("close", (code) => {
                if (currentExport.cancelled) return reject("cancelled");
                if (code === 0) resolve(); else reject(`Video Chunk ${i} failed`);
            });
            child.on("error", reject);
        });

        chunks.push(`file '${chunkName}'`);
        
        // Update Globals
        globalDurationProcessed += dur;
        globalDecodedFrames += chunkFrames;
    }

    if (currentExport.cancelled) throw new Error("Export Cancelled");

    // =========================================================
    // FINAL MERGE (Video Chunks + Master Audio)
    // =========================================================
    const listPath = path.join(buildDir, "list.txt");
    fs.writeFileSync(listPath, chunks.join("\n"));

    await runProcess(ffmpegPath, [
        "-y", 
        "-f", "concat", "-safe", "0", "-i", listPath, // Input 0: Video
        "-i", audioOutPath,                           // Input 1: Master Audio
        "-map", "0:v", "-map", "1:a",
        "-c:v", "copy",                               // Smart Copy Video
        "-c:a", "aac", "-b:a", audioBitrate,          // Encode Audio to AAC final
        "-shortest",                                  // FIX 2: Stop writing when the video ends
        "-movflags", "+faststart",
        outPath
    ]);

    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (e) { }

    mainWindow?.webContents.send("export-complete", { outPath });
    return { ok: true };

  } catch (err) {
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (e) { }

    if (String(err).includes("cancelled")) {
      mainWindow?.webContents.send("export-error", { error: "Cancelled" });
      return { ok: false, error: "cancelled" };
    }

    console.error("Export Failed:", err);
    mainWindow?.webContents.send("export-error", { code: -1 });
    return { ok: false, error: "export_failed" };
  } finally {
    currentExport.process = null;
    currentExport.cancelled = false;
  }
});