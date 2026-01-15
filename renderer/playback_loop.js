// playback_loop.js - Handles playback and video frame processing
// this file is a mess, but it works for the time being. need to fix audio stutter between clips in the future

let lastGapTime = 0;

async function startPlayback() {
  try { ensureAudioCtx(); await audioCtx.resume(); } catch { }

  await routePreviewToTime(globalTime, { forceSeek: true });

  isPlaying = true;
  playPauseBtn.textContent = "||"; // Pause icon
  startCanvasDrawLoop();

  await updateAudioMix(globalTime);

  await tickPlayback();
}

async function tickPlayback() {
  if (!isPlaying) return;

  const videoClip = findClipAtTime(globalTime);

  if (videoClip) {
    if (activeClipId !== videoClip.id) {
      await routePreviewToTime(globalTime, { forceSeek: true });
      updateAudioMix(globalTime); // force immediate audio update after switch to prevent gap
    }

    try {
      await front.play();
      front.requestVideoFrameCallback(onVideoFrame);
    } catch (e) {
      console.error(e);
      stopPlayback();
    }
  } else {
    activeClipId = null;
    try { front.pause(); } catch { }
    front.style.visibility = 'hidden';
    back.style.visibility = 'hidden';

    lastGapTime = performance.now();
    requestAnimationFrame(onGapFrame);
  }
}

const onVideoFrame = (now, metadata) => {
  if (!isPlaying) return;
  if (isSeeking) return;


  const currentClip = clips.find(c => c.id === activeClipId);

  if (currentClip) {
    const videoTime = Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : front.currentTime;
    globalTime = currentClip.startTime + (videoTime - currentClip.inPoint);

    updateAudioMix(globalTime);

    // --- FADE VISUALS ---
    const t = globalTime - currentClip.startTime;
    const dur = currentClip.duration;
    let opacity = 1.0;
    
    if (currentClip.fadeIn > 0 && t < currentClip.fadeIn) {
      opacity = t / currentClip.fadeIn;
    } else if (currentClip.fadeOut > 0 && t > (dur - currentClip.fadeOut)) {
      opacity = (dur - t) / currentClip.fadeOut;
    }
    front.style.opacity = Math.max(0, Math.min(1, opacity));
    // --------------------

    const endTime = currentClip.startTime + currentClip.duration;

    // --- PRELOAD NEXT CLIP ---
    const timeRemaining = endTime - globalTime;
    if (timeRemaining < 2.0 && timeRemaining > 0) { // Start preloading 2 seconds before
        const nextClip = findClipAtTime(endTime + 0.05);
        if (nextClip && nextClip.id !== currentClip.id) {
             if (window.preloadNextClip) window.preloadNextClip(nextClip);
        }
    }
    // -------------------------

    // Cutoff / Transition logic
    if (globalTime >= endTime) {
      const nextClip = findClipAtTime(endTime + 0.01);
      
      if (nextClip) {
        const eps = 0.001;
        globalTime = Math.max(globalTime, nextClip.startTime + eps);
        tickPlayback();
        return; 
      }

      try { front.pause(); } catch { }
      front.style.visibility = 'hidden';
      activeClipId = null;
      lastGapTime = performance.now();
      requestAnimationFrame(onGapFrame);
      return;
    }
  }
  
  setPlayheadPosition();
  ensurePlayheadVisibleEdge();

  front.requestVideoFrameCallback(onVideoFrame);
};

const onGapFrame = () => {
  if (!isPlaying) return;
  if (activeClipId) return;

  const now = performance.now();
  const dt = (now - lastGapTime) / 1000;
  lastGapTime = now;

  globalTime += dt;

  updateAudioMix(globalTime);
  setPlayheadPosition();
  ensurePlayheadVisibleEdge();

  const vid = findClipAtTime(globalTime);
  if (vid) {
    tickPlayback();
    return;
  }

  let maxEnd = 0;
  for (const c of clips) {
    maxEnd = Math.max(maxEnd, c.startTime + c.duration);
  }

  if (globalTime > maxEnd + 1.0) {
    stopPlayback();
    return;
  }

  requestAnimationFrame(onGapFrame);
};

function stopPlayback() {
  isPlaying = false;
  playPauseBtn.textContent = "\u25B6"; // Play icon
  stopCanvasDrawLoop();
  stopPreviewMix();

  try { front.pause(); } catch { }
  try { back.pause(); } catch { }

  if (pauseAtPlayhead) {
    playbackStartTime = globalTime;
  } else {
    globalTime = playbackStartTime;
  }
  setPlayheadPosition();
  routePreviewToTime(globalTime, { forceSeek: true });
}

// -------------------- Event Listeners --------------------

if (typeof playPauseBtn !== "undefined") {
  playPauseBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (isPlaying) {
      stopPlayback();
    } else {
      // Immediate UI update
      playPauseBtn.textContent = "||";
      // Use requestAnimationFrame to let UI paint before work starts
      requestAnimationFrame(() => startPlayback());
    }
  };
} else {
  console.error("playPauseBtn is not defined");
}
