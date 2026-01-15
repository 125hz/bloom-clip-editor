// drag_trim.js - lets the user drag and trim clips on the timeline.

// startDragClip: lets the user drag a clip on the timeline.
function startDragClip(e, clip) {
  pushHistory();
  const startX = e.clientX;
  const startTime = clip.startTime;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const proposed = Math.max(0, startTime + dx / pixelsPerSecond);
    clip.startTime = applySnapping(proposed, clip);
    requestRenderTimeline();
  };

  const onUp = async () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    await routePreviewToTime(globalTime, { forceSeek: true });
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// startTrimLeft: lets the user trim the left of a clip on the timeline.
function startTrimLeft(e, clip) {
  pushHistory();
  const startX = e.clientX;
  const startStart = clip.startTime;
  const startIn = clip.inPoint;
  const startDur = clip.duration;

  const onMove = async (ev) => {
    const dx = ev.clientX - startX;
    const dt = dx / pixelsPerSecond;

    const minStart = Math.max(0, startStart - startIn);
    
    const newStart = clamp(startStart + dt, minStart, startStart + startDur - MIN_CLIP_DURATION);
    const delta = newStart - startStart;

    clip.startTime = newStart;
    clip.inPoint = Math.max(0, startIn + delta);
    clip.duration = Math.max(MIN_CLIP_DURATION, startDur - delta);

    await refreshClipWaveforms(clip);
    requestRenderTimeline();
  };

  const onUp = async () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    await routePreviewToTime(globalTime, { forceSeek: true });
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// startTrimRight: lets the user trim the right of a clip on the timeline.
function startTrimRight(e, clip) {
  pushHistory();
  const startX = e.clientX;
  const startDur = clip.duration;

  const onMove = async (ev) => {
    const dx = ev.clientX - startX;
    const maxDur = clip.sourceDuration - clip.inPoint;
    const proposed = startDur + dx / pixelsPerSecond;
    clip.duration = clamp(proposed, MIN_CLIP_DURATION, maxDur);

    await refreshClipWaveforms(clip);
    requestRenderTimeline();
  };

  const onUp = async () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    await routePreviewToTime(globalTime, { forceSeek: true });
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
