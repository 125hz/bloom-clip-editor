// interactions.js - all timeline mouse interactions: scrub, drag (horizontal +
// cross-layer), trim, fades, volume lines, split/delete, zoom wheel.

import {
  state,
  emit,
  clipById,
  clipsInTrack,
  clipEnd,
  trackById,
  setSelected,
  pushHistory,
  findVideoClipAtTime,
  tracksOfKind,
} from "./state.js";
import {
  rulerCanvas,
  tlScroll,
  tlContent,
  timeAtClientX,
  requestRender,
  renderClips,
  updateClipEl,
  updatePlayhead,
  updateLoopRegion,
  renderRuler,
  applyTrackScale,
  zoom,
} from "./timeline.js";
import * as player from "./player.js";
import { clamp, uid, MIN_CLIP_DURATION } from "./utils.js";

// -------------------- placement helpers --------------------

/// clamp a proposed start so [start, start+dur] fits in a gap of the track
export function allowedStart(trackId, dur, proposed, excludeId) {
  const others = clipsInTrack(trackId).filter((c) => c.id !== excludeId);
  const gaps = [];
  let cursor = 0;
  for (const o of others) {
    if (o.startTime - cursor >= dur - 1e-6) gaps.push([cursor, o.startTime]);
    cursor = Math.max(cursor, clipEnd(o));
  }
  gaps.push([cursor, Infinity]);

  let best = null;
  let bestDist = Infinity;
  for (const [a, b] of gaps) {
    const clamped = clamp(proposed, a, b === Infinity ? Infinity : b - dur);
    const d = Math.abs(clamped - proposed);
    if (d < bestDist) {
      bestDist = d;
      best = clamped;
    }
  }
  return Math.max(0, best ?? proposed);
}

/// candidate snap targets: timeline start, playhead, loop bounds, clip edges
function snapPoints({ excludeId = null, kind = null, includeLoop = true } = {}) {
  const points = [0, state.time];
  if (includeLoop && state.loop) points.push(state.loop.start, state.loop.end);
  for (const c of state.clips) {
    if (c.id === excludeId) continue;
    // snap against every layer, or only same-kind layers when disabled
    if (kind && !state.settings.crossLayerSnapping && trackById(c.trackId)?.kind !== kind)
      continue;
    points.push(c.startTime, clipEnd(c));
  }
  return points;
}

/// snap a single time value to the nearest candidate point
export function snapTime(t, opts = {}) {
  if (!state.settings.snapping) return t;
  const threshold = 10 / state.pps;
  let best = t;
  let bestDiff = threshold;
  for (const p of snapPoints(opts)) {
    const diff = Math.abs(t - p);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return best;
}

function applySnapping(proposed, clip, trackId) {
  if (!state.settings.snapping) return Math.max(0, proposed);
  const threshold = 10 / state.pps;
  let best = proposed;
  let bestDiff = threshold;

  const points = snapPoints({ excludeId: clip.id, kind: trackById(trackId)?.kind });
  for (const p of points) {
    // snap clip start to point
    let diff = Math.abs(proposed - p);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
    // snap clip end to point
    diff = Math.abs(proposed + clip.duration - p);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p - clip.duration;
    }
  }
  return Math.max(0, best);
}

export function toggleSnapping() {
  state.settings.snapping = !state.settings.snapping;
  emit("settings-changed");
  emit("snapping-changed", state.settings.snapping);
  emit("status", `snapping ${state.settings.snapping ? "on" : "off"}`);
}

// -------------------- scrubbing --------------------

let scrubbing = false;

function beginScrub(e) {
  scrubbing = true;
  const move = (ev) => {
    const t = timeAtClientX(ev.clientX);
    state.anchorTime = t;
    player.seek(t);
    updatePlayhead();
  };
  const up = () => {
    scrubbing = false;
    window.removeEventListener("mousemove", rafMove);
    window.removeEventListener("mouseup", up);
  };
  let queued = null;
  const rafMove = (ev) => {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = null;
      move(ev);
    });
  };
  window.addEventListener("mousemove", rafMove);
  window.addEventListener("mouseup", up);
  move(e);
}

rulerCanvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  beginScrub(e);
});

/// drag out a loop region; optionally treat a no-drag release as a seek
function beginLoopDrag(e, seekOnClick) {
  const t0 = timeAtClientX(e.clientX);
  const startX = e.clientX;
  let looping = false;

  const move = (ev) => {
    if (!looping && Math.abs(ev.clientX - startX) < 5) return;
    looping = true;
    const t1 = snapTime(timeAtClientX(ev.clientX), { includeLoop: false });
    const ts = snapTime(t0, { includeLoop: false });
    state.loop = { start: Math.min(ts, t1), end: Math.max(ts, t1) };
    updateLoopRegion();
    renderRuler();
  };
  const up = (ev) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (looping) {
      // discard accidental tiny regions
      if (state.loop && state.loop.end - state.loop.start < 0.15) state.loop = null;
      updateLoopRegion();
      renderRuler();
      emit("loop-changed", state.loop);
    } else if (seekOnClick) {
      const t = timeAtClientX(ev.clientX);
      state.anchorTime = t;
      player.seek(t);
      updatePlayhead();
    }
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// empty track area: click = seek, drag = create loop region
tlScroll.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const onClip = e.target.closest(".clip");
  const onLabel = e.target.closest(".track-label");
  if (onClip || onLabel || e.target.classList.contains("loop-handle")) return;
  setSelected(null);
  beginLoopDrag(e, true);
});

// middle-click drag: quick loop region anywhere on the timeline
for (const target of [tlScroll, rulerCanvas]) {
  target.addEventListener("mousedown", (e) => {
    if (e.button !== 1 || state.exporting) return;
    e.preventDefault(); // no autoscroll cursor
    beginLoopDrag(e, false);
  });
}

/// place a loop edge at the playhead (N / M hotkeys)
export function setLoopEdge(which) {
  const t = state.time;
  let loop = state.loop ? { ...state.loop } : null;
  if (which === "start") {
    if (!loop) loop = { start: t, end: t + 1 };
    else {
      loop.start = t;
      if (loop.end < loop.start + 0.15) loop.end = loop.start + 0.15;
    }
  } else {
    if (!loop) loop = { start: Math.max(0, t - 1), end: Math.max(t, 0.15) };
    else {
      loop.end = Math.max(t, 0.15);
      if (loop.start > loop.end - 0.15) loop.start = Math.max(0, loop.end - 0.15);
    }
  }
  state.loop = loop;
  updateLoopRegion();
  renderRuler();
  emit("loop-changed", state.loop);
}

// loop region edge handles
for (const handle of document.querySelectorAll("#loop-region .loop-handle")) {
  const isLeft = handle.classList.contains("left");
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !state.loop) return;
    e.stopPropagation();
    e.preventDefault();

    const move = (ev) => {
      if (!state.loop) return;
      const t = snapTime(timeAtClientX(ev.clientX), { includeLoop: false });
      if (isLeft) state.loop.start = clamp(t, 0, state.loop.end - 0.15);
      else state.loop.end = Math.max(t, state.loop.start + 0.15);
      updateLoopRegion();
      renderRuler();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      emit("loop-changed", state.loop);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

export function clearLoop() {
  state.loop = null;
  updateLoopRegion();
  renderRuler();
  emit("loop-changed", null);
}

// -------------------- clip interactions (delegated) --------------------

tlContent.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const clipEl = e.target.closest(".clip");
  if (!clipEl) return;
  const clip = clipById(clipEl.dataset.id);
  if (!clip) return;

  e.stopPropagation();
  setSelected(clip.id);

  if (state.exporting) return;

  if (e.target.classList.contains("vol-hit")) {
    startVolumeDrag(e, clip, e.target.closest(".wave-track"));
  } else if (e.target.classList.contains("opacity-hit")) {
    startOpacityDrag(e, clip, e.target.closest(".clip-thumb-row"));
  } else if (e.target.classList.contains("fade-handle")) {
    startFadeDrag(e, clip, e.target.classList.contains("left"));
  } else if (e.target.classList.contains("handle")) {
    const isLeft = e.target.classList.contains("left");
    if (e.ctrlKey && clip.kind !== "text") startSpeedDrag(e, clip, isLeft);
    else if (isLeft) startTrimLeft(e, clip);
    else startTrimRight(e, clip);
  } else if (e.shiftKey) {
    startDuplicateDrag(e, clip);
  } else {
    startDragClip(e, clip, clipEl);
  }
});

