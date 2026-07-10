// exportui.js - export presets modal, progress overlay, invoking the
// Rust single-pass export.

import { invoke, listen, saveExportDialog, messageBox, revealInFolder } from "./tauri.js";
import { state, emit, contentEnd, clipEnd, layerIndex } from "./state.js";
import * as player from "./player.js";
import { formatTimeShort } from "./utils.js";
import { openMaskEditor, getExportMask } from "./maskeditor.js";

const modal = document.getElementById("export-modal");
const progressOverlay = document.getElementById("progress-overlay");
const fill = document.getElementById("export-fill");
const pctEl = document.getElementById("export-pct");
const framesEl = document.getElementById("export-frames");
const etaEl = document.getElementById("export-eta");
const exportCanvas = document.getElementById("export-preview-canvas");
const exportCtx = exportCanvas.getContext("2d");
const exportStateTitle = document.getElementById("export-state-title");
const exportStageEl = document.getElementById("export-stage");
const exportResultMessage = document.getElementById("export-result-message");
const activeExportActions = document.getElementById("export-active-actions");
const completeExportActions = document.getElementById("export-complete-actions");
let lastExportPath = "";
let finishEarlyRequested = false;

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
const aspectSelect = document.getElementById("export-aspect");

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
  drawBlurColorPreview();
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

// -------------------- motion blur (inspired by f0e/blur) --------------------

const mb = {
  enable: document.getElementById("mb-enable"),
  settings: document.getElementById("mb-settings"),
  method: document.getElementById("mb-method"),
  amount: document.getElementById("mb-amount"),
  amountVal: document.getElementById("mb-amount-val"),
  interp: document.getElementById("mb-interp"),
  weighting: document.getElementById("mb-weighting"),
  brightness: document.getElementById("mb-brightness"),
  brightnessVal: document.getElementById("mb-brightness-val"),
  saturation: document.getElementById("mb-saturation"),
  saturationVal: document.getElementById("mb-saturation-val"),
  contrast: document.getElementById("mb-contrast"),
  contrastVal: document.getElementById("mb-contrast-val"),
  gamma: document.getElementById("mb-gamma"),
  gammaVal: document.getElementById("mb-gamma-val"),
  colorPreview: document.getElementById("mb-color-preview"),
  presetSelect: document.getElementById("mb-preset-select"),
  presetName: document.getElementById("mb-preset-name"),
  presetUpdate: document.getElementById("mb-preset-update"),
};

const MB_STORE_KEY = "bloom-mb-presets";

function mbSettings() {
  return normalizeMbSettings({
    enabled: mb.enable.checked,
    method: mb.method.value,
    interpFps: Math.max(60, parseFloat(mb.interp.value) || 300),
    amount: parseFloat(mb.amount.value) || 0,
    weighting: mb.weighting.value,
    brightness: parseFloat(mb.brightness.value),
    saturation: parseFloat(mb.saturation.value),
    contrast: parseFloat(mb.contrast.value),
    gamma: parseFloat(mb.gamma.value),
  });
}

function normalizeMbSettings(s = {}) {
  return {
    enabled: !!s.enabled,
    method: s.method || "rife",
    interpFps: Math.max(60, parseFloat(s.interpFps) || 300),
    amount: s.amount ?? 1,
    weighting: s.weighting || "equal",
    brightness: s.brightness ?? 1,
    saturation: s.saturation ?? 1,
    contrast: s.contrast ?? 1,
    gamma: s.gamma ?? 1,
  };
}

function mbApply(settings) {
  const s = normalizeMbSettings(settings);
  mb.enable.checked = !!s.enabled;
  mb.method.value = s.method;
  mb.amount.value = s.amount;
  mb.interp.value = s.interpFps;
  mb.weighting.value = s.weighting;
  mb.brightness.value = s.brightness;
  mb.saturation.value = s.saturation;
  mb.contrast.value = s.contrast;
  mb.gamma.value = s.gamma;
  mb.settings.hidden = !mb.enable.checked;
  mbControlChanged();
}

function mbSyncLabels() {
  mb.amountVal.textContent = mb.amount.value;
  mb.brightnessVal.textContent = mb.brightness.value;
  mb.saturationVal.textContent = mb.saturation.value;
  mb.contrastVal.textContent = mb.contrast.value;
  mb.gammaVal.textContent = mb.gamma.value;
}

