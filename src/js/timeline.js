// timeline.js - timeline rendering: canvas ruler, track rows, clips,
// waveforms (sliced from precomputed source peaks), playhead.
//
// Zoom is anchored on the playhead; the ruler is a canvas drawn against the
// current scroll position so labels are always exact.

import {
  state,
  emit,
  contentEnd,
  clipsInTrack,
  removeTrack,
} from "./state.js";
import { getAudioEntry, PEAKS_PER_SEC } from "./media.js";
import { clamp, basename, formatTime, formatTimeShort } from "./utils.js";

export const rulerCanvas = document.getElementById("ruler-canvas");
export const tlScroll = document.getElementById("tl-scroll");
export const tlContent = document.getElementById("tl-content");
const playheadEl = document.getElementById("playhead");
const ghostEl = document.getElementById("ghost-playhead");
const loopEl = document.getElementById("loop-region");
const timeDisplay = document.getElementById("time-display");
const rulerCtx = rulerCanvas.getContext("2d");

const MIN_PPS = 2;
const MAX_PPS = 400;
// max backing width per waveform canvas; wider clips render only the
// visible window at full resolution (repositioned on scroll/zoom)
const WAVE_CANVAS_MAX = 4096;
const WAVE_WINDOW_MARGIN = 300;

const trackEls = new Map(); // trackId -> row element
const clipEls = new Map(); // clipId -> element

export function viewEnd() {
  const viewSeconds = tlScroll.clientWidth / state.pps;
  return Math.max(contentEnd() + 10, viewSeconds);
}

export function timeAtClientX(clientX) {
  const rect = tlScroll.getBoundingClientRect();
  const x = clientX - rect.left + tlScroll.scrollLeft;
  return clamp(x / state.pps, 0, viewEnd());
}

// -------------------- ruler --------------------

const TICK_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function renderRuler() {
  const dpr = window.devicePixelRatio || 1;
  const w = rulerCanvas.clientWidth;
  const h = 26;
  if (rulerCanvas.width !== Math.round(w * dpr)) rulerCanvas.width = Math.round(w * dpr);
  if (rulerCanvas.height !== Math.round(h * dpr)) rulerCanvas.height = Math.round(h * dpr);

  const c = rulerCtx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.fillStyle = "#000";
  c.fillRect(0, 0, w, h);

  const pps = state.pps;
  const scroll = tlScroll.scrollLeft;
  const t0 = scroll / pps;
  const t1 = (scroll + w) / pps;

  let step = TICK_STEPS[TICK_STEPS.length - 1];
  for (const s of TICK_STEPS) {
    if (s * pps >= 68) {
      step = s;
      break;
    }
  }
  const minor = step / 5;
  const drawMinor = minor * pps >= 5;

  c.strokeStyle = "#333";
  c.beginPath();
  if (drawMinor) {
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(t * pps - scroll) + 0.5;
      c.moveTo(x, h - 5);
      c.lineTo(x, h);
    }
  }
  c.stroke();

  c.strokeStyle = "#555";
  c.fillStyle = "#888";
  c.font = "10px Consolas, monospace";
  c.textBaseline = "top";
  c.beginPath();
  for (let t = Math.floor(t0 / step) * step; t <= t1 + 1e-9; t += step) {
    const tt = Math.round(t / minor) * minor; // kill float drift
    const x = Math.round(tt * pps - scroll) + 0.5;
    c.moveTo(x, h - 10);
    c.lineTo(x, h);
    c.fillText(step < 1 ? formatTimeShort(tt) : formatTimeShort(Math.round(tt)), x + 3, 3);
  }
  c.stroke();

  // loop region shading on ruler
  if (state.loop) {
    const x0 = state.loop.start * pps - scroll;
    const x1 = state.loop.end * pps - scroll;
    c.fillStyle = "rgba(255,255,255,0.15)";
    c.fillRect(x0, 0, x1 - x0, h);
  }

  // playhead marker on ruler
  const px = state.time * pps - scroll;
  if (px >= 0 && px <= w) {
    c.fillStyle = "#fff";
    c.fillRect(Math.round(px), 0, 1, h);
    c.beginPath();
    c.moveTo(px - 4, 0);
    c.lineTo(px + 4, 0);
    c.lineTo(px, 6);
    c.fill();
  }
}

// -------------------- playhead / time display --------------------

