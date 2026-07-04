// exportui.js - export presets modal, progress overlay, invoking the
// Rust single-pass export.

import { invoke, listen, saveExportDialog, messageBox } from "./tauri.js";
import { state, emit, contentEnd, clipEnd, layerIndex } from "./state.js";
import * as player from "./player.js";
import { formatTimeShort } from "./utils.js";

const modal = document.getElementById("export-modal");
const progressOverlay = document.getElementById("progress-overlay");
const fill = document.getElementById("export-fill");
const pctEl = document.getElementById("export-pct");
const framesEl = document.getElementById("export-frames");
const etaEl = document.getElementById("export-eta");
const exportCanvas = document.getElementById("export-preview-canvas");
const exportCtx = exportCanvas.getContext("2d");

const PRESETS = {
  discord: { width: 1280, height: 720, fps: 60 },
  normal: { width: 1920, height: 1080, fps: 60 },
  smooth: { width: 1920, height: 1080, fps: 120 },
  hq: { width: 2560, height: 1440, fps: 120 },
};
const PRESET_BITRATES = { normal: 6e6, smooth: 10e6, hq: 18e6 };

function clamp01(v, max) {
  return Math.max(0, Math.min(max, v));
}

function allClipsAre120() {
  const v = state.clips.filter((c) => c.kind === "video");
  return v.length > 0 && v.every((c) => Math.round(c.fps || 0) >= 120);
}

function estimateMB(videoBps, audioBps, duration) {
  return ((videoBps + audioBps) * duration) / 8 / 1024 / 1024;
}

// -------------------- modal --------------------

const rangeRow = document.getElementById("export-range-row");
const rangeSelect = document.getElementById("export-range");

/// current export range: null = entire timeline
function exportRange() {
  if (state.loop && !rangeRow.hidden && rangeSelect.value === "loop") return state.loop;
  return null;
}

function exportDuration() {
  const r = exportRange();
  return r ? r.end - r.start : contentEnd();
}

function refreshDurations() {
  const dur = exportDuration();
  document.getElementById("export-duration").textContent = formatTimeShort(Math.round(dur));
  document.getElementById("size-normal").textContent = `~${estimateMB(6e6, 192e3, dur).toFixed(1)} MB`;
  document.getElementById("size-smooth").textContent = `~${estimateMB(10e6, 192e3, dur).toFixed(1)} MB`;
  document.getElementById("size-hq").textContent = `~${estimateMB(18e6, 320e3, dur).toFixed(1)} MB`;
  document.getElementById("size-discord").textContent = "9 MB";
}

rangeSelect.addEventListener("change", () => {
  refreshDurations();
  updateEstimate();
});

export function openExportModal() {
  if (!state.clips.length) {
    emit("status", "nothing to export");
    return;
  }
  player.stop();

  rangeRow.hidden = !state.loop;
  if (state.loop) rangeSelect.value = "loop";
  refreshDurations();

  const ok120 = allClipsAre120();
  document.querySelector('[data-preset="smooth"]').classList.toggle("disabled", !ok120);
  document.querySelector('[data-preset="hq"]').classList.toggle("disabled", !ok120);

  updateEstimate();
  modal.hidden = false;
}

document.getElementById("export-close").addEventListener("click", () => (modal.hidden = true));
modal.addEventListener("mousedown", (e) => {
  if (e.target === modal) modal.hidden = true;
});

// tabs
for (const tab of modal.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    modal.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    modal
      .querySelectorAll(".tab-page")
      .forEach((p) => p.classList.toggle("active", p.id === `tab-${tab.dataset.tab}`));
  });
}

// custom tab controls
const sizeSlider = document.getElementById("size-slider");
const targetMb = document.getElementById("target-mb");
const limitToggle = document.getElementById("limit-toggle");
const limitControls = document.getElementById("limit-controls");
const crfControls = document.getElementById("crf-controls");
const crfSlider = document.getElementById("crf-slider");
const crfVal = document.getElementById("crf-val");

// log scale: 0..100 -> 5MB..1024MB
function sliderToMb(v) {
  return 5 * Math.pow(1024 / 5, v / 100);
}
function mbToSlider(mb) {
  return (Math.log(mb / 5) / Math.log(1024 / 5)) * 100;
}

sizeSlider.addEventListener("input", () => {
  targetMb.value = Math.round(sliderToMb(parseFloat(sizeSlider.value)));
  updateEstimate();
});
targetMb.addEventListener("input", () => {
  const mb = Math.max(1, parseFloat(targetMb.value) || 50);
  sizeSlider.value = Math.max(0, Math.min(100, mbToSlider(mb)));
  updateEstimate();
});
limitToggle.addEventListener("change", () => {
  limitControls.hidden = !limitToggle.checked;
  crfControls.hidden = limitToggle.checked;
  updateEstimate();
});
crfSlider.addEventListener("input", () => {
  crfVal.textContent = crfSlider.value;
  updateEstimate();
});

function updateEstimate() {
  const dur = contentEnd();
  const el = document.getElementById("export-est-size");
  if (limitToggle.checked) {
    el.textContent = `${Math.round(parseFloat(targetMb.value) || 50)} MB`;
  } else {
    el.textContent = `crf ${crfSlider.value} (variable)`;
  }
  void dur;
}

// preset clicks
for (const presetEl of modal.querySelectorAll(".preset")) {
  presetEl.addEventListener("click", () => {
    const key = presetEl.dataset.preset;
    const p = PRESETS[key];
    runExport({
      width: p.width,
      height: p.height,
      fps: p.fps,
      preset: key,
      targetSizeBytes: 0,
      crf: null,
    });
  });
}

