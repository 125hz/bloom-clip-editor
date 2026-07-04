// textpanel.js - text clip creation, the properties side panel, and
// drag-to-position on the preview canvas.

import {
  state,
  emit,
  on,
  clipById,
  ensureTrack,
  setSelected,
  pushHistory,
} from "./state.js";
import { allowedStart } from "./interactions.js";
import * as player from "./player.js";
import { requestRender } from "./timeline.js";
import { uid } from "./utils.js";
import { clamp } from "./utils.js";

const panel = document.getElementById("text-panel");
const els = {
  content: document.getElementById("txt-content"),
  font: document.getElementById("txt-font"),
  bold: document.getElementById("txt-bold"),
  size: document.getElementById("txt-size"),
  sizeVal: document.getElementById("txt-size-val"),
  color: document.getElementById("txt-color"),
  outlineColor: document.getElementById("txt-outline-color"),
  outline: document.getElementById("txt-outline"),
  outlineVal: document.getElementById("txt-outline-val"),
  x: document.getElementById("txt-x"),
  xVal: document.getElementById("txt-x-val"),
  y: document.getElementById("txt-y"),
  yVal: document.getElementById("txt-y-val"),
  fadeIn: document.getElementById("txt-fadein"),
  fadeInVal: document.getElementById("txt-fadein-val"),
  fadeOut: document.getElementById("txt-fadeout"),
  fadeOutVal: document.getElementById("txt-fadeout-val"),
};

let activeClip = null;
let syncing = false;

export function addTextClip() {
  pushHistory();
  const track = ensureTrack("text");
  const duration = 3;
  const startTime = allowedStart(track.id, duration, state.time, null);
  const clip = {
    id: uid(),
    kind: "text",
    trackId: track.id,
    filePath: "",
    fileUrl: "",
    startTime,
    inPoint: 0,
    duration,
    sourceDuration: Infinity,
    fps: 60,
    fadeIn: 0,
    fadeOut: 0,
    audioTracks: [],
    thumbnailUrl: null,
    text: {
      content: "text",
      font: "consolas",
      bold: false,
      size: 0.07,
      color: "#ffffff",
      outlineColor: "#000000",
      outlineWidth: 0.004,
      x: 0.5,
      y: 0.5,
    },
  };
  state.clips.push(clip);
  setSelected(clip.id);
  emit("project-changed");
  if (!state.playing) player.seekPreview(clip.startTime <= state.time ? state.time : clip.startTime);
  return clip;
}

function syncPanel(clip) {
  syncing = true;
  const t = clip.text;
  els.content.value = t.content;
  els.font.value = t.font;
  els.bold.checked = !!t.bold;
  els.size.value = t.size;
  els.sizeVal.textContent = `${Math.round(t.size * 1080)}px`;
  els.color.value = t.color;
  els.outlineColor.value = t.outlineColor;
  els.outline.value = t.outlineWidth;
  els.outlineVal.textContent = `${Math.round(t.outlineWidth * 1080)}px`;
  els.x.value = t.x;
  els.xVal.textContent = `${Math.round(t.x * 100)}%`;
  els.y.value = t.y;
  els.yVal.textContent = `${Math.round(t.y * 100)}%`;
  els.fadeIn.value = clip.fadeIn || 0;
  els.fadeInVal.textContent = `${(clip.fadeIn || 0).toFixed(2)}s`;
  els.fadeOut.value = clip.fadeOut || 0;
  els.fadeOutVal.textContent = `${(clip.fadeOut || 0).toFixed(2)}s`;
  syncing = false;
}

function applyEdit(fn, structural = false) {
  if (syncing || !activeClip?.text) return;
  fn(activeClip.text);
  if (structural) requestRender();
  else {
    // cheap: only the timeline label may change
    requestRender();
  }
  if (!state.playing) player.draw(state.time);
}

