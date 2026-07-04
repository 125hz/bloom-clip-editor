// state.js - central app state, track/layer model, undo history, event bus

import { uid } from "./utils.js";

export const bus = new EventTarget();
export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}
export function on(name, fn) {
  bus.addEventListener(name, (e) => fn(e.detail));
}

// Tracks are ordered top -> bottom as displayed.
// Video stacking: a video track displayed higher renders ON TOP of lower ones.
export const state = {
  tracks: [
    { id: uid(), kind: "text", name: "t1" },
    { id: uid(), kind: "video", name: "v1" },
    { id: uid(), kind: "audio", name: "a1" },
  ],
  clips: [],
  time: 0,
  anchorTime: 0, // where playback started (ghost playhead / return point)
  playing: false,
  pps: 20, // pixels per second (zoom)
  selectedId: null,
  baseAspect: null,
  exporting: false,
  loop: null, // { start, end } loop region, or null
  settings: {
    v: 2,
    magneticSnapping: true,
    crossLayerSnapping: true,
    pauseAtPlayhead: false,
    previewScale: 0.75,
    trackScale: 1,
  },
};

// -------------------- track helpers --------------------

export function tracksOfKind(kind) {
  return state.tracks.filter((t) => t.kind === kind);
}

export function trackById(id) {
  return state.tracks.find((t) => t.id === id) || null;
}

export function clipsInTrack(trackId) {
  return state.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.startTime - b.startTime);
}

/// 0-based stacking layer for export: bottom-most track of that kind = 0.
export function layerIndex(clip) {
  const group = tracksOfKind(trackById(clip.trackId)?.kind || "video");
  const i = group.findIndex((t) => t.id === clip.trackId);
  return i === -1 ? 0 : group.length - 1 - i;
}

let trackCounter = { video: 1, audio: 1, text: 1 };

export function addTrack(kind) {
  trackCounter[kind] += 1;
  const track = { id: uid(), kind, name: `${kind[0]}${trackCounter[kind]}` };
  // insert at the top of its kind group (new track = higher layer)
  const firstOfKind = state.tracks.findIndex((t) => t.kind === kind);
  if (firstOfKind === -1) {
    // keep visual grouping: text on top, then video, then audio
    const order = { text: 0, video: 1, audio: 2 };
    let at = state.tracks.length;
    for (let i = 0; i < state.tracks.length; i++) {
      if (order[state.tracks[i].kind] > order[kind]) {
        at = i;
        break;
      }
    }
    state.tracks.splice(at, 0, track);
  } else {
    state.tracks.splice(firstOfKind, 0, track);
  }
  emit("project-changed");
  return track;
}

export function removeTrack(trackId) {
  const track = trackById(trackId);
  if (!track) return false;
  if (state.clips.some((c) => c.trackId === trackId)) return false;
  if (track.kind !== "text" && tracksOfKind(track.kind).length <= 1) return false;
  state.tracks = state.tracks.filter((t) => t.id !== trackId);
  emit("project-changed");
  return true;
}

export function ensureTrack(kind) {
  return tracksOfKind(kind)[0] || addTrack(kind);
}

// -------------------- clip helpers --------------------

export function clipById(id) {
  return state.clips.find((c) => c.id === id) || null;
}

export function clipEnd(c) {
  return c.startTime + c.duration;
}

export function contentEnd() {
  let end = 0;
  for (const c of state.clips) end = Math.max(end, clipEnd(c));
  return end;
}

/// topmost video clip visible at time t (for single-result queries)
export function findVideoClipAtTime(t) {
  for (const track of tracksOfKind("video")) {
    for (const c of clipsInTrack(track.id)) {
      if (t >= c.startTime - 0.0005 && t < clipEnd(c) - 0.0005) return c;
    }
  }
  return null;
}

/// all clips of a kind active at time t
export function clipsAtTime(t, kind = null) {
  return state.clips.filter(
    (c) =>
      (!kind || c.kind === kind) && t >= c.startTime - 0.0005 && t < clipEnd(c) - 0.0005
  );
}

export function setSelected(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  emit("selection-changed", id);
}

// -------------------- undo / redo --------------------

const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 100;

function snapshot() {
  return {
    tracks: JSON.parse(JSON.stringify(state.tracks)),
    clips: JSON.parse(JSON.stringify(state.clips)),
    time: state.time,
    selectedId: state.selectedId,
  };
}

function restore(snap) {
  state.tracks = JSON.parse(JSON.stringify(snap.tracks));
  state.clips = JSON.parse(JSON.stringify(snap.clips));
  state.time = snap.time;
  state.anchorTime = snap.time;
  state.selectedId = snap.selectedId;
  emit("project-restored");
  emit("project-changed");
}

export function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

// -------------------- settings persistence --------------------

const SETTINGS_KEY = "bloom-editor-settings";

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    // v2: preview quality default moved 50% -> 75%
    if (!saved.v || saved.v < 2) delete saved.previewScale;
    saved.v = 2;
    Object.assign(state.settings, saved);
  } catch {}
}

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {}
}
