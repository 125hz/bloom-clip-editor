// route_preview.js - Handles routing of video clips
// this file is a mess too

let preloadedClipId = null;

// preloadNextClip - Preloads the next clip for smooth playback
function preloadNextClip(clip) {
    if (!clip || clip.id === activeClipId || clip.id === preloadedClipId) return;
    if (isSeeking) return;

    preloadedClipId = clip.id;
    back.src = clip.fileUrl;
    back.muted = true;
    back.preload = "auto";
    back.load();
    
    // Attempt to buffer the start
    const onMeta = () => {
        if (preloadedClipId !== clip.id) return;
        back.currentTime = clip.inPoint;
    };
    back.addEventListener("loadedmetadata", onMeta, { once: true });
}
// Expose globally
window.preloadNextClip = function(clip) {
    if (!clip || clip.id === activeClipId || clip.id === preloadedClipId) return;
    if (isSeeking) return;

    preloadedClipId = clip.id;
    back.src = clip.fileUrl;
    back.muted = true;
    back.preload = "auto";
    back.currentTime = clip.inPoint;
};

// routePreviewToTime - Routes the preview to a specific time
async function routePreviewToTime(t, { forceSeek = false } = {}) {
  const myTicket = ++seekTicket;
  isSeeking = true;

  const clip = findClipAtTime(t);

  if (!clip) {
    if (myTicket === seekTicket) {
      setOverlayVisible(!scrubbing);
      stopPreviewMix();
      try { front.pause(); } catch { }
      activeClipId = null;
      if (!isPlaying) {
        front.style.visibility = 'hidden';
        back.style.visibility = 'hidden';
      }
      isSeeking = false;
    }
    return;
  }

  setOverlayVisible(false);

  const localTime = clip.inPoint + (t - clip.startTime);
  const fps = clip.fps || 60;

  // prevent loading the same clip multiple times
  const currentUrl = front._loadedUrl || front.getAttribute("src");
  const needNewSrc = (currentUrl !== clip.fileUrl);
  
  // always update active ID
  activeClipId = clip.id;

  // calculate opacity
  try {
    const timeInClip = t - clip.startTime;
    const dur = clip.duration;
    let op = 1.0;

    // handle fade in and fade out
    if (clip.fadeIn > 0 && timeInClip < clip.fadeIn) {
      op = timeInClip / clip.fadeIn;
    } else if (clip.fadeOut > 0 && timeInClip > (dur - clip.fadeOut)) {
      op = (dur - timeInClip) / clip.fadeOut;
    }
    op = Math.max(0, Math.min(1, op));

    if (needNewSrc) {
      const isPreloaded = (preloadedClipId === clip.id);
      preloadedClipId = null;


      try { back.pause(); } catch { }
      if (isPreloaded && back.src.indexOf(clip.fileUrl) !== -1 && back.readyState >= 2) {
         back.style.opacity = op;
         back.muted = true;
         back._loadedUrl = clip.fileUrl;
         
         if (Math.abs(back.currentTime - localTime) > 0.2) {
             back.currentTime = safeSeekTime(localTime, back.duration || clip.duration, fps);
         }
         
         await swapFrontBack();
         
         if (!isPlaying && previewCanvas.style.display !== 'none') {
             requestAnimationFrame(drawCanvasFrame);
         }
         return; 
      }

      let ready = false;
      if (isPreloaded && back.src.indexOf(clip.fileUrl) !== -1) {
          ready = true;
      } else {
          back.src = clip.fileUrl;
          back.load();
      }
      back._loadedUrl = clip.fileUrl; // track URL
      
      back.style.opacity = op; 
      back.muted = true; 
      
      if (!ready || back.readyState < 1) { 
          await once(back, "loadedmetadata");
      }
      
      if (myTicket !== seekTicket) return;

      setPreviewAspectFromFirstClip(back.videoWidth, back.videoHeight);

      const desired = safeSeekTime(localTime, back.duration || clip.sourceDuration || clip.duration, fps);
      
      if (Math.abs(back.currentTime - desired) > 0.05) {
          back.currentTime = desired;
          await once(back, "seeked");
      }

      if (myTicket !== seekTicket) return;
      
      if (back.requestVideoFrameCallback) {
         await new Promise(resolve => {
          let resolved = false;
          const handle = back.requestVideoFrameCallback(() => {
            if (!resolved) { resolved = true; resolve(); }
          });
          setTimeout(() => {
            if (!resolved) { back.cancelVideoFrameCallback(handle); resolved = true; resolve(); }
          }, 50);
        });
      }

      if (myTicket !== seekTicket) return;

      await swapFrontBack();
      if (!isPlaying) requestAnimationFrame(drawCanvasFrame);

    } else {
      const desired = safeSeekTime(localTime, front.duration || clip.sourceDuration || clip.duration, fps);
      front.style.opacity = op; 
      
      const diff = Math.abs((front.currentTime || 0) - desired);
      if (diff > 0.05) {
        front.currentTime = desired;
        if (!isPlaying && previewCanvas.style.display !== 'none') {
          front.addEventListener('seeked', () => {
            if (myTicket === seekTicket) drawCanvasFrame();
          }, { once: true });
        }
      }
    }

    applyPreviewQuality();

    if (!isPlaying) {
      front.muted = true;
      stopPreviewMix();
    } else {
      front.muted = true;
      stopPreviewMix();
    }
  } finally {
    if (myTicket === seekTicket) isSeeking = false;
  }
}