els.content.addEventListener("input", () => applyEdit((t) => (t.content = els.content.value), true));
els.font.addEventListener("change", () => applyEdit((t) => (t.font = els.font.value)));
els.bold.addEventListener("change", () => applyEdit((t) => (t.bold = els.bold.checked)));
els.size.addEventListener("input", () =>
  applyEdit((t) => {
    t.size = parseFloat(els.size.value);
    els.sizeVal.textContent = `${Math.round(t.size * 1080)}px`;
  })
);
els.color.addEventListener("input", () => applyEdit((t) => (t.color = els.color.value)));
els.outlineColor.addEventListener("input", () =>
  applyEdit((t) => (t.outlineColor = els.outlineColor.value))
);
els.outline.addEventListener("input", () =>
  applyEdit((t) => {
    t.outlineWidth = parseFloat(els.outline.value);
    els.outlineVal.textContent = `${Math.round(t.outlineWidth * 1080)}px`;
  })
);
els.x.addEventListener("input", () =>
  applyEdit((t) => {
    t.x = parseFloat(els.x.value);
    els.xVal.textContent = `${Math.round(t.x * 100)}%`;
  })
);
els.y.addEventListener("input", () =>
  applyEdit((t) => {
    t.y = parseFloat(els.y.value);
    els.yVal.textContent = `${Math.round(t.y * 100)}%`;
  })
);

// fades live on the clip itself (like video clips), not on clip.text
function applyFade(which, value) {
  if (syncing || !activeClip) return;
  const other = which === "fadeIn" ? activeClip.fadeOut || 0 : activeClip.fadeIn || 0;
  const max = Math.max(0, activeClip.duration - other - 0.05);
  activeClip[which] = clamp(value, 0, max);
  syncPanel(activeClip);
  requestRender();
  if (!state.playing) player.draw(state.time);
}
els.fadeIn.addEventListener("input", () => applyFade("fadeIn", parseFloat(els.fadeIn.value)));
els.fadeOut.addEventListener("input", () => applyFade("fadeOut", parseFloat(els.fadeOut.value)));

on("selection-changed", (id) => {
  const clip = clipById(id);
  if (clip?.kind === "text") {
    activeClip = clip;
    syncPanel(clip);
    panel.hidden = false;
  } else {
    activeClip = null;
    panel.hidden = true;
  }
});

on("project-changed", () => {
  // selection may point at a restored clip object after undo
  const clip = clipById(state.selectedId);
  if (clip?.kind === "text") {
    activeClip = clip;
    syncPanel(clip);
    panel.hidden = false;
  } else if (activeClip && !clipById(activeClip.id)) {
    activeClip = null;
    panel.hidden = true;
  }
});

// -------------------- drag text on preview --------------------

const canvas = player.previewCanvas();

canvas.addEventListener("mousedown", (e) => {
  if (state.playing || state.exporting) return;
  const { w: W, h: H } = player.canvasSize();
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * W;
  const py = ((e.clientY - rect.top) / rect.height) * H;

  // topmost text first
  const texts = player.activeTextClips(state.time).reverse();
  let hit = null;
  for (const c of texts) {
    const m = player.textBlockMetrics(c, W, H);
    const pad = 8;
    if (px >= m.x - pad && px <= m.x + m.w + pad && py >= m.y - pad && py <= m.y + m.h + pad) {
      hit = c;
      break;
    }
  }
  if (!hit) return;

  e.preventDefault();
  setSelected(hit.id);
  pushHistory();
  const t0 = { x: hit.text.x, y: hit.text.y };
  const startX = e.clientX;
  const startY = e.clientY;

  const move = (ev) => {
    hit.text.x = clamp(t0.x + (ev.clientX - startX) / rect.width, 0, 1);
    hit.text.y = clamp(t0.y + (ev.clientY - startY) / rect.height, 0, 1);
    if (activeClip === hit) syncPanel(hit);
    player.draw(state.time);
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    emit("project-changed");
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});
