// export.js - Handles export functionality.

const myExportBtn = document.getElementById("export-btn");
const myCancelBtn = document.getElementById("cancel-export-btn");

// allClipsAre120: Checks if all clips are 120fps.
function allClipsAre120() {
  if (typeof clips === 'undefined' || !clips.length) return false;
  // Ignore audio clips (which might have type='audio' or 0 fps)
  const videoClips = clips.filter(c => c.type !== 'audio');
  if (!videoClips.length) return false; 
  return videoClips.every((c) => Math.round(c.fps || 0) === 120);
}

// DOM elements
const exportOverlay = document.getElementById("export-overlay");
const exportFill = document.getElementById("export-progress-fill");
const exportPct = document.getElementById("export-progress-pct");
const exportFrameStats = document.getElementById("export-frame-stats");
const exportTimeStats = document.getElementById("export-time-stats");


const exportPreviewCanvas = document.getElementById("export-preview-canvas");
let exportPreviewCtx = null;

if (exportPreviewCanvas) {
    exportPreviewCtx = exportPreviewCanvas.getContext("2d");
} else {
    // Only warn if we actually expect it to be there (it should be)
    // console.warn("Export preview canvas not found!");
}

// Restore Cancel Listener
if (myCancelBtn) {
    myCancelBtn.addEventListener("click", () => {
        ipcRenderer.send("cancel-export");
        if (exportFrameStats) exportFrameStats.textContent = "Cancelling...";
    });
}

// Helper to update controls
function setControlsEnabled(enabled) {
}

let lastPreviewUpdate = 0;

// ipcRenderer event listeners
ipcRenderer.on("export-progress", (_e, p) => {
  if (exportOverlay) exportOverlay.style.display = "flex";
  
  const pct = Math.round((p.percent || 0) * 100);
  if (exportFill) exportFill.style.width = `${pct}%`;
  if (exportPct) exportPct.textContent = `${pct}%`;
  
  if (exportFrameStats) {
      if (p.currentFrame && p.totalFrames) {
          exportFrameStats.textContent = `${p.currentFrame} / ${p.totalFrames} Frames`;
      } else {
          exportFrameStats.textContent = "Rendering...";
      }
  }

  if (exportTimeStats && p.etaSeconds !== undefined) {
      const min = Math.floor(p.etaSeconds / 60);
      const sec = Math.floor(p.etaSeconds % 60);
      exportTimeStats.textContent = `Left: ${min}:${sec.toString().padStart(2,'0')}`;
  }

  // UPDATING PREVIEW (Throttled: every 500ms)
  const now = Date.now();
  if (now - lastPreviewUpdate > 500 && p.currentSeconds !== undefined) {
      lastPreviewUpdate = now;
      if (typeof routePreviewToTime === 'function') {
          routePreviewToTime(p.currentSeconds, { forceSeek: true });
          
          if (exportPreviewCtx && exportPreviewCanvas) {
              let sourceVideo = null;
              if (typeof front !== 'undefined' && front) {
                  sourceVideo = front;
              } else {
                  // Fallback
                  sourceVideo = document.getElementById("video-a");
              }

              if (sourceVideo) {
                  // Ensure we are drawing something even if opacity is 0
                  exportPreviewCtx.drawImage(sourceVideo, 0, 0, exportPreviewCanvas.width, exportPreviewCanvas.height);
              }
          }
      }
  }
});

// restoreMainPreview: Restores the main preview after export.
function restoreMainPreview() {
    const pm = document.getElementById("preview-media");
    if (pm) pm.style.opacity = "1";
    if (exportOverlay) exportOverlay.style.display = "none";
}

ipcRenderer.on("export-complete", () => {
  if (exportFill) exportFill.style.width = "100%";
  if (exportPct) exportPct.textContent = "100%";
  if (exportFrameStats) exportFrameStats.textContent = "Done!";
  setTimeout(restoreMainPreview, 1500);
});

ipcRenderer.on("export-error", (_e, args) => {
  if (exportFrameStats) exportFrameStats.textContent = args?.error === "Cancelled" ? "Cancelled" : "Failed";
  setTimeout(restoreMainPreview, 2000);
});

if (myExportBtn) {
    myExportBtn.addEventListener("click", async () => {
      console.log("Export started");
      
      // Safety check for clips availability
      if (typeof clips === 'undefined') {
          console.error("'clips' variable is undefined. Check init.js scope.");
          alert("Error: internal state 'clips' not found.");
          return;
      }
      
      if (!clips || !clips.length) return;

      const totalDuration = clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
      
      try {
          const presetPick = await ipcRenderer.invoke("open-export-presets", { 
            allow120: allClipsAre120(),
            duration: totalDuration 
          });
          if (!presetPick) return;

          const outPath = await ipcRenderer.invoke("save-export-dialog");
          if (!outPath) return;

          // Reset UI
          const pm = document.getElementById("preview-media");
          if (pm) pm.style.opacity = "0"; // Hide main preview to avoid flickering/distraction

          if (exportOverlay) exportOverlay.style.display = "flex";
          if (exportFill) exportFill.style.width = "0%";
          if (exportPct) exportPct.textContent = "0%";
          if (exportFrameStats) exportFrameStats.textContent = "Starting...";
          if (exportTimeStats) exportTimeStats.textContent = "--:--";
          if (exportPreviewCtx) exportPreviewCtx.clearRect(0, 0, exportPreviewCanvas.width, exportPreviewCanvas.height);

          const payloadClips = [...clips].map((c) => ({
            ...c,
            audioTracks: (c.audioTracks || []).map((t) => ({
              enabled: t.enabled !== false,
              audioOrder: Number.isFinite(t.audioOrder) ? t.audioOrder : 0,
              volume: t.volume ?? 1.0
            })),
          }));

          const width = Number(presetPick.width) || 1920;
          const height = Number(presetPick.height) || 1080;
          const fps = Number(presetPick.fps) || 60;

          const r = await ipcRenderer.invoke("export-project", {
            clips: payloadClips,
            outPath,
            width,
            height,
            fps,
            preset: presetPick.preset || "custom",
            targetSizeBytes: presetPick.targetSizeBytes, // Pass custom size if any
            bitrate: presetPick.bitrate, // Pass custom bitrate if any
            crf: presetPick.crf // Pass CRF
          });

          if (!r?.ok) {
            if (r?.error !== "cancelled") {
              console.error("Export failed:", r);
              alert(`Export failed: ${r?.error || "unknown"}`);
            }
          }
      } catch (err) {
          console.error("Export Error:", err);
          alert("Export Error: " + err.message);
      }
    });
} else {
    console.error("Export Button not found!");
}

renderTimeline();
routePreviewToTime(globalTime, { forceSeek: true });
applyPreviewQuality();