tlContent.addEventListener("dblclick", (e) => {
  // handled by the volume / opacity / speed reset handlers
  if (e.target.classList.contains("vol-hit") || e.target.classList.contains("opacity-hit")) return;
  if (e.ctrlKey || e.target.classList.contains("handle")) return;
  const clipEl = e.target.closest(".clip");
  if (!clipEl) return;
  const clip = clipById(clipEl.dataset.id);
  if (!clip) return;
  state.anchorTime = clip.startTime;
  player.seek(clip.startTime);
  updatePlayhead();
});

// -------------------- drag (horizontal + cross-track) --------------------

function trackRowAtY(clientY, kind) {
  for (const row of tlContent.querySelectorAll(".track-row")) {
    const r = row.getBoundingClientRect();
    if (clientY >= r.top && clientY <= r.bottom) {
      return row.dataset.kind === kind ? row : null;
    }
  }
  return null;
}

/// shift+drag: clone the clip and drag the clone with the cursor
function startDuplicateDrag(e, clip) {
  pushHistory();
  const dupe = JSON.parse(JSON.stringify(clip));
  dupe.id = uid();
  state.clips.push(dupe);
  renderClips(); // create the clone's element synchronously so we can drag it
  const el = tlContent.querySelector(`.clip[data-id="${dupe.id}"]`);
  setSelected(dupe.id);
  if (el) startDragClip(e, dupe, el, { skipHistory: true, removeIfUnmoved: true });
}

function startDragClip(e, clip, clipEl, opts = {}) {
  if (!opts.skipHistory) pushHistory();
  const startX = e.clientX;
  const origStart = clip.startTime;
  const origTrack = clip.trackId;
  const kind = trackById(origTrack)?.kind || clip.kind;
  let moved = false;
  let highlighted = null;

  const move = (ev) => {
    moved = true;
    clipEl.classList.add("dragging");

    // vertical: change track if hovering a compatible row
    const row = trackRowAtY(ev.clientY, kind);
    if (highlighted && highlighted !== row) highlighted.classList.remove("drop-target");
    if (row && row.dataset.trackId !== clip.trackId) {
      row.classList.add("drop-target");
      highlighted = row;
      clip.trackId = row.dataset.trackId;
      requestRender();
    }

    // horizontal
    const dx = (ev.clientX - startX) / state.pps;
    let proposed = Math.max(0, origStart + dx);
    proposed = applySnapping(proposed, clip, clip.trackId);
    clip.startTime = allowedStart(clip.trackId, clip.duration, proposed, clip.id);
    requestRender();
  };

  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    clipEl.classList.remove("dragging");
    if (highlighted) highlighted.classList.remove("drop-target");
    if (moved) {
      // final overlap check in landing track
      clip.startTime = allowedStart(clip.trackId, clip.duration, clip.startTime, clip.id);
      emit("project-changed");
      player.rescheduleAudio();
      if (!state.playing) player.seekPreview(state.time);
    } else if (opts.removeIfUnmoved) {
      // duplicate that never left its origin would overlap the original
      state.clips = state.clips.filter((c) => c.id !== clip.id);
      setSelected(null);
      emit("project-changed");
    } else {
      clip.trackId = origTrack;
    }
  };

  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// -------------------- trims --------------------