function mbSettingsEqual(a, b) {
  const left = normalizeMbSettings(a);
  const right = normalizeMbSettings(b);
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function mbSyncPresetUpdate() {
  const name = mb.presetSelect.value;
  const preset = mbStore().presets[name];
  mb.presetUpdate.hidden = !preset || mbSettingsEqual(mbSettings(), preset);
}

// Snapshot of the first frame of the earliest video clip. Used when the
// playhead sits over empty timeline space, where the main preview is black.
const fallbackFrame = { key: "", canvas: null };

function videoUnderPlayhead() {
  return state.clips.some(
    (c) => c.kind === "video" && state.time >= c.startTime - 1e-3 && state.time < clipEnd(c) - 1e-3
  );
}

function firstVideoClip() {
  let best = null;
  for (const c of state.clips) {
    if (c.kind !== "video") continue;
    if (!best || c.startTime < best.startTime) best = c;
  }
  return best;
}

function loadFallbackFrame(clip) {
  const key = `${clip.id}:${clip.inPoint || 0}`;
  if (fallbackFrame.key === key) return fallbackFrame.canvas; // cached (or still loading)
  fallbackFrame.key = key;
  fallbackFrame.canvas = null;
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = clip.fileUrl;
  v.addEventListener("loadedmetadata", () => {
    v.currentTime = (clip.inPoint || 0) + 0.01;
  });
  v.addEventListener(
    "seeked",
    () => {
      if (fallbackFrame.key !== key) return;
      const c = document.createElement("canvas");
      c.width = v.videoWidth || 2;
      c.height = v.videoHeight || 2;
      c.getContext("2d").drawImage(v, 0, 0);
      fallbackFrame.canvas = c;
      v.removeAttribute("src");
      v.load();
      drawBlurColorPreview();
    },
    { once: true }
  );
  return null;
}

function previewSourceCanvas() {
  let source = player.previewCanvas();
  if (!videoUnderPlayhead()) {
    const clip = firstVideoClip();
    if (clip) source = loadFallbackFrame(clip) || source;
  }
  return source;
}

function drawBlurColorPreview() {
  const canvas = mb.colorPreview;
  const c = canvas.getContext("2d");
  const source = previewSourceCanvas();
  c.fillStyle = "#000";
  c.fillRect(0, 0, canvas.width, canvas.height);
  const sw = source.width || 1;
  const sh = source.height || 1;
  const s = Math.min(canvas.width / sw, canvas.height / sh);
  const dw = sw * s;
  const dh = sh * s;
  c.drawImage(source, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  const { brightness, saturation, contrast, gamma } = mbSettings();
  const intercept = brightness - 1 + (1 - contrast) / 2;
  for (const id of ["mb-linear-r", "mb-linear-g", "mb-linear-b"]) {
    const fn = document.getElementById(id);
    fn.setAttribute("slope", contrast);
    fn.setAttribute("intercept", intercept);
  }
  document.getElementById("mb-saturation-filter").setAttribute("values", saturation);
  for (const id of ["mb-gamma-r", "mb-gamma-g", "mb-gamma-b"]) {
    document.getElementById(id).setAttribute("exponent", 1 / gamma);
  }
  // WebView2 can cache SVG filter results; toggling the reference guarantees
  // an immediate repaint without reading potentially tainted video pixels.
  canvas.style.filter = "none";
  void canvas.offsetWidth;
  canvas.style.filter = "url(#mb-color-filter)";
}

function mbControlChanged() {
  mb.settings.hidden = !mb.enable.checked;
  mbSyncLabels();
  mbSyncPresetUpdate();
  drawBlurColorPreview();
}

for (const el of [
  mb.enable,
  mb.method,
  mb.amount,
  mb.interp,
  mb.weighting,
  mb.brightness,
  mb.saturation,
  mb.contrast,
  mb.gamma,
]) {
  el.addEventListener("input", mbControlChanged);
  el.addEventListener("change", mbControlChanged);
}

// gpu threads is machine-specific, so it lives outside blur presets
const gpuSelect = document.getElementById("mb-gpu-threads");
gpuSelect.value = localStorage.getItem("bloom-gpu-threads") || "0";
gpuSelect.addEventListener("change", () =>
  localStorage.setItem("bloom-gpu-threads", gpuSelect.value)
);

invoke("gpu_info")
  .then((g) => {
    const gb = (g.dedicatedBytes || 0) / 1024 ** 3;
    const vramText = gb >= 0.5 ? `${gb.toFixed(1)} GB dedicated VRAM` : "shared-memory GPU";
    document.getElementById("mb-gpu-hint").textContent =
      `detected: ${g.name} (${vramText}) · auto uses ${g.autoThreads} gpu thread${g.autoThreads > 1 ? "s" : ""}`;
  })
  .catch(() => {});

document.getElementById("mb-mask-edit").addEventListener("click", () => {
  openMaskEditor(previewSourceCanvas());
});

function mbStore() {
  try {
    return JSON.parse(localStorage.getItem(MB_STORE_KEY)) || { presets: {}, default: null };
  } catch {
    return { presets: {}, default: null };
  }
}

function mbSaveStore(store) {
  try {
    localStorage.setItem(MB_STORE_KEY, JSON.stringify(store));
  } catch {}
}

function mbRefreshPresetList(selected = "") {
  const store = mbStore();
  mb.presetSelect.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "(none)";
  mb.presetSelect.appendChild(none);
  for (const name of Object.keys(store.presets).sort()) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name === store.default ? `${name} (default)` : name;
    mb.presetSelect.appendChild(opt);
  }
  mb.presetSelect.value = selected;
  mbSyncPresetUpdate();
}

mb.presetSelect.addEventListener("change", () => {
  const store = mbStore();
  const preset = store.presets[mb.presetSelect.value];
  if (preset) mbApply(preset);
  else mbSyncPresetUpdate();
});

document.getElementById("mb-preset-save").addEventListener("click", () => {
  const name = mb.presetName.value.trim();
  if (!name) {
    emit("status", "enter a preset name first");
    return;
  }
  const store = mbStore();
  store.presets[name] = mbSettings();
  mbSaveStore(store);
  mb.presetName.value = "";
  mbRefreshPresetList(name);
  emit("status", `saved blur preset "${name}"`);
});

mb.presetUpdate.addEventListener("click", () => {
  const name = mb.presetSelect.value;
  if (!name) return;
  const store = mbStore();
  if (!store.presets[name]) return;
  store.presets[name] = mbSettings();
  mbSaveStore(store);
  mbRefreshPresetList(name);
  emit("status", `updated blur preset "${name}"`);
});

document.getElementById("mb-preset-delete").addEventListener("click", () => {
  const name = mb.presetSelect.value;
  if (!name) return;
  const store = mbStore();
  delete store.presets[name];
  if (store.default === name) store.default = null;
  mbSaveStore(store);
  mbRefreshPresetList();
  emit("status", `deleted blur preset "${name}"`);
});

document.getElementById("mb-preset-default").addEventListener("click", () => {
  const name = mb.presetSelect.value;
  const store = mbStore();
  store.default = name || null;
  mbSaveStore(store);
  mbRefreshPresetList(name);
  emit("status", name ? `"${name}" is now the default blur preset` : "default blur preset cleared");
});

// load the default preset on startup
{
  const store = mbStore();
  if (store.default && store.presets[store.default]) {
    mbApply(store.presets[store.default]);
    mbRefreshPresetList(store.default);
  } else {
    mbRefreshPresetList();
    mbControlChanged();
  }
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
      stretch: aspectSelect.value === "stretch",
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
    stretch: aspectSelect.value === "stretch",
  });
});

// -------------------- run --------------------

function buildPayloadClips(range, outW, outH) {
  const out = [];
  for (const c of state.clips) {
    let startTime = c.startTime;
    let inPoint = c.inPoint || 0;
    let duration = c.duration;
    let fadeIn = c.fadeIn || 0;
    let fadeOut = c.fadeOut || 0;
    const speed = c.speed || 1;

    if (range) {
      // intersect the clip with the loop region and rebase to t=0
      const s = Math.max(c.startTime, range.start);
      const e = Math.min(clipEnd(c), range.end);
      if (e - s <= 0.01) continue;
      const cut = s - c.startTime;
      if (c.kind !== "text") inPoint += cut * speed; // timeline cut -> source time
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
      speed,
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
            shadowColor: c.text.shadowColor || "#000000",
            shadowX: c.text.shadowX || 0,
            shadowY: c.text.shadowY || 0,
            shadowOpacity: c.text.shadowOpacity ?? 1,
            shadowBlur: c.text.shadowBlur || 0,
            gap: c.text.gap || 0,
            // letter gap needs per-glyph placement (drawtext has no tracking)
            chars: (c.text.gap || 0) > 0 ? player.computeCharLayout(c, outW, outH) : null,
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
  const clips = buildPayloadClips(range, opts.width, opts.height);
  if (!clips.length) {
    emit("status", "nothing to export in the selected range");
    return;
  }

  const outPath = await saveExportDialog();
  if (!outPath) return;
  lastExportPath = outPath;
  finishEarlyRequested = false;

  modal.hidden = true;
  player.stop();
  state.exporting = true;
  // frames are rendered through the main preview canvas and copied into the
  // export overlay — hide the editor preview so only the overlay shows them
  const previewBox = document.getElementById("preview-box");
  previewBox.style.visibility = "hidden";

  fill.style.width = "0%";
  pctEl.textContent = "0%";
  framesEl.textContent = "starting...";
  etaEl.textContent = "eta --:--";
  exportStateTitle.textContent = "exporting";
  exportStageEl.textContent = "preparing...";
  exportStageEl.hidden = false;
  exportResultMessage.hidden = true;
  exportResultMessage.textContent = "";
  activeExportActions.hidden = false;
  completeExportActions.hidden = true;
  document.getElementById("finish-export").disabled = false;
  document.getElementById("finish-export").textContent = "stop & finish file";
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
        stretch: !!opts.stretch,
        motionBlur: mb.enable.checked
          ? {
              ...mbSettings(),
              gpuThreads: parseInt(gpuSelect.value) || 0,
              maskPng: getExportMask(),
            }
          : null,
      },
    });
    let copied = false;
    let clipboardFailed = false;
    if (document.getElementById("export-copy").checked) {
      try {
        await invoke("copy_file_to_clipboard", { path: outPath });
        copied = true;
        emit("status", "exported video copied to clipboard");
      } catch (err) {
        clipboardFailed = true;
        console.error("copy exported video to clipboard failed:", err);
        emit("status", "exported video, but clipboard copy failed");
      }
    }
    fill.style.width = "100%";
    pctEl.textContent = "100%";
    framesEl.textContent = finishEarlyRequested ? "partial file finished" : "done";
    etaEl.textContent = "";
    exportStateTitle.textContent = finishEarlyRequested ? "partial export complete" : "export complete";
    const parts = [
      finishEarlyRequested
        ? "render was stopped - completed portion saved."
        : "exported successfully.",
    ];
    if (copied) parts.push("video was copied to your clipboard.");
    else if (clipboardFailed) parts.push("file saved, but it could not be copied to the clipboard.");
    exportResultMessage.textContent = parts.join(" ");
    exportResultMessage.hidden = false;
    exportStageEl.hidden = true;
    activeExportActions.hidden = true;
    completeExportActions.hidden = false;
  } catch (err) {
    progressOverlay.hidden = true;
    if (String(err) !== "cancelled") {
      console.error("export failed:", err);
      await messageBox(`export failed:\n${err}`);
    }
  } finally {
    state.exporting = false;
    previewBox.style.visibility = "";
    if (!state.playing) player.drawAtTime(state.time);
  }
}

