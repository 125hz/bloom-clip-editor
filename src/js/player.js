// player.js - playback engine.
//
// Design: the Web Audio clock is the master clock. Audio segments are
// scheduled AHEAD of time on the AudioContext timeline (sample-accurate, no
// stop/restart at clip boundaries -> no stutter). Video elements live in a
// small pool, are preloaded before their clip starts, and are slaved to the
// clock with drift correction — the timeline never stalls at a clip boundary
// because time is driven by the clock, not by video frame callbacks.
// The preview is a canvas compositor: video layers bottom-to-top, then text.

import {
  state,
  emit,
  tracksOfKind,
  clipsInTrack,
  clipEnd,
  contentEnd,
} from "./state.js";
import { getAudioEntry } from "./media.js";
import { clamp } from "./utils.js";

const canvas = document.getElementById("preview-canvas");
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
const noClipOverlay = document.getElementById("no-clip-overlay");

let audioCtx = null;
let clockStartCtx = 0;
let clockStartTime = 0;
let rafId = null;
let schedulerTimer = null;

const SCHEDULE_HORIZON = 1.5; // seconds of audio scheduled ahead
const PRELOAD_AHEAD = 4; // seconds before a clip starts to preload video
const POOL_MAX = 8;

// clipId -> { el, lastUsed }
const pool = new Map();
// "clipId:trackOrder" -> { src, fadeGain, volGain, clipId, order }
const scheduled = new Map();

function ensureCtx() {
  if (!audioCtx) audioCtx = new AudioContext({ latencyHint: "interactive" });
  return audioCtx;
}

export function currentTime() {
  if (state.playing && audioCtx) {
    return clockStartTime + (audioCtx.currentTime - clockStartCtx);
  }
  return state.time;
}

// -------------------- video pool --------------------

function getVideoEl(clip) {
  let entry = pool.get(clip.id);
  if (!entry) {
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.src = clip.fileUrl;
    entry = { el, lastUsed: performance.now() };
    pool.set(clip.id, entry);
    evictPool();
  }
  entry.lastUsed = performance.now();
  return entry.el;
}

