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
  gap: document.getElementById("txt-gap"),
  gapVal: document.getElementById("txt-gap-val"),
  shadowColor: document.getElementById("txt-shadow-color"),
  shadowX: document.getElementById("txt-shadow-x"),
  shadowXVal: document.getElementById("txt-shadow-x-val"),
  shadowY: document.getElementById("txt-shadow-y"),
  shadowYVal: document.getElementById("txt-shadow-y-val"),
  shadowOp: document.getElementById("txt-shadow-op"),
  shadowOpVal: document.getElementById("txt-shadow-op-val"),
  shadowBlur: document.getElementById("txt-shadow-blur"),
  shadowBlurVal: document.getElementById("txt-shadow-blur-val"),
  x: document.getElementById("txt-x"),
  xVal: document.getElementById("txt-x-val"),
  y: document.getElementById("txt-y"),
  yVal: document.getElementById("txt-y-val"),
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
    speed: 1,
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
      gap: 0,
      shadowColor: "#000000",
      shadowX: 0,
      shadowY: 0,
      shadowOpacity: 1,
      shadowBlur: 0,
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
  els.gap.value = t.gap || 0;
  els.gapVal.textContent = `${Math.round((t.gap || 0) * 1080)}px`;
  els.shadowColor.value = t.shadowColor || "#000000";
  els.shadowX.value = t.shadowX || 0;
  els.shadowXVal.textContent = `${Math.round((t.shadowX || 0) * 1080)}px`;
  els.shadowY.value = t.shadowY || 0;
  els.shadowYVal.textContent = `${Math.round((t.shadowY || 0) * 1080)}px`;
  els.shadowOp.value = t.shadowOpacity ?? 1;
  els.shadowOpVal.textContent = `${Math.round((t.shadowOpacity ?? 1) * 100)}%`;
  els.shadowBlur.value = t.shadowBlur || 0;
  els.shadowBlurVal.textContent = `${Math.round((t.shadowBlur || 0) * 1080)}px`;
  els.x.value = t.x;
  els.xVal.textContent = `${Math.round(t.x * 100)}%`;
  els.y.value = t.y;
  els.yVal.textContent = `${Math.round(t.y * 100)}%`;
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
// enter confirms, shift+enter inserts a new line
els.content.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.content.blur();
  }
});
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
els.gap.addEventListener("input", () =>
  applyEdit((t) => {
    t.gap = parseFloat(els.gap.value);
    els.gapVal.textContent = `${Math.round(t.gap * 1080)}px`;
  })
);
els.shadowColor.addEventListener("input", () =>
  applyEdit((t) => (t.shadowColor = els.shadowColor.value))
);
els.shadowX.addEventListener("input", () =>
  applyEdit((t) => {
    t.shadowX = parseFloat(els.shadowX.value);
    els.shadowXVal.textContent = `${Math.round(t.shadowX * 1080)}px`;
  })
);
els.shadowY.addEventListener("input", () =>
  applyEdit((t) => {
    t.shadowY = parseFloat(els.shadowY.value);
    els.shadowYVal.textContent = `${Math.round(t.shadowY * 1080)}px`;
  })
);
els.shadowOp.addEventListener("input", () =>
  applyEdit((t) => {
    t.shadowOpacity = parseFloat(els.shadowOp.value);
    els.shadowOpVal.textContent = `${Math.round(t.shadowOpacity * 100)}%`;
  })
);
els.shadowBlur.addEventListener("input", () =>
  applyEdit((t) => {
    t.shadowBlur = parseFloat(els.shadowBlur.value);
    els.shadowBlurVal.textContent = `${Math.round(t.shadowBlur * 1080)}px`;
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

function textClipAtPoint(e) {
  const { w: W, h: H } = player.canvasSize();
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * W;
  const py = ((e.clientY - rect.top) / rect.height) * H;

  // topmost text first
  const texts = player.activeTextClips(state.time).reverse();
  for (const c of texts) {
    const m = player.textBlockMetrics(c, W, H);
    const pad = 8;
    if (px >= m.x - pad && px <= m.x + m.w + pad && py >= m.y - pad && py <= m.y + m.h + pad) {
      return c;
    }
  }
  return null;
}

canvas.addEventListener("mousedown", (e) => {
  if (state.playing || state.exporting) return;
  const hit = textClipAtPoint(e);
  if (!hit) return;

  e.preventDefault();
  setSelected(hit.id);
  const rect = canvas.getBoundingClientRect();
  const t0 = { x: hit.text.x, y: hit.text.y };
  const startX = e.clientX;
  const startY = e.clientY;
  let pushed = false; // history only once an actual drag happens

  const move = (ev) => {
    if (!pushed) {
      pushed = true;
      pushHistory();
    }
    hit.text.x = clamp(t0.x + (ev.clientX - startX) / rect.width, 0, 1);
    hit.text.y = clamp(t0.y + (ev.clientY - startY) / rect.height, 0, 1);
    if (activeClip === hit) syncPanel(hit);
    player.draw(state.time);
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (pushed) emit("project-changed");
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

// -------------------- double-click text on preview to type --------------------

let inlineEditor = null;

function closeInlineEditor(commit = true) {
  if (!inlineEditor) return;
  const { el, clip } = inlineEditor;
  inlineEditor = null;
  if (commit && clip.text) {
    clip.text.content = el.innerText.replace(/\r/g, "").replace(/\n$/, "");
    if (activeClip === clip) syncPanel(clip);
  }
  el.remove();
  player.setEditingText(null);
  emit("project-changed");
}

function beginInlineEdit(clip) {
  closeInlineEditor(true);
  pushHistory();

  const rect = canvas.getBoundingClientRect();
  const { h: H } = player.canvasSize();
  const s = clip.text;

  const el = document.createElement("div");
  el.id = "text-inline-editor";
  try {
    el.contentEditable = "plaintext-only";
  } catch {
    el.contentEditable = "true";
  }
  el.spellcheck = false;
  el.innerText = s.content;
  el.style.left = `${s.x * 100}%`;
  el.style.top = `${s.y * 100}%`;
  el.style.fontSize = `${s.size * H * (rect.height / H)}px`;
  el.style.fontFamily = player.fontCss(s.font);
  el.style.fontWeight = s.bold ? "bold" : "normal";
  el.style.color = s.color || "#ffffff";
  if (s.outlineWidth > 0) {
    // approximation of the canvas stroke while typing
    el.style.webkitTextStroke = `${Math.max(1, s.outlineWidth * rect.height)}px ${s.outlineColor || "#000000"}`;
  }
  if (s.gap > 0) el.style.letterSpacing = `${s.gap * rect.height}px`;
  if (player.hasTextShadow(s)) {
    el.style.textShadow = `${(s.shadowX || 0) * rect.height}px ${(s.shadowY || 0) * rect.height}px ${(s.shadowBlur || 0) * rect.height}px ${player.rgbaFromHex(s.shadowColor, s.shadowOpacity ?? 1)}`;
  }

  el.addEventListener("input", () => {
    if (!inlineEditor) return;
    s.content = el.innerText.replace(/\r/g, "").replace(/\n$/, "");
    if (activeClip === clip) syncPanel(clip);
    requestRender(); // timeline label
  });
  el.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape" || (ev.key === "Enter" && !ev.shiftKey)) {
      // enter confirms (shift+enter inserts a new line), escape confirms too
      ev.preventDefault();
      el.blur();
    }
  });
  el.addEventListener("mousedown", (ev) => ev.stopPropagation());
  el.addEventListener("blur", () => closeInlineEditor(true));

  document.getElementById("preview-box").appendChild(el);
  inlineEditor = { el, clip };
  player.setEditingText(clip.id);

  // focus with everything selected, ready to overtype
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

canvas.addEventListener("dblclick", (e) => {
  if (state.playing || state.exporting) return;
  const hit = textClipAtPoint(e);
  if (!hit) return;
  e.preventDefault();
  setSelected(hit.id);
  beginInlineEdit(hit);
});

// keep the editor out of the way when playback starts or the clip vanishes
on("playstate", (playing) => {
  if (playing) closeInlineEditor(true);
});
on("project-changed", () => {
  if (inlineEditor && !clipById(inlineEditor.clip.id)) closeInlineEditor(false);
});