function startTrimLeft(e, clip) {
  pushHistory();
  const startX = e.clientX;
  const s0 = clip.startTime;
  const in0 = clip.inPoint;
  const d0 = clip.duration;
  const isText = clip.kind === "text";
  const speed = clip.speed || 1;

  const move = (ev) => {
    const dt = (ev.clientX - startX) / state.pps;
    // extending left is limited by the unused source ahead of the in-point
    const minStart = isText ? 0 : Math.max(0, s0 - in0 / speed);
    const proposed = snapTime(s0 + dt, { excludeId: clip.id, kind: clip.kind });
    const newStart = clamp(proposed, minStart, s0 + d0 - MIN_CLIP_DURATION);
    // don't allow crossing the previous clip in the track
    const prev = clipsInTrack(clip.trackId).filter((c) => c.id !== clip.id && clipEnd(c) <= s0 + 0.001).pop();
    const bounded = prev ? Math.max(newStart, clipEnd(prev)) : newStart;
    const bdelta = bounded - s0;
    clip.startTime = bounded;
    if (!isText) clip.inPoint = Math.max(0, in0 + bdelta * speed);
    clip.duration = Math.max(MIN_CLIP_DURATION, d0 - bdelta);
    clip.fadeIn = Math.min(clip.fadeIn || 0, clip.duration);
    clip.fadeOut = Math.min(clip.fadeOut || 0, clip.duration);
    updateClipEl(clip);
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    emit("project-changed");
    player.rescheduleAudio();
    if (!state.playing) player.seekPreview(state.time);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function startTrimRight(e, clip) {
  pushHistory();
  const startX = e.clientX;
  const d0 = clip.duration;
  const isText = clip.kind === "text";
  const speed = clip.speed || 1;

  const move = (ev) => {
    const dt = (ev.clientX - startX) / state.pps;
    // remaining source, expressed in timeline seconds at the current speed
    const maxDur = isText ? Infinity : (clip.sourceDuration - clip.inPoint) / speed;
    const proposedEnd = snapTime(clip.startTime + d0 + dt, { excludeId: clip.id, kind: clip.kind });
    let dur = clamp(proposedEnd - clip.startTime, MIN_CLIP_DURATION, maxDur);
    // don't overlap the next clip in the track
    const next = clipsInTrack(clip.trackId).find(
      (c) => c.id !== clip.id && c.startTime >= clip.startTime + 0.001
    );
    if (next) dur = Math.min(dur, next.startTime - clip.startTime);
    clip.duration = Math.max(MIN_CLIP_DURATION, dur);
    clip.fadeIn = Math.min(clip.fadeIn || 0, clip.duration);
    clip.fadeOut = Math.min(clip.fadeOut || 0, clip.duration);
    updateClipEl(clip);
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    emit("project-changed");
    player.rescheduleAudio();
    if (!state.playing) player.seekPreview(state.time);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// -------------------- speed (ctrl+drag an edge) --------------------

/// Ctrl+dragging a clip edge stretches or squeezes the same source content
/// over a different timeline span — drag outward to slow down (to x0.05),
/// inward to speed up (to x4). Ctrl+double-click an edge resets to x1.
function startSpeedDrag(e, clip, isLeft) {
  pushHistory();
  const startX = e.clientX;
  const s0 = clip.startTime;
  const d0 = clip.duration;
  const speed0 = clip.speed || 1;
  const contentLen = d0 * speed0; // source seconds the clip consumes
  const end0 = s0 + d0;

  const move = (ev) => {
    const dt = (ev.clientX - startX) / state.pps;
    let newDur = isLeft ? d0 - dt : d0 + dt;

    // speed stays in [0.05, 4]
    newDur = clamp(newDur, contentLen / 4, contentLen / 0.05);
    newDur = Math.max(newDur, MIN_CLIP_DURATION);

    if (isLeft) {
      let newStart = end0 - newDur;
      const prev = clipsInTrack(clip.trackId)
        .filter((c) => c.id !== clip.id && clipEnd(c) <= s0 + 0.001)
        .pop();
      newStart = Math.max(newStart, prev ? clipEnd(prev) : 0, 0);
      newDur = end0 - newStart;
      clip.startTime = newStart;
    } else {
      const next = clipsInTrack(clip.trackId).find(
        (c) => c.id !== clip.id && c.startTime >= s0 + 0.001
      );
      if (next) newDur = Math.min(newDur, next.startTime - s0);
    }

    clip.duration = Math.max(MIN_CLIP_DURATION, newDur);
    clip.speed = clamp(contentLen / clip.duration, 0.05, 4);
    clip.fadeIn = Math.min(clip.fadeIn || 0, clip.duration);
    clip.fadeOut = Math.min(clip.fadeOut || 0, clip.duration);
    updateClipEl(clip);
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    emit("project-changed");
    player.rescheduleAudio();
    if (!state.playing) player.seekPreview(state.time);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// ctrl+double-click a trim handle resets the clip's speed to x1
tlContent.addEventListener("dblclick", (e) => {
  if (!e.ctrlKey || !e.target.classList.contains("handle")) return;
  const clip = clipById(e.target.closest(".clip")?.dataset.id);
  if (!clip || clip.kind === "text") return;
  e.stopPropagation();
  pushHistory();
  const contentLen = clip.duration * (clip.speed || 1);
  let dur = contentLen;
  const next = clipsInTrack(clip.trackId).find(
    (c) => c.id !== clip.id && c.startTime >= clip.startTime + 0.001
  );
  if (next) dur = Math.min(dur, next.startTime - clip.startTime);
  clip.duration = Math.max(MIN_CLIP_DURATION, dur);
  clip.speed = 1;
  clip.fadeIn = Math.min(clip.fadeIn || 0, clip.duration);
  clip.fadeOut = Math.min(clip.fadeOut || 0, clip.duration);
  emit("project-changed");
  player.rescheduleAudio();
  if (!state.playing) player.seekPreview(state.time);
});

// -------------------- fades --------------------

function startFadeDrag(e, clip, isLeft) {
  pushHistory();
  const startX = e.clientX;
  const f0 = isLeft ? clip.fadeIn || 0 : clip.fadeOut || 0;

  const move = (ev) => {
    const dx = (ev.clientX - startX) / state.pps;
    const buffer = 0.05;
    if (isLeft) {
      const maxFade = Math.max(0, clip.duration - (clip.fadeOut || 0) - buffer);
      clip.fadeIn = clamp(f0 + dx, 0, maxFade);
    } else {
      const maxFade = Math.max(0, clip.duration - (clip.fadeIn || 0) - buffer);
      clip.fadeOut = clamp(f0 - dx, 0, maxFade);
    }
    updateClipEl(clip);
    if (!state.playing) player.draw(state.time);
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    emit("project-changed");
    player.rescheduleAudio();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// -------------------- volume --------------------

function startVolumeDrag(e, clip, waveTrack) {
  e.preventDefault();
  pushHistory();
  const order = Number(waveTrack.dataset.order);
  const tr = clip.audioTracks[order];
  if (!tr) return;
  const startY = e.clientY;
  const v0 = tr.volume ?? 1;
  const tip = waveTrack.querySelector(".vol-tip");
  tip.hidden = false;

  const move = (ev) => {
    const dy = startY - ev.clientY;
    tr.volume = clamp(v0 + dy / 60, 0, 2);
    tip.textContent = `${Math.round(tr.volume * 100)}%`;
    tip.style.top = `${clamp(1 - tr.volume / 2, 0, 1) * 100}%`;
    updateClipEl(clip);
    player.updateLiveVolume(clip.id, tr.order, tr.volume);
  };
  const up = () => {
    tip.hidden = true;
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    emit("project-changed");
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// -------------------- opacity (video clips) --------------------

function startOpacityDrag(e, clip, thumbRow) {
  e.preventDefault();
  pushHistory();
  const startY = e.clientY;
  const o0 = clip.opacity ?? 1;
  const tip = thumbRow.querySelector(".opacity-tip");
  tip.hidden = false;

  const move = (ev) => {
    const dy = ev.clientY - startY; // drag down = lower opacity
    clip.opacity = clamp(o0 - dy / 40, 0, 1);
    tip.textContent = `${Math.round(clip.opacity * 100)}%`;
    tip.style.top = `${clamp(1 - clip.opacity, 0, 1) * 100}%`;
    updateClipEl(clip);
    if (!state.playing) player.draw(state.time);
  };
  const up = () => {
    tip.hidden = true;
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    emit("project-changed");
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// double-click opacity line resets to 100%
tlContent.addEventListener("dblclick", (e) => {
  if (!e.target.classList.contains("opacity-hit")) return;
  e.stopPropagation();
  const clip = clipById(e.target.closest(".clip")?.dataset.id);
  if (!clip) return;
  pushHistory();
  clip.opacity = 1;
  updateClipEl(clip);
  if (!state.playing) player.draw(state.time);
  emit("project-changed");
});

// double-click volume line resets to 100%
tlContent.addEventListener("dblclick", (e) => {
  if (!e.target.classList.contains("vol-hit")) return;
  e.stopPropagation();
  const clipEl = e.target.closest(".clip");
  const wt = e.target.closest(".wave-track");
  const clip = clipById(clipEl?.dataset.id);
  if (!clip || !wt) return;
  const tr = clip.audioTracks[Number(wt.dataset.order)];
  if (!tr) return;
  pushHistory();
  tr.volume = 1;
  updateClipEl(clip);
  player.updateLiveVolume(clip.id, tr.order, 1);
  emit("project-changed");
});

// -------------------- zoom --------------------

function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey) {
    // ctrl+scroll: adjust track heights
    const s = clamp((state.settings.trackScale || 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.6, 2.5);
    state.settings.trackScale = s;
    applyTrackScale();
    requestRender();
    emit("settings-changed");
    return;
  }
  zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
}
tlScroll.addEventListener("wheel", onWheel, { passive: false });
rulerCanvas.addEventListener("wheel", onWheel, { passive: false });

// -------------------- split / delete --------------------

export function splitAtPlayhead() {
  const t = state.time;
  let clip = null;

  const selected = clipById(state.selectedId);
  if (selected && t > selected.startTime && t < clipEnd(selected)) clip = selected;
  if (!clip) clip = findVideoClipAtTime(t);
  if (!clip) {
    clip = state.clips.find(
      (c) => c.kind !== "video" && t > c.startTime && t < clipEnd(c)
    );
  }
  if (!clip) return;

  const offset = t - clip.startTime;
  if (offset <= MIN_CLIP_DURATION || offset >= clip.duration - MIN_CLIP_DURATION) return;

  pushHistory();
  const right = {
    ...JSON.parse(JSON.stringify(clip)),
    id: uid(),
    startTime: t,
    // timeline offset maps to source time through the clip's playback speed
    inPoint: clip.kind === "text" ? 0 : clip.inPoint + offset * (clip.speed || 1),
    duration: clip.duration - offset,
    fadeIn: 0,
  };
  clip.duration = offset;
  clip.fadeOut = 0;

  state.clips.push(right);
  setSelected(right.id);
  emit("project-changed");
  player.rescheduleAudio();
}

export function deleteSelected() {
  const clip = clipById(state.selectedId);
  if (!clip) return;
  pushHistory();

  const trackId = clip.trackId;
  const kind = trackById(trackId)?.kind;
  state.clips = state.clips.filter((c) => c.id !== clip.id);
  state.selectedId = null;

  // ripple: repack the affected video track
  if (state.settings.magneticSnapping && kind === "video") {
    let cursor = 0;
    for (const c of clipsInTrack(trackId)) {
      c.startTime = cursor;
      cursor += c.duration;
    }
  }

  emit("selection-changed", null);
  emit("project-changed");
  player.invalidatePool();
  player.rescheduleAudio();
  if (!state.playing) player.seekPreview(state.time);
}

// -------------------- select left / right of playhead --------------------

export function selectSideOfPlayhead(dir) {
  const eps = 0.05;
  const candidates =
    dir < 0
      ? state.clips.filter((c) => clipEnd(c) <= state.time + eps)
      : state.clips.filter((c) => clipEnd(c) > state.time + eps);
  if (!candidates.length) return;
  candidates.sort((a, b) =>
    dir < 0 ? clipEnd(b) - clipEnd(a) : a.startTime - b.startTime
  );
  const current = clipById(state.selectedId);
  const best =
    (current && candidates.find((c) => c.kind === current.kind)) || candidates[0];
  setSelected(best.id);
}