function evictPool() {
  if (pool.size <= POOL_MAX) return;
  const entries = [...pool.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (pool.size > POOL_MAX && entries.length) {
    const [id, entry] = entries.shift();
    if (entry.el._active) continue;
    entry.el.pause();
    entry.el.removeAttribute("src");
    entry.el.load();
    pool.delete(id);
  }
}

export function invalidatePool() {
  const live = new Set(state.clips.map((c) => c.id));
  for (const [id, entry] of pool) {
    if (!live.has(id)) {
      entry.el.pause();
      entry.el.removeAttribute("src");
      entry.el.load();
      pool.delete(id);
    }
  }
}

function safeSeek(el, t, clip) {
  const dur = el.duration || clip.sourceDuration || clip.duration;
  const fps = clip.fps > 0 ? clip.fps : 60;
  el.currentTime = clamp(t, 0, Math.max(0, dur - Math.max(0.01, 0.5 / fps)));
}

// -------------------- active clip queries --------------------

function clipInTrackAt(trackId, t) {
  for (const c of clipsInTrack(trackId)) {
    if (t >= c.startTime - 0.0005 && t < clipEnd(c) - 0.0005) return c;
  }
  return null;
}

/// active video clips bottom layer first (draw order)
function activeVideoClips(t) {
  const tracks = tracksOfKind("video");
  const out = [];
  for (let i = tracks.length - 1; i >= 0; i--) {
    const c = clipInTrackAt(tracks[i].id, t);
    if (c) out.push(c);
  }
  return out;
}

function upcomingVideoClips(t) {
  const out = [];
  for (const track of tracksOfKind("video")) {
    for (const c of clipsInTrack(track.id)) {
      if (c.startTime > t && c.startTime <= t + PRELOAD_AHEAD) out.push(c);
    }
  }
  return out;
}

// -------------------- video sync --------------------

function syncVideos(t, playing) {
  const active = activeVideoClips(t);
  const activeIds = new Set(active.map((c) => c.id));

  for (const c of active) {
    const el = getVideoEl(c);
    el._active = true;
    const expected = c.inPoint + (t - c.startTime);
    if (el.readyState >= 2) {
      // drift correction only while playing — paused seeks are owned by
      // seekPreview so it can redraw once the seek completes
      if (playing && Math.abs(el.currentTime - expected) > 0.12) safeSeek(el, expected, c);
      if (playing && el.paused && !el.ended) el.play().catch(() => {});
      if (!playing && !el.paused) el.pause();
    }
  }

  for (const [id, entry] of pool) {
    if (!activeIds.has(id)) {
      entry.el._active = false;
      if (!entry.el.paused) entry.el.pause();
    }
  }

  // preload upcoming clips: create element, park it at the clip's in-point
  for (const c of upcomingVideoClips(t)) {
    const el = getVideoEl(c);
    if (el._active) continue;
    if (el.readyState >= 1) {
      if (!el.seeking && Math.abs(el.currentTime - c.inPoint) > 0.25) {
        safeSeek(el, c.inPoint, c);
      }
    }
  }

  return active;
}

// -------------------- compositor --------------------

const FONT_CSS = {
  consolas: "Consolas, monospace",
  arial: "Arial, sans-serif",
  impact: "Impact, sans-serif",
  "segoe ui": "'Segoe UI', sans-serif",
  "courier new": "'Courier New', monospace",
  "times new roman": "'Times New Roman', serif",
  bahnschrift: "Bahnschrift, sans-serif",
};

function drawableSource(entry) {
  const el = entry?.el;
  if (el && el.readyState >= 2 && el.videoWidth) {
    return { src: el, w: el.videoWidth, h: el.videoHeight, live: true };
  }
  const hold = entry?.hold;
  if (hold && hold.width > 1) {
    return { src: hold, w: hold.width, h: hold.height, live: false };
  }
  return null;
}

function captureHold(entry) {
  const el = entry.el;
  if (!entry.hold) entry.hold = document.createElement("canvas");
  if (entry.hold.width !== el.videoWidth || entry.hold.height !== el.videoHeight) {
    entry.hold.width = el.videoWidth;
    entry.hold.height = el.videoHeight;
  }
  try {
    entry.hold.getContext("2d").drawImage(el, 0, 0);
  } catch {}
}

function fadeAlpha(c, t) {
  const into = t - c.startTime;
  let a = 1;
  if (c.fadeIn > 0 && into < c.fadeIn) a = into / c.fadeIn;
  else if (c.fadeOut > 0 && into > c.duration - c.fadeOut) a = (c.duration - into) / c.fadeOut;
  return clamp(a, 0, 1);
}

export function textBlockMetrics(c, W, H) {
  const s = c.text;
  const px = Math.max(1, s.size * H);
  ctx.font = `${s.bold ? "bold " : ""}${px}px ${FONT_CSS[s.font] || FONT_CSS.consolas}`;
  const lines = String(s.content || "").split("\n");
  const lineH = px * 1.2;
  let maxW = 0;
  for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
  return {
    x: s.x * W - maxW / 2,
    y: s.y * H - (lineH * lines.length) / 2,
    w: maxW,
    h: lineH * lines.length,
    lines,
    lineH,
    px,
  };
}

function drawTextClip(c, W, H) {
  const s = c.text;
  if (!s) return;
  const m = textBlockMetrics(c, W, H);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = s.x * W;
  for (let i = 0; i < m.lines.length; i++) {
    const y = s.y * H - m.h / 2 + m.lineH * (i + 0.5);
    if (s.outlineWidth > 0) {
      ctx.strokeStyle = s.outlineColor || "#000000";
      ctx.lineWidth = Math.max(1, s.outlineWidth * H * 2);
      ctx.lineJoin = "round";
      ctx.strokeText(m.lines[i], cx, y);
    }
    ctx.fillStyle = s.color || "#ffffff";
    ctx.fillText(m.lines[i], cx, y);
  }
}

export function activeTextClips(t) {
  const tracks = tracksOfKind("text");
  const out = [];
  for (let i = tracks.length - 1; i >= 0; i--) {
    for (const c of clipsInTrack(tracks[i].id)) {
      if (t >= c.startTime - 0.0005 && t < clipEnd(c) - 0.0005) out.push(c);
    }
  }
  return out;
}

export function draw(t = state.time) {
  const W = canvas.width;
  const H = canvas.height;
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  const active = activeVideoClips(t);
  let drewVideo = false;
  for (const c of active) {
    const entry = pool.get(c.id);
    // while a seek is in flight readyState dips below HAVE_CURRENT_DATA;
    // fall back to the clip's last captured frame so scrubbing never flashes black
    const d = drawableSource(entry);
    if (!d) continue;
    const { src, live } = d;
    const vw = d.w;
    const vh = d.h;
    // crop/zoom: draw a sub-rectangle of the source
    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;
    const cr = c.crop;
    if (cr && cr.zoom > 1.001) {
      sw = vw / cr.zoom;
      sh = vh / cr.zoom;
      sx = clamp(cr.cx * vw - sw / 2, 0, vw - sw);
      sy = clamp(cr.cy * vh - sh / 2, 0, vh - sh);
    }
    const s = Math.min(W / sw, H / sh);
    const dw = sw * s;
    const dh = sh * s;
    ctx.globalAlpha = fadeAlpha(c, t) * clamp(c.opacity ?? 1, 0, 1);
    ctx.drawImage(src, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
    drewVideo = true;
    if (live && !state.playing) captureHold(entry);
  }
  ctx.globalAlpha = 1;

  const texts = activeTextClips(t);
  for (const c of texts) {
    ctx.globalAlpha = fadeAlpha(c, t);
    drawTextClip(c, W, H);
  }
  ctx.globalAlpha = 1;

  noClipOverlay.hidden = drewVideo || texts.length > 0 || active.length > 0;
}

export function applyQuality() {
  const a = state.baseAspect || { w: 1280, h: 720 };
  const s = state.settings.previewScale || 1;
  canvas.width = Math.max(2, Math.round(a.w * s));
  canvas.height = Math.max(2, Math.round(a.h * s));
  document
    .getElementById("preview-box")
    .style.setProperty("--preview-aspect", `${a.w} / ${a.h}`);
  draw(state.time);
}

export function canvasSize() {
  return { w: canvas.width, h: canvas.height };
}
export function previewCanvas() {
  return canvas;
}

// -------------------- audio scheduling --------------------

function* audioSegments() {
  for (const c of state.clips) {
    if (c.kind === "text") continue;
    for (const tr of c.audioTracks || []) {
      if (tr.enabled === false || !tr.wavPath) continue;
      yield { key: `${c.id}:${tr.order}`, clip: c, track: tr };
    }
  }
}

function scheduleSegment(seg, now) {
  const { clip: c, track: tr, key } = seg;
  const entry = getAudioEntry(tr.wavPath);
  const buffer = entry && entry.audioBuffer;
  if (!buffer) return; // still decoding; scheduler will retry

  let startAt = clockStartCtx + (c.startTime - clockStartTime);
  let offset = c.inPoint;
  if (startAt < now + 0.01) {
    offset += now + 0.01 - startAt;
    startAt = now + 0.01;
  }
  const remain = Math.min(c.inPoint + c.duration, buffer.duration) - offset;
  if (remain <= 0.005) return;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const fadeGain = audioCtx.createGain();
  const volGain = audioCtx.createGain();
  volGain.gain.value = clamp(tr.volume ?? 1, 0, 4);

  // fade automation in absolute context time (normalized 0..1; volume separate)
  const clipStartCtx = clockStartCtx + (c.startTime - clockStartTime);
  const endCtx = clipStartCtx + c.duration;
  const fadeInEnd = clipStartCtx + (c.fadeIn || 0);
  const fadeOutStart = endCtx - (c.fadeOut || 0);

  let g0 = 1;
  if (c.fadeIn > 0 && startAt < fadeInEnd) {
    g0 = (startAt - clipStartCtx) / c.fadeIn;
  } else if (c.fadeOut > 0 && startAt > fadeOutStart) {
    g0 = (endCtx - startAt) / c.fadeOut;
  }
  fadeGain.gain.setValueAtTime(clamp(g0, 0, 1), startAt);
  if (c.fadeIn > 0 && fadeInEnd > startAt) {
    fadeGain.gain.linearRampToValueAtTime(1, fadeInEnd);
  }
  if (c.fadeOut > 0 && endCtx > startAt) {
    if (fadeOutStart > startAt) fadeGain.gain.setValueAtTime(1, fadeOutStart);
    fadeGain.gain.linearRampToValueAtTime(0, Math.max(endCtx, startAt + 0.002));
  }

  src.connect(fadeGain);
  fadeGain.connect(volGain);
  volGain.connect(audioCtx.destination);
  src.start(startAt, offset, remain);

  const rec = { src, fadeGain, volGain, clipId: c.id, order: tr.order };
  scheduled.set(key, rec);
  src.onended = () => {
    if (scheduled.get(key) === rec) scheduled.delete(key);
    try {
      volGain.disconnect();
    } catch {}
  };
}

function schedulerTick() {
  if (!state.playing || !audioCtx) return;
  const now = audioCtx.currentTime;
  const t = clockStartTime + (now - clockStartCtx);
  for (const seg of audioSegments()) {
    if (scheduled.has(seg.key)) continue;
    if (clipEnd(seg.clip) <= t + 0.01) continue;
    if (seg.clip.startTime > t + SCHEDULE_HORIZON) continue;
    scheduleSegment(seg, now);
  }
}

function stopAudio() {
  for (const rec of scheduled.values()) {
    try {
      rec.src.onended = null;
      rec.src.stop();
    } catch {}
    try {
      rec.volGain.disconnect();
    } catch {}
  }
  scheduled.clear();
}

/// live volume update while playing (volume line drag)
export function updateLiveVolume(clipId, order, volume) {
  const rec = scheduled.get(`${clipId}:${order}`);
  if (rec && audioCtx) {
    rec.volGain.gain.setTargetAtTime(clamp(volume, 0, 4), audioCtx.currentTime, 0.02);
  }
}

/// clip edits during playback invalidate its scheduled audio
export function rescheduleAudio() {
  if (!state.playing) return;
  stopAudio();
  schedulerTick();
}

// -------------------- transport --------------------

function tick() {
  if (!state.playing) return;
  let t = currentTime();

  // loop region: jump back to the start when reaching the end
  if (state.loop && t >= state.loop.end - 0.005) {
    seek(state.loop.start);
    t = state.loop.start;
  }
  state.time = t;

  const end = contentEnd();
  if (!state.loop && t > end + 0.3) {
    stop();
    return;
  }

  syncVideos(t, true);
  draw(t);
  emit("tick", t);
  rafId = requestAnimationFrame(tick);
}

export async function play() {
  if (state.playing || state.exporting) return;
  const ctxA = ensureCtx();
  try {
    await ctxA.resume();
  } catch {}

  // start from the loop region if the playhead is outside it
  if (state.loop && (state.time < state.loop.start - 0.005 || state.time >= state.loop.end - 0.005)) {
    state.time = state.loop.start;
  }
  state.anchorTime = state.time;
  clockStartCtx = ctxA.currentTime;
  clockStartTime = state.time;
  state.playing = true;

  schedulerTick();
  schedulerTimer = setInterval(schedulerTick, 200);
  syncVideos(state.time, true);
  rafId = requestAnimationFrame(tick);
  emit("playstate", true);
}

export function stop() {
  if (!state.playing) return;
  state.playing = false;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  stopAudio();
  for (const { el } of pool.values()) el.pause();

  if (state.settings.pauseAtPlayhead) {
    state.anchorTime = state.time;
  } else {
    state.time = state.anchorTime;
  }
  seekPreview(state.time);
  emit("playstate", false);
  emit("tick", state.time);
}

export function togglePlay() {
  state.playing ? stop() : play();
}

export function seek(t) {
  t = Math.max(0, t);
  state.time = t;
  if (state.playing && audioCtx) {
    stopAudio();
    clockStartCtx = audioCtx.currentTime;
    clockStartTime = t;
    schedulerTick();
    syncVideos(t, true);
  } else {
    seekPreview(t);
  }
  emit("tick", t);
}

// -------------------- paused preview / scrubbing --------------------

let seekTicket = 0;

export function seekPreview(t) {
  const ticket = ++seekTicket;
  const active = syncVideos(t, false);

  for (const c of active) {
    const el = getVideoEl(c);
    const expected = c.inPoint + (t - c.startTime);
    const redraw = () => {
      if (ticket !== seekTicket || state.playing) return;
      draw(t);
      requestAnimationFrame(() => {
        if (ticket === seekTicket && !state.playing) draw(t);
      });
    };
    const doSeek = () => {
      if (el.seeking || Math.abs(el.currentTime - expected) > 0.02) {
        el.onseeked = () => {
          el.onseeked = null;
          redraw();
        };
        safeSeek(el, expected, c);
      } else {
        redraw();
      }
    };
    if (el.readyState >= 1) {
      doSeek();
    } else {
      el.onloadedmetadata = () => {
        el.onloadedmetadata = null;
        doSeek();
      };
    }
  }
  // immediate draw: shows last decoded frames + up-to-date text overlays
  draw(t);
}

/// used by the export progress overlay
export function drawAtTime(t) {
  seekPreview(t);
}