document.getElementById("export-custom").addEventListener("click", () => {
  const width = Math.max(16, parseInt(document.getElementById("cw").value) || 1920);
  const height = Math.max(16, parseInt(document.getElementById("ch").value) || 1080);
  const fps = Math.max(1, parseInt(document.getElementById("cfps").value) || 60);
  const useLimit = limitToggle.checked;
  runExport({
    width,
    height,
    fps,
    preset: "custom",
    targetSizeBytes: useLimit ? (parseFloat(targetMb.value) || 50) * 1024 * 1024 : 0,
    crf: useLimit ? null : parseFloat(crfSlider.value),
  });
});

// -------------------- run --------------------

function buildPayloadClips(range) {
  const out = [];
  for (const c of state.clips) {
    let startTime = c.startTime;
    let inPoint = c.inPoint || 0;
    let duration = c.duration;
    let fadeIn = c.fadeIn || 0;
    let fadeOut = c.fadeOut || 0;

    if (range) {
      // intersect the clip with the loop region and rebase to t=0
      const s = Math.max(c.startTime, range.start);
      const e = Math.min(clipEnd(c), range.end);
      if (e - s <= 0.01) continue;
      const cut = s - c.startTime;
      if (c.kind !== "text") inPoint += cut;
      if (cut > 0.001) fadeIn = 0; // fade start was cut off
      if (clipEnd(c) - e > 0.001) fadeOut = 0; // fade end was cut off
      startTime = s - range.start;
      duration = e - s;
    }

    out.push({
      kind: c.kind,
      filePath: c.filePath || "",
      startTime,
      inPoint,
      duration,
      fadeIn,
      fadeOut,
      layer: layerIndex(c),
      opacity: c.opacity ?? 1,
      crop:
        c.crop && c.crop.zoom > 1.001
          ? (() => {
              const w = 1 / c.crop.zoom;
              const h = 1 / c.crop.zoom;
              return {
                x: clamp01(c.crop.cx - w / 2, 1 - w),
                y: clamp01(c.crop.cy - h / 2, 1 - h),
                w,
                h,
              };
            })()
          : null,
      audioTracks: (c.audioTracks || []).map((t) => ({
        enabled: t.enabled !== false,
        audioOrder: t.order || 0,
        volume: t.volume ?? 1,
      })),
      text: c.text
        ? {
            content: c.text.content,
            font: c.text.font,
            bold: !!c.text.bold,
            size: c.text.size,
            color: c.text.color,
            outlineColor: c.text.outlineColor,
            outlineWidth: c.text.outlineWidth,
            x: c.text.x,
            y: c.text.y,
          }
        : null,
    });
  }
  return out;
}

let lastPreviewDraw = 0;
let previewOffset = 0; // loop-region exports preview at range.start + t

async function runExport(opts) {
  const range = exportRange();
  const clips = buildPayloadClips(range);
  if (!clips.length) {
    emit("status", "nothing to export in the selected range");
    return;
  }

  const outPath = await saveExportDialog();
  if (!outPath) return;

  modal.hidden = true;
  player.stop();
  state.exporting = true;

  fill.style.width = "0%";
  pctEl.textContent = "0%";
  framesEl.textContent = "starting...";
  etaEl.textContent = "eta --:--";
  previewOffset = range ? range.start : 0;
  player.drawAtTime(previewOffset);
  exportCtx.drawImage(player.previewCanvas(), 0, 0, exportCanvas.width, exportCanvas.height);
  progressOverlay.hidden = false;

  try {
    await invoke("export_project", {
      payload: {
        clips,
        outPath,
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        preset: opts.preset,
        targetSizeBytes: opts.targetSizeBytes || 0,
        crf: opts.crf,
      },
    });
    fill.style.width = "100%";
    pctEl.textContent = "100%";
    framesEl.textContent = "done";
    etaEl.textContent = "";
    setTimeout(() => (progressOverlay.hidden = true), 1200);
  } catch (err) {
    progressOverlay.hidden = true;
    if (String(err) !== "cancelled") {
      console.error("export failed:", err);
      await messageBox(`export failed:\n${err}`);
    }
  } finally {
    state.exporting = false;
  }
}

document.getElementById("cancel-export").addEventListener("click", () => {
  framesEl.textContent = "cancelling...";
  invoke("cancel_export").catch(() => {});
});

// -------------------- progress events --------------------

listen("export-progress", (event) => {
  const p = event.payload;
  const pct = Math.round((p.percent || 0) * 100);
  fill.style.width = `${pct}%`;
  pctEl.textContent = `${pct}%`;
  framesEl.textContent = `frame ${p.currentFrame || 0} / ${p.totalFrames || 0}`;
  const eta = Math.max(0, Math.round(p.etaSeconds || 0));
  etaEl.textContent = `eta ${Math.floor(eta / 60)}:${String(eta % 60).padStart(2, "0")}`;

  // live preview of the frame being rendered (throttled).
  // copy the canvas FIRST (it holds the last completed seek), then kick off
  // the seek for the next update — never copies a mid-seek black frame.
  const now = Date.now();
  if (now - lastPreviewDraw > 400 && p.currentSeconds !== undefined) {
    lastPreviewDraw = now;
    exportCtx.drawImage(player.previewCanvas(), 0, 0, exportCanvas.width, exportCanvas.height);
    player.drawAtTime(previewOffset + p.currentSeconds);
  }
});

document.getElementById("export-btn").addEventListener("click", openExportModal);
