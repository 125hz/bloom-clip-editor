// maskeditor.js - paint a mask over a preview frame; painted (white) areas
// are protected from motion blur at export. Masks persist in localStorage so
// they can be reused across projects (HUD layouts rarely change per game).

import { emit } from "./state.js";

const MASK_W = 1280;
const MASK_H = 720;
const STORE_KEY = "bloom-blur-masks";

const modal = document.getElementById("mask-modal");
const display = document.getElementById("mask-canvas");
const dctx = display.getContext("2d");
const brushEl = document.getElementById("mask-brush");
const brushVal = document.getElementById("mask-brush-val");
const featherEl = document.getElementById("mask-feather");
const featherVal = document.getElementById("mask-feather-val");
const paintBtn = document.getElementById("mask-paint");
const eraseBtn = document.getElementById("mask-erase");
const statusEl = document.getElementById("mb-mask-status");
const presetSelect = document.getElementById("mask-preset-select");
const presetName = document.getElementById("mask-preset-name");

// frame snapshot behind the mask (not part of the mask itself)
const bg = document.createElement("canvas");
bg.width = MASK_W;
bg.height = MASK_H;
// white strokes on transparent — the actual mask
const ink = document.createElement("canvas");
ink.width = MASK_W;
ink.height = MASK_H;
const inkCtx = ink.getContext("2d");
// red visualization of the ink for the editor
const tint = document.createElement("canvas");
tint.width = MASK_W;
tint.height = MASK_H;
const tintCtx = tint.getContext("2d");

let hasInk = false;
let erasing = false;
let drawing = false;
let last = null;

function store() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || { masks: {}, current: null };
  } catch {
    return { masks: {}, current: null };
  }
}

function saveStore(s) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {}
}

function featherPx() {
  return Math.max(0, parseFloat(featherEl.value) || 0);
}

function refreshStatus() {
  statusEl.textContent = hasInk ? "active" : "none";
  statusEl.classList.toggle("on", hasInk);
}

function refreshPresets(selected = "") {
  presetSelect.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "(unsaved mask)";
  presetSelect.appendChild(none);
  for (const name of Object.keys(store().masks).sort()) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    presetSelect.appendChild(opt);
  }
  presetSelect.value = selected;
}

function render() {
  dctx.clearRect(0, 0, MASK_W, MASK_H);
  dctx.drawImage(bg, 0, 0);
  // red preview of the protected area, feathered like the export mask
  tintCtx.clearRect(0, 0, MASK_W, MASK_H);
  tintCtx.filter = featherPx() > 0 ? `blur(${featherPx()}px)` : "none";
  tintCtx.drawImage(ink, 0, 0);
  tintCtx.filter = "none";
  tintCtx.globalCompositeOperation = "source-in";
  tintCtx.fillStyle = "#ff2d2d";
  tintCtx.fillRect(0, 0, MASK_W, MASK_H);
  tintCtx.globalCompositeOperation = "source-over";
  dctx.globalAlpha = 0.45;
  dctx.drawImage(tint, 0, 0);
  dctx.globalAlpha = 1;
}

function loadInk(dataUrl, feather) {
  inkCtx.clearRect(0, 0, MASK_W, MASK_H);
  hasInk = false;
  if (feather !== undefined && feather !== null) featherEl.value = feather;
  featherVal.textContent = featherEl.value;
  if (!dataUrl) {
    refreshStatus();
    render();
    return;
  }
  const img = new Image();
  img.onload = () => {
    inkCtx.drawImage(img, 0, 0, MASK_W, MASK_H);
    hasInk = true;
    refreshStatus();
    render();
  };
  img.src = dataUrl;
}

function persistCurrent() {
  const s = store();
  s.current = hasInk
    ? { data: ink.toDataURL("image/png"), feather: featherPx() }
    : null;
  saveStore(s);
}

/// after erasing, check whether any ink is actually left
function recheckInk() {
  const d = inkCtx.getImageData(0, 0, MASK_W, MASK_H).data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] > 8) {
      hasInk = true;
      return;
    }
  }
  hasInk = false;
}

function pos(e) {
  const r = display.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * MASK_W,
    y: ((e.clientY - r.top) / r.height) * MASK_H,
  };
}