export function updatePlayhead() {
  const x = state.time * state.pps;
  playheadEl.style.transform = `translateX(${x}px)`;
  ghostEl.style.transform = `translateX(${state.anchorTime * state.pps}px)`;
  updateLoopRegion();
  timeDisplay.innerHTML = `${formatTime(state.time)} <span class="total">/ ${formatTime(contentEnd())}</span>`;
  renderRuler();
}

export function updateLoopRegion() {
  if (state.loop) {
    loopEl.hidden = false;
    loopEl.style.left = `${state.loop.start * state.pps}px`;
    loopEl.style.width = `${(state.loop.end - state.loop.start) * state.pps}px`;
  } else {
    loopEl.hidden = true;
  }
}

export function applyTrackScale() {
  tlContent.style.setProperty("--ts", String(state.settings.trackScale || 1));
}

export function followPlayhead() {
  const x = state.time * state.pps;
  const left = tlScroll.scrollLeft;
  const w = tlScroll.clientWidth;
  if (x < left + 30) tlScroll.scrollLeft = Math.max(0, x - 30);
  else if (x > left + w - 60) tlScroll.scrollLeft = x - w + 60;
}

// -------------------- zoom (anchored on playhead) --------------------

export function zoom(factor) {
  const oldPps = state.pps;
  const newPps = clamp(oldPps * factor, MIN_PPS, MAX_PPS);
  if (Math.abs(newPps - oldPps) < 1e-6) return;

  const anchor = state.time;
  const viewX = anchor * oldPps - tlScroll.scrollLeft;
  state.pps = newPps;

  renderClips();

  let newScroll;
  if (viewX >= 0 && viewX <= tlScroll.clientWidth) {
    newScroll = anchor * newPps - viewX; // keep playhead at same screen position
  } else {
    newScroll = anchor * newPps - tlScroll.clientWidth / 2; // center on playhead
  }
  tlScroll.scrollLeft = Math.max(0, newScroll);
  updatePlayhead();
}

// -------------------- track rows --------------------

export function renderTracks() {
  // remove stale rows
  const liveTracks = new Set(state.tracks.map((t) => t.id));
  for (const [id, el] of trackEls) {
    if (!liveTracks.has(id)) {
      el.remove();
      trackEls.delete(id);
    }
  }

  let prev = null;
  for (const track of state.tracks) {
    let row = trackEls.get(track.id);
    if (!row) {
      row = document.createElement("div");
      row.className = `track-row kind-${track.kind}`;
      row.dataset.trackId = track.id;
      row.dataset.kind = track.kind;

      const label = document.createElement("div");
      label.className = "track-label";
      label.innerHTML = `<span class="track-name"></span><span class="track-del" title="remove track">x</span>`;
      label.querySelector(".track-del").addEventListener("click", (e) => {
        e.stopPropagation();
        if (!removeTrack(track.id)) emit("status", "track not empty");
      });
      row.appendChild(label);
      trackEls.set(track.id, row);
    }
    row.querySelector(".track-name").textContent = track.name;
    // keep DOM order in sync with state.tracks
    if (prev) prev.after(row);
    else tlContent.prepend(row);
    prev = row;
  }
}

// -------------------- clips --------------------

function buildClipEl(clip) {
  const el = document.createElement("div");
  el.className = `clip kind-${clip.kind}`;
  el.dataset.id = clip.id;

  const inner = document.createElement("div");
  inner.className = "clip-inner";
  el.appendChild(inner);

  if (clip.kind === "video") {
    const title = document.createElement("div");
    title.className = "clip-title";
    inner.appendChild(title);

    const thumbRow = document.createElement("div");
    thumbRow.className = "clip-thumb-row";
    const img = document.createElement("img");
    img.draggable = false;
    thumbRow.appendChild(img);
    // opacity adjustment line
    const opLine = document.createElement("div");
    opLine.className = "opacity-line";
    thumbRow.appendChild(opLine);
    const opHit = document.createElement("div");
    opHit.className = "opacity-hit";
    thumbRow.appendChild(opHit);
    const opTip = document.createElement("div");
    opTip.className = "opacity-tip";
    opTip.hidden = true;
    thumbRow.appendChild(opTip);
    inner.appendChild(thumbRow);

    const waves = document.createElement("div");
    waves.className = "clip-waves";
    inner.appendChild(waves);
  } else if (clip.kind === "audio") {
    const title = document.createElement("div");
    title.className = "clip-title";
    inner.appendChild(title);
    const waves = document.createElement("div");
    waves.className = "clip-waves";
    inner.appendChild(waves);
  } else if (clip.kind === "text") {
    const span = document.createElement("span");
    span.className = "text-preview";
    inner.appendChild(span);
  }

  if (clip.kind !== "text") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "fade-svg");
    svg.setAttribute("preserveAspectRatio", "none");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "fade-line");
    svg.appendChild(path);
    el.appendChild(svg);

    const fadeL = document.createElement("div");
    fadeL.className = "fade-handle left";
    const fadeR = document.createElement("div");
    fadeR.className = "fade-handle right";
    el.appendChild(fadeL);
    el.appendChild(fadeR);
  }

  const hl = document.createElement("div");
  hl.className = "handle left";
  const hr = document.createElement("div");
  hr.className = "handle right";
  el.appendChild(hl);
  el.appendChild(hr);

  return el;
}

