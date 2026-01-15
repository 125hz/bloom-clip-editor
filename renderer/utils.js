// utils.js - Utility functions

// clamp - Clamps a value between a minimum and maximum
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// uid - Generates a unique ID
function uid() { return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }

// basename - Returns the base name of a path
function basename(p) { return (p || "").split(/[\\/]/).pop(); }

// formatTime - Formats a time in seconds as a string
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
}

// once - Waits for an event once, with a safety timeout.
// This prevents rare hangs (e.g., media elements that fail to emit seeked/loadedmetadata reliably)
// from blocking UI flows like import.
function once(el, ev, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const handler = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    el.addEventListener(ev, handler, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { el.removeEventListener(ev, handler); } catch { }
      resolve();
    }, timeoutMs);
  });
}

// deepCloneState - Deep clones the current state
function deepCloneState() {
  return { clips: JSON.parse(JSON.stringify(clips)), globalTime, pixelsPerSecond, selectedClipId };
}

// restoreState - Restores the state from a deep clone
function restoreState(st) {
  clips = JSON.parse(JSON.stringify(st.clips || []));
  globalTime = st.globalTime ?? 0;
  playbackStartTime = globalTime;
  pixelsPerSecond = st.pixelsPerSecond ?? 20;
  selectedClipId = st.selectedClipId ?? null;

  activeClipId = null;
  isPlaying = false;
  stopPreviewMix();
  try { front.pause(); } catch { }

  renderTimeline();
  routePreviewToTime(globalTime, { forceSeek: true });
  applyPreviewQuality();
}

// pushHistory - Pushes the current state to the undo stack
function pushHistory() {
  undoStack.push(deepCloneState());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

// undo - Undoes the last action (need to work on more, doesnt work for all actions)
function undo() {
  if (!undoStack.length) return;
  redoStack.push(deepCloneState());
  restoreState(undoStack.pop());
}

// redo - Redoes the last undone action (need to work on more, doesnt work for all actions)
function redo() {
  if (!redoStack.length) return;
  undoStack.push(deepCloneState());
  restoreState(redoStack.pop());
}

// setOverlayVisible - Sets the visibility of the noClipOverlay
function setOverlayVisible(visible) {
  if (scrubbing) visible = false;
  noClipOverlay.style.display = visible ? "flex" : "none";
}

// setPreviewAspectFromFirstClip - Sets the preview aspect ratio from the first clip
function setPreviewAspectFromFirstClip(w, h) {
  if (baseAspect) return;
  if (!w || !h) return;
  baseAspect = { w, h };
  previewSection.style.setProperty("--preview-aspect", `${w} / ${h}`);
}

// getTimelineContentEnd - Returns the end of the timeline content
function getTimelineContentEnd() {
  let end = 0;
  for (const c of clips) end = Math.max(end, c.startTime + c.duration);
  return end;
}

// getTimelineViewEnd - Returns the end of the timeline view
function getTimelineViewEnd() {
  const contentEnd = getTimelineContentEnd();
  const viewSeconds = tracksArea.clientWidth / pixelsPerSecond;
  return Math.max(contentEnd + 5, viewSeconds);
}

window.addEventListener("resize", () => {
  if (typeof window.renderRuler === "function") window.renderRuler();
});

// setPlayheadPosition - Sets the position of the playhead
function setPlayheadPosition() {
  playhead.style.left = `${globalTime * pixelsPerSecond}px`;
  if (timeDisplay) timeDisplay.textContent = formatTime(globalTime);
}

// setGhostPlayheadPosition - Sets the position of the ghost playhead
function setGhostPlayheadPosition() {
  ghostPlayhead.style.left = `${playbackStartTime * pixelsPerSecond}px`;
}

// updatePlayhead - Updates the playhead position
function updatePlayhead() {
  setPlayheadPosition();
  setGhostPlayheadPosition();
}

// ensurePlayheadVisibleEdge - Ensures the playhead is visible
function ensurePlayheadVisibleEdge() {
  const x = globalTime * pixelsPerSecond;
  const left = tracksArea.scrollLeft;
  const right = left + tracksArea.clientWidth;
  if (x < left + 40) tracksArea.scrollLeft = Math.max(0, x - 40);
  else if (x > right - 40) tracksArea.scrollLeft = x - (tracksArea.clientWidth - 40);
}

// findClipAtTime - Finds the clip at a given time
function findClipAtTime(t) {
  const eps = 0.0005;
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    if (c.type === 'audio') continue;
    const start = c.startTime;
    const end = c.startTime + c.duration;
    if (t >= start && t < end - eps) return c;
    if (Math.abs(t - end) <= eps && t >= start) return c;
  }
  return null;
}

// findClipsAtTime - Finds the clips at a given time
// (differs from findClipAtTime in that it returns all clips that overlap the given time)
function findClipsAtTime(t) {
  return clips.filter(c => {
    const start = c.startTime;
    const end = c.startTime + c.duration;
    return t >= start && t < end - 0.01;
  });
}

// safeSeekTime - Safely seeks to a given time
function safeSeekTime(desired, duration, fps) {
  const f = fps && fps > 0 ? fps : 60;
  const safety = Math.max(0.01, 0.5 / f);
  return clamp(desired, 0, Math.max(0, duration - safety));
}

// swapFrontBack - Swaps the front and back video elements
async function swapFrontBack() {
  const tmp = front;
  front = back;
  back = tmp;
  
  front.style.opacity = 1;
  front.style.zIndex = 1;
  
  back.style.opacity = 0;
  back.style.zIndex = -1;
}

// -------------------- Style Injection --------------------
// Hides the default white scrollbar on the timeline and body
(function injectStyles() {
  const style = document.createElement("style");
  style.textContent = `
    /* Hide scrollbar for Chrome/Safari/Electron */
    ::-webkit-scrollbar {
      display: none; 
    }
    
    /* Ensure timeline container doesn't show scrollbars but still scrolls */
    #tracks-area, #timeline-ruler, .timeline-scroll-container {
      scrollbar-width: none; /* Firefox */
      -ms-overflow-style: none; /* IE/Edge */
      overflow-x: scroll; /* Maintain scrollability */
    }

    body {
      overflow: hidden; /* Prevent full page bounce/scroll */
    }
  `;
  document.head.appendChild(style);
})();