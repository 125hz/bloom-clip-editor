// clippanel.js - video clip inspector: crop/zoom + pan, and drag-to-pan
// on the preview canvas when zoomed in.

import { state, on, emit, clipById, pushHistory } from "./state.js";
import * as player from "./player.js";
import { clamp } from "./utils.js";

const panel = document.getElementById("clip-panel");
const els = {
  zoom: document.getElementById("crop-zoom"),
  zoomVal: document.getElementById("crop-zoom-val"),
  x: document.getElementById("crop-x"),
  xVal: document.getElementById("crop-x-val"),
  y: document.getElementById("crop-y"),
  yVal: document.getElementById("crop-y-val"),
  reset: document.getElementById("crop-reset"),
};

let activeClip = null;
let syncing = false;

function ensureCrop(clip) {
  if (!clip.crop) clip.crop = { zoom: 1, cx: 0.5, cy: 0.5 };
  return clip.crop;
}

function syncPanel(clip) {
  syncing = true;
  const cr = ensureCrop(clip);
  els.zoom.value = cr.zoom;
  els.zoomVal.textContent = `${cr.zoom.toFixed(2)}x`;
  els.x.value = cr.cx;
  els.xVal.textContent = `${Math.round(cr.cx * 100)}%`;
  els.y.value = cr.cy;
  els.yVal.textContent = `${Math.round(cr.cy * 100)}%`;
  syncing = false;
}

function applyEdit(fn) {
  if (syncing || !activeClip) return;
  fn(ensureCrop(activeClip));
  syncPanel(activeClip);
  if (!state.playing) player.draw(state.time);
}

els.zoom.addEventListener("input", () =>
  applyEdit((cr) => (cr.zoom = clamp(parseFloat(els.zoom.value), 1, 4)))
);
els.x.addEventListener("input", () =>
  applyEdit((cr) => (cr.cx = clamp(parseFloat(els.x.value), 0, 1)))
);
els.y.addEventListener("input", () =>
  applyEdit((cr) => (cr.cy = clamp(parseFloat(els.y.value), 0, 1)))
);
els.reset.addEventListener("click", () =>
  applyEdit((cr) => {
    cr.zoom = 1;
    cr.cx = 0.5;
    cr.cy = 0.5;
  })
);

function refresh() {
  const clip = clipById(state.selectedId);
  if (clip?.kind === "video") {
    activeClip = clip;
    syncPanel(clip);
    panel.hidden = false;
  } else {
    activeClip = null;
    panel.hidden = true;
  }
}

on("selection-changed", refresh);
on("project-changed", refresh);

// -------------------- drag preview to pan (when zoomed) --------------------

const canvas = player.previewCanvas();

canvas.addEventListener("mousedown", (e) => {
  if (state.playing || state.exporting) return;
  if (!activeClip) return;
  const cr = activeClip.crop;
  if (!cr || cr.zoom <= 1.001) return;
  // only pan when the selected clip is actually visible at the playhead
  if (state.time < activeClip.startTime || state.time >= activeClip.startTime + activeClip.duration) return;
  // text dragging takes priority; textpanel's handler calls preventDefault on hits
  if (e.defaultPrevented) return;

  e.preventDefault();
  pushHistory();
  const rect = canvas.getBoundingClientRect();
  const c0 = { cx: cr.cx, cy: cr.cy };
  const startX = e.clientX;
  const startY = e.clientY;

  const move = (ev) => {
    // dragging moves the content with the mouse -> pan opposite
    cr.cx = clamp(c0.cx - (ev.clientX - startX) / rect.width / cr.zoom, 0, 1);
    cr.cy = clamp(c0.cy - (ev.clientY - startY) / rect.height / cr.zoom, 0, 1);
    syncPanel(activeClip);
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