function ensureWaveTracks(el, clip) {
  const waves = el.querySelector(".clip-waves");
  if (!waves) return [];
  const tracks = clip.audioTracks || [];
  while (waves.children.length > tracks.length) waves.lastChild.remove();
  while (waves.children.length < tracks.length) {
    const wt = document.createElement("div");
    wt.className = "wave-track";
    wt.dataset.order = String(waves.children.length);
    const cnv = document.createElement("canvas");
    wt.appendChild(cnv);
    const vol = document.createElement("div");
    vol.className = "vol-line";
    wt.appendChild(vol);
    const hit = document.createElement("div");
    hit.className = "vol-hit";
    wt.appendChild(hit);
    const tip = document.createElement("div");
    tip.className = "vol-tip";
    tip.hidden = true;
    wt.appendChild(tip);
    waves.appendChild(wt);
  }
  return [...waves.children];
}

/// Position + draw a waveform canvas. Clips wider than WAVE_CANVAS_MAX only
/// render the portion visible in the scroll viewport, at 1:1 pixel scale —
/// zooming in never stretches a low-res backing store.
function layoutWave(cnv, peaks, clip, clipWidthPx, heightPx) {
  let winStart = 0;
  let winW = clipWidthPx;

  if (clipWidthPx > WAVE_CANVAS_MAX) {
    const clipLeft = clip.startTime * state.pps;
    const viewL = tlScroll.scrollLeft - WAVE_WINDOW_MARGIN;
    const viewR = tlScroll.scrollLeft + tlScroll.clientWidth + WAVE_WINDOW_MARGIN;
    winStart = clamp(viewL - clipLeft, 0, clipWidthPx);
    winW = clamp(viewR - clipLeft, 0, clipWidthPx) - winStart;
    if (winW <= 1) {
      cnv.style.display = "none";
      return;
    }
    winW = Math.min(winW, WAVE_CANVAS_MAX);
  }

  cnv.style.display = "";
  cnv.style.left = `${winStart}px`;
  cnv.style.width = `${winW}px`;

  const inPoint = clip.inPoint + winStart / state.pps;
  const duration = winW / state.pps;

  const w = Math.max(2, Math.round(winW));
  const h = Math.max(2, Math.round(heightPx));
  const key = `${inPoint.toFixed(3)}|${duration.toFixed(3)}|${w}|${h}|${peaks ? peaks.length : 0}`;
  if (cnv._waveKey === key) return;
  cnv._waveKey = key;
  cnv.width = w;
  cnv.height = h;
  const c = cnv.getContext("2d");
  c.clearRect(0, 0, w, h);
  if (!peaks || !peaks.length) return;

  c.fillStyle = "rgba(255,255,255,0.75)";
  const i0 = inPoint * PEAKS_PER_SEC;
  const perPx = (duration * PEAKS_PER_SEC) / w;
  const bar = 2;
  for (let x = 0; x < w; x += bar) {
    const a = Math.floor(i0 + x * perPx);
    const b = Math.max(a + 1, Math.floor(i0 + (x + bar) * perPx));
    let v = 0;
    for (let i = a; i < b && i < peaks.length; i++) v = Math.max(v, peaks[i] || 0);
    const bh = Math.max(1, v * (h - 2));
    c.fillRect(x, (h - bh) / 2, bar - 1, bh);
  }
}

