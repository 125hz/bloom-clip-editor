// scrubbing.js - handles scrubbing the timeline

let scrubRaf = null;

// setGlobalTimeFromClientX - sets the global time from the client X position
function setGlobalTimeFromClientX(clientX) {
  const rect = tracksArea.getBoundingClientRect();
  const x = clientX - rect.left + tracksArea.scrollLeft;
  const t = clamp(x / pixelsPerSecond, 0, getTimelineViewEnd());

  playbackStartTime = t;
  setGhostPlayheadPosition();

  if (isPlaying) {
    return;
  }

  globalTime = t;
  setPlayheadPosition();
  ensurePlayheadVisibleEdge();
  routePreviewToTime(t, { forceSeek: true });
}

// beginScrub - begins scrubbing the timeline
function beginScrub(clientX) {
  scrubbing = true;
  setOverlayVisible(false);
  setGlobalTimeFromClientX(clientX);
}
// endScrub - ends scrubbing the timeline
function endScrub() {
  scrubbing = false;
  if (scrubRaf) cancelAnimationFrame(scrubRaf);
  scrubRaf = null;
  if (!isPlaying) {
    routePreviewToTime(playbackStartTime, { forceSeek: true });
  }
}

// handleScrubMove - handles scrubbing the timeline
function handleScrubMove(e) {
  if (scrubRaf) return;
  scrubRaf = requestAnimationFrame(() => {
    setGlobalTimeFromClientX(e.clientX);
    scrubRaf = null;
  });
}

timelineRuler.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  beginScrub(e.clientX);

  const onMove = handleScrubMove;
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    endScrub();
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

tracksArea.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const isEmpty = e.target === tracksArea || e.target === playhead || e.target === ghostPlayhead;
  if (!isEmpty) return;

  beginScrub(e.clientX);
  selectedClipId = null;
  requestRenderTimeline();

  const onMove = handleScrubMove;
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    endScrub();
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});