function strokeTo(p) {
  inkCtx.lineCap = "round";
  inkCtx.lineJoin = "round";
  inkCtx.lineWidth = parseFloat(brushEl.value) || 40;
  inkCtx.strokeStyle = "#ffffff";
  inkCtx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
  inkCtx.beginPath();
  inkCtx.moveTo(last.x, last.y);
  inkCtx.lineTo(p.x + 0.01, p.y + 0.01);
  inkCtx.stroke();
  inkCtx.globalCompositeOperation = "source-over";
  last = p;
  if (!erasing) hasInk = true;
  render();
}

display.addEventListener("pointerdown", (e) => {
  drawing = true;
  display.setPointerCapture(e.pointerId);
  last = pos(e);
  strokeTo(pos(e)); // a single click paints a dot
});
display.addEventListener("pointermove", (e) => {
  if (drawing) strokeTo(pos(e));
});
display.addEventListener("pointerup", () => {
  if (drawing && erasing) recheckInk();
  drawing = false;
  refreshStatus();
});

function setErasing(v) {
  erasing = v;
  paintBtn.classList.toggle("active", !v);
  eraseBtn.classList.toggle("active", v);
}
paintBtn.addEventListener("click", () => setErasing(false));
eraseBtn.addEventListener("click", () => setErasing(true));

document.getElementById("mask-clear").addEventListener("click", () => {
  inkCtx.clearRect(0, 0, MASK_W, MASK_H);
  hasInk = false;
  refreshStatus();
  render();
});

brushEl.addEventListener("input", () => (brushVal.textContent = brushEl.value));
featherEl.addEventListener("input", () => {
  featherVal.textContent = featherEl.value;
  render();
});

document.getElementById("mask-preset-save").addEventListener("click", () => {
  const name = presetName.value.trim();
  if (!name) {
    emit("status", "enter a mask name first");
    return;
  }
  if (!hasInk) {
    emit("status", "paint a mask before saving");
    return;
  }
  const s = store();
  s.masks[name] = { data: ink.toDataURL("image/png"), feather: featherPx() };
  saveStore(s);
  presetName.value = "";
  refreshPresets(name);
  emit("status", `saved blur mask "${name}"`);
});

document.getElementById("mask-preset-delete").addEventListener("click", () => {
  const name = presetSelect.value;
  if (!name) return;
  const s = store();
  delete s.masks[name];
  saveStore(s);
  refreshPresets();
  emit("status", `deleted blur mask "${name}"`);
});

presetSelect.addEventListener("change", () => {
  const preset = store().masks[presetSelect.value];
  if (preset) loadInk(preset.data, preset.feather);
});

function closeEditor() {
  persistCurrent();
  refreshStatus();
  modal.hidden = true;
  emit("status", hasInk ? "blur mask active" : "no blur mask set");
}

document.getElementById("mask-apply").addEventListener("click", closeEditor);
document.getElementById("mask-close").addEventListener("click", closeEditor);
modal.addEventListener("mousedown", (e) => {
  if (e.target === modal) closeEditor();
});

document.getElementById("mask-remove").addEventListener("click", () => {
  inkCtx.clearRect(0, 0, MASK_W, MASK_H);
  hasInk = false;
  persistCurrent();
  refreshStatus();
  render();
});

/// open the editor over a snapshot of the current preview frame
export function openMaskEditor(sourceCanvas) {
  const bctx = bg.getContext("2d");
  bctx.fillStyle = "#000";
  bctx.fillRect(0, 0, MASK_W, MASK_H);
  if (sourceCanvas && sourceCanvas.width > 1) {
    const s = Math.min(MASK_W / sourceCanvas.width, MASK_H / sourceCanvas.height);
    const dw = sourceCanvas.width * s;
    const dh = sourceCanvas.height * s;
    bctx.drawImage(sourceCanvas, (MASK_W - dw) / 2, (MASK_H - dh) / 2, dw, dh);
  }
  render();
  modal.hidden = false;
}

/// grayscale export mask (white = keep sharp), feather baked in.
/// Returns raw base64 PNG or null when no mask is painted.
export function getExportMask() {
  if (!hasInk) return null;
  const out = document.createElement("canvas");
  out.width = MASK_W;
  out.height = MASK_H;
  const c = out.getContext("2d");
  c.fillStyle = "#000";
  c.fillRect(0, 0, MASK_W, MASK_H);
  if (featherPx() > 0) c.filter = `blur(${featherPx()}px)`;
  c.drawImage(ink, 0, 0);
  c.filter = "none";
  return out.toDataURL("image/png").split(",")[1];
}

// restore the mask that was active last session
{
  const s = store();
  refreshPresets();
  if (s.current) loadInk(s.current.data, s.current.feather);
  else refreshStatus();
}