export function updateClipEl(clip) {
  const el = clipEls.get(clip.id);
  if (!el) return;
  const pps = state.pps;
  const width = Math.max(2, clip.duration * pps);
  el.style.left = `${clip.startTime * pps}px`;
  el.style.width = `${width}px`;
  el.classList.toggle("selected", clip.id === state.selectedId);

  if (clip.kind === "text") {
    el.querySelector(".text-preview").textContent = (clip.text?.content || "text").split("\n")[0];
  } else {
    const title = el.querySelector(".clip-title");
    if (title) title.textContent = basename(clip.filePath);
    if (clip.kind === "video") {
      const img = el.querySelector(".clip-thumb-row img");
      if (clip.thumbnailUrl && img.src !== clip.thumbnailUrl) img.src = clip.thumbnailUrl;
      img.style.display = clip.thumbnailUrl ? "" : "none";
      // opacity line position
      const opPct = clamp(1 - (clip.opacity ?? 1), 0, 1) * 100;
      el.querySelector(".opacity-line").style.top = `${opPct}%`;
      el.querySelector(".opacity-hit").style.top = `${opPct}%`;
    }

    // waveforms + volume lines (height from the live layout so track
    // scaling via ctrl+scroll is reflected)
    const waveTracks = ensureWaveTracks(el, clip);
    const wavesEl = el.querySelector(".clip-waves");
    const wavesH = wavesEl?.clientHeight || (clip.kind === "video" ? 44 : 44);
    const waveH = Math.max(8, wavesH / Math.max(1, waveTracks.length));
    waveTracks.forEach((wt, i) => {
      const tr = clip.audioTracks[i];
      const entry = tr?.wavPath ? getAudioEntry(tr.wavPath) : null;
      layoutWave(wt.querySelector("canvas"), entry?.peaks, clip, width, waveH);
      const volPct = clamp(1 - (tr?.volume ?? 1) / 2, 0, 1) * 100;
      wt.querySelector(".vol-line").style.top = `${volPct}%`;
      wt.querySelector(".vol-hit").style.top = `${volPct}%`;
    });

    // fades
    const path = el.querySelector(".fade-line");
    const svg = el.querySelector(".fade-svg");
    if (path && svg) {
      const h = el.clientHeight || 40;
      svg.setAttribute("viewBox", `0 0 ${width} ${h}`);
      let d = "";
      const fi = (clip.fadeIn || 0) * pps;
      const fo = (clip.fadeOut || 0) * pps;
      if (fi > 0) d += `M 0 ${h} L ${fi} 0 `;
      if (fo > 0) d += `M ${width - fo} 0 L ${width} ${h}`;
      path.setAttribute("d", d);
    }
    const fadeL = el.querySelector(".fade-handle.left");
    const fadeR = el.querySelector(".fade-handle.right");
    if (fadeL) fadeL.style.left = `${(clip.fadeIn || 0) * pps}px`;
    if (fadeR) fadeR.style.left = `${width - (clip.fadeOut || 0) * pps}px`;
  }
}

export function renderClips() {
  renderTracks();

  const totalWidth = Math.ceil(viewEnd() * state.pps);
  tlContent.style.width = `${totalWidth}px`;

  const live = new Set();
  for (const clip of state.clips) {
    live.add(clip.id);
    let el = clipEls.get(clip.id);
    if (!el) {
      el = buildClipEl(clip);
      clipEls.set(clip.id, el);
    }
    const row = trackEls.get(clip.trackId);
    if (row && el.parentElement !== row) row.appendChild(el);
    updateClipEl(clip);
  }
  for (const [id, el] of clipEls) {
    if (!live.has(id)) {
      el.remove();
      clipEls.delete(id);
    }
  }

  updatePlayhead();
}

let renderQueued = false;
export function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderClips();
  });
}

export function updateSelection() {
  for (const [id, el] of clipEls) {
    el.classList.toggle("selected", id === state.selectedId);
  }
}

// scroll → redraw ruler + reposition windowed waveforms (rAF-throttled)
tlScroll.addEventListener(
  "scroll",
  () => {
    renderRuler();
    requestRender();
  },
  { passive: true }
);
window.addEventListener("resize", () => {
  renderRuler();
  requestRender();
});