document.getElementById("cancel-export").addEventListener("click", () => {
  framesEl.textContent = "cancelling...";
  invoke("cancel_export").catch(() => {});
});

document.getElementById("finish-export").addEventListener("click", () => {
  finishEarlyRequested = true;
  framesEl.textContent = "stopping and finalizing file...";
  etaEl.textContent = "";
  const button = document.getElementById("finish-export");
  button.disabled = true;
  button.textContent = "finishing...";
  invoke("finish_export").catch(() => {});
});

document.getElementById("open-export-folder").addEventListener("click", () => {
  if (!lastExportPath) return;
  revealInFolder(lastExportPath).catch((err) => {
    console.error("reveal export:", err);
    emit("status", "could not open the exported file's location");
  });
});

document.getElementById("close-export-result").addEventListener("click", () => {
  progressOverlay.hidden = true;
});

// -------------------- progress events --------------------

listen("export-progress", (event) => {
  const p = event.payload;
  const pct = Math.round((p.percent || 0) * 100);
  fill.style.width = `${pct}%`;
  pctEl.textContent = `${pct}%`;
  const speed = p.speed && p.speed !== "N/A" ? ` · ${p.speed}` : "";
  framesEl.textContent = `frame ${p.currentFrame || 0} / ${p.totalFrames || 0}${speed}`;
  const eta = Math.max(0, Math.round(p.etaSeconds || 0));
  etaEl.textContent = eta > 0 ? `eta ${Math.floor(eta / 60)}:${String(eta % 60).padStart(2, "0")}` : "eta --:--";
  if (p.stage) exportStageEl.textContent = p.stage;

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
