// timeline_rendering.js - handles timeline rendering

let _timelineRenderRaf = null;

// requestRenderTimeline - requests a timeline render
function requestRenderTimeline() {
  if (_timelineRenderRaf) return;
  _timelineRenderRaf = requestAnimationFrame(() => {
    _timelineRenderRaf = null;
    renderTimeline();
  });
}

// Lightweight selection update that does NOT force a full re-render.
function setSelectedClipId(nextId) {
  selectedClipId = nextId;
  const nodes = tracksArea.querySelectorAll(".clip-container");
  nodes.forEach((el) => {
    const isSel = el.dataset.clipId === String(nextId);
    el.classList.toggle("selected", isSel);
  });
}

// renderRuler - renders the timeline ruler above the timeline
function renderRuler() {
  timelineRuler.innerHTML = "";
  
  const end = getTimelineViewEnd();
  const totalWidth = Math.ceil(end * pixelsPerSecond);
  
  timelineRuler.style.width = ""; 
  
  const spacer = document.createElement("div");
  spacer.style.height = "1px";
  spacer.style.width = `${totalWidth}px`;
  spacer.style.position = "absolute";
  spacer.style.top = "0";
  spacer.style.left = "0";
  spacer.style.pointerEvents = "none";
  spacer.style.visibility = "hidden";
  timelineRuler.appendChild(spacer);

  for (let t = 0; t <= end; t += 1) {
    const x = t * pixelsPerSecond;
    const mark = document.createElement("div");
    mark.className = "ruler-mark";
    if (t % 5 === 0) mark.classList.add("major");

    mark.style.left = `${x}px`;
    timelineRuler.appendChild(mark);

    if (t % 5 === 0) {
      const label = document.createElement("div");
      label.className = "ruler-label";
      label.style.left = `${x}px`;
      label.textContent = formatTime(t).split(".")[0];
      timelineRuler.appendChild(label);
    }
  }
}

window.renderRuler = renderRuler;

// _clipDomById - cache of clip DOM elements
const _clipDomById = new Map();

// _lookupClipById - looks up a clip by ID
function _lookupClipById(id) {
  return clips.find((c) => c.id === id) || null;
}

// _clearStaleClipDom - clears stale clip DOM elements
function _clearStaleClipDom(liveIds) {
  for (const [id, el] of _clipDomById.entries()) {
    if (!liveIds.has(id)) {
      try { el.remove(); } catch {}
      _clipDomById.delete(id);
    }
  }
}

// _drawWaveformCanvas - draws a waveform canvas for audio tracks
function _drawWaveformCanvas(canvas, peaks, widthPx, heightPx) {
  if (!canvas || !peaks || !peaks.length) return;
  if (canvas.width !== widthPx) canvas.width = widthPx;
  if (canvas.height !== heightPx) canvas.height = heightPx;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";

  const barW = widthPx / peaks.length;
  for (let j = 0; j < peaks.length; j++) {
    const val = peaks[j];
    const barH = Math.max(1, val * heightPx);
    const y = (heightPx - barH) / 2;
    const drawW = barW > 2 ? barW - 1 : barW;
    ctx.fillRect(j * barW, y, drawW, barH);
  }
}

// _createClipDom - creates a DOM element for a clip
function _createClipDom(clip) {
  const container = document.createElement("div");
  container.className = "clip-container";
  container.dataset.clipId = clip.id;

  // --- Video layer ---
  let videoPart = null;
  let thumbImg = null;
  let titleSpan = null;

  if (clip.type !== "audio") {
    videoPart = document.createElement("div");
    videoPart.className = "clip-video";

    thumbImg = document.createElement("img");
    thumbImg.className = "clip-thumbnail";
    videoPart.appendChild(thumbImg);

    titleSpan = document.createElement("span");
    titleSpan.className = "clip-title";
    videoPart.appendChild(titleSpan);

    container.appendChild(videoPart);
  }

  // --- Audio tracks ---
  const audioTracks = Array.isArray(clip.audioTracks) && clip.audioTracks.length
    ? clip.audioTracks
    : [{ label: "Audio", enabled: true, waveformPeaks: null, volume: 1.0 }];

  const audioRefs = [];

  audioTracks.forEach((tr, i) => {
    const audioPart = document.createElement("div");
    audioPart.className = "clip-audio" + (audioTracks.length > 1 ? " track" : "");

    // Create wrapper for clipped visuals (waveform, vol line)
    const visualWrapper = document.createElement("div");
    visualWrapper.className = "clip-visual-wrapper";
    audioPart.appendChild(visualWrapper);

    const volContainer = document.createElement("div");
    volContainer.className = "vol-line-container";
    audioPart.appendChild(volContainer);

    const volHitArea = document.createElement("div");
    volHitArea.className = "vol-line-hit-area";

    const volTooltip = document.createElement("div");
    volTooltip.className = "vol-tooltip";
    volTooltip.style.display = "none";
    volContainer.appendChild(volTooltip);

    const volLine = document.createElement("div");
    volLine.className = "vol-line";
    visualWrapper.appendChild(volLine);

    const updateVolVisual = (vol) => {
      const pct = (1 - (vol / 2.0)) * 100;
      const topVal = `${clamp(pct, 0, 100)}%`;
      volLine.style.top = topVal;
      volHitArea.style.top = topVal;
      
      // Update custom tooltip text
      volTooltip.textContent = `${Math.round(vol * 100)}%`;
      volTooltip.style.top = topVal;
      volTooltip.style.left = "50%";
    };

    updateVolVisual(tr.volume ?? 1.0);

    const startVolDrag = (e) => {
       e.preventDefault(); e.stopPropagation();
       const startY = e.clientY;
       const id = container.dataset.clipId;
       const liveClip = _lookupClipById(id);
       if (!liveClip) return;
       const liveTracks = Array.isArray(liveClip.audioTracks) && liveClip.audioTracks.length ? liveClip.audioTracks : [{ label: "Audio", enabled: true, waveformPeaks: null, volume: 1.0 }];
       const liveTr = liveTracks[i];
       const startVol = liveTr?.volume ?? 1.0;
       
       // Show tooltip on drag start
       volTooltip.style.display = "block";
       
       const onMove = (ev) => {
         const dy = startY - ev.clientY;
         const id2 = container.dataset.clipId;
         const c2 = _lookupClipById(id2);
         if (!c2) return;
         const t2 = (Array.isArray(c2.audioTracks) && c2.audioTracks.length) ? c2.audioTracks[i] : null;
         if (!t2) return;
         
         // Sensitivity: 100px = 1.0 volume change (100%)
         const newVol = clamp(startVol + dy / 100.0, 0, 2.0);
         t2.volume = newVol;
         updateVolVisual(newVol);
         if (isPlaying) updateAudioMix(globalTime);
       };
       const onUp = () => { 
         // Hide tooltip on drag end
         volTooltip.style.display = "none";
         window.removeEventListener("mousemove", onMove); 
         window.removeEventListener("mouseup", onUp); 
       };
       window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    };

    // Double click to reset
    volHitArea.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const id = container.dataset.clipId;
      const liveClip = _lookupClipById(id);
      if (!liveClip) return;
      const liveTracks = Array.isArray(liveClip.audioTracks) && liveClip.audioTracks.length ? liveClip.audioTracks : [{ label: "Audio", enabled: true, waveformPeaks: null, volume: 1.0 }];
      const liveTr = liveTracks[i];
      if (liveTr) {
        liveTr.volume = 1.0;
        updateVolVisual(1.0);
        if (isPlaying) updateAudioMix(globalTime);
      }
    });

    volHitArea.addEventListener("mousedown", startVolDrag);
    volContainer.appendChild(volHitArea);
    
    const canvas = document.createElement("canvas");
    canvas.className = "audio-waveform-canvas";
    visualWrapper.appendChild(canvas);

    container.appendChild(audioPart);
    audioRefs.push({ audioPart, canvas, updateVolVisual, trackIndex: i });
  });

  // --- Handles Logic ---
  if (clip.type === "audio") container.classList.add("audio-only");

  let leftHandle = document.createElement("div");
  leftHandle.className = "resize-handle left";
  let rightHandle = document.createElement("div");
  rightHandle.className = "resize-handle right";
  container.appendChild(leftHandle);
  container.appendChild(rightHandle);

    // --- FADE HANDLES & LOGIC ---
    const fadeOverlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    fadeOverlay.setAttribute("class", "fade-overlay-svg");
    const fadePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    fadePath.setAttribute("class", "fade-line");
    fadeOverlay.appendChild(fadePath);
    container.appendChild(fadeOverlay);

    const fadeHandleLeft = document.createElement("div");
    fadeHandleLeft.className = "fade-handle left";
    container.appendChild(fadeHandleLeft);
    
    const fadeHandleRight = document.createElement("div");
    fadeHandleRight.className = "fade-handle right";
    container.appendChild(fadeHandleRight);

    const startFadeDrag = (e, isLeft) => {
        e.preventDefault(); e.stopPropagation();
        if (isPlaying) return;
        const startX = e.clientX;
        const clipId = container.dataset.clipId;
        const liveClip = _lookupClipById(clipId);
        if (!liveClip) return;
        
        const initialFade = isLeft ? (liveClip.fadeIn || 0) : (liveClip.fadeOut || 0);
        
        const onFadeMove = (ev) => {
            const dx = (ev.clientX - startX) / pixelsPerSecond;
            const buffer = 0.2; // Keep handle slightly away from edge to avoid overlap with resize handle
            if (isLeft) {
                const maxFade = Math.max(0, liveClip.duration - (liveClip.fadeOut || 0) - buffer);
                liveClip.fadeIn = clamp(initialFade + dx, 0, maxFade);
            } else {
                // Dragging left (negative dx) increases fadeOut
                const maxFade = Math.max(0, liveClip.duration - (liveClip.fadeIn || 0) - buffer);
                liveClip.fadeOut = clamp(initialFade - dx, 0, maxFade);
            }
            _updateClipDom(container, liveClip);
            if (isPlaying) updateAudioMix(globalTime);
            routePreviewToTime(globalTime);
        };
        
        const onFadeUp = () => {
            window.removeEventListener("mousemove", onFadeMove);
            window.removeEventListener("mouseup", onFadeUp);
            requestSave();
        };
        window.addEventListener("mousemove", onFadeMove);
        window.addEventListener("mouseup", onFadeUp);
    };

    fadeHandleLeft.addEventListener("mousedown", (e) => startFadeDrag(e, true));
    fadeHandleRight.addEventListener("mousedown", (e) => startFadeDrag(e, false));

  leftHandle.addEventListener("mousedown", (e) => {
    e.stopPropagation(); if (isPlaying) return;
    const id = container.dataset.clipId; if (id) setSelectedClipId(id);
    const liveClip = _lookupClipById(id); if (liveClip) startTrimLeft(e, liveClip);
  });
  rightHandle.addEventListener("mousedown", (e) => {
    e.stopPropagation(); if (isPlaying) return;
    const id = container.dataset.clipId; if (id) setSelectedClipId(id);
    const liveClip = _lookupClipById(id); if (liveClip) startTrimRight(e, liveClip);
  });

  container.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || isPlaying) return;
    if (e.target.closest(".vol-bar-container") || e.target.closest(".resize-handle")) return;
    const id = container.dataset.clipId; if (id) setSelectedClipId(id);
    const liveClip = _lookupClipById(id); if (liveClip) startDragClip(e, liveClip);
  });

  container.addEventListener("dblclick", async (e) => {
    if (e.target.closest(".vol-bar-container") || e.target.closest(".resize-handle")) return;
    const id = container.dataset.clipId;
    const liveClip = _lookupClipById(id);
    if (!liveClip) return;
    playbackStartTime = liveClip.startTime;
    setGhostPlayheadPosition();
    setSelectedClipId(id);
    if (!isPlaying) {
      globalTime = liveClip.startTime;
      setPlayheadPosition();
      ensurePlayheadVisibleEdge();
      await routePreviewToTime(globalTime, { forceSeek: true });
    }
  });

  container._refs = { videoPart, thumbImg, titleSpan, audioRefs, leftHandle, rightHandle };
  return container;
}

// _updateClipDom - updates the DOM for a clip
function _updateClipDom(container, clip) {
  container.classList.toggle("selected", clip.id === selectedClipId);

  // Update basic dimensions
  const scale = pixelsPerSecond;
  const left = clip.startTime * scale;
  const width = clip.duration * scale;
  container.style.left = `${left}px`;
  container.style.width = `${width}px`;
  
  // Height and top
  let heightPx = 0;
  if (clip.type === 'video') {
    // Base video height + audio tracks height
    const numAudio = (clip.audioTracks && clip.audioTracks.length) ? clip.audioTracks.length : 0;
    // Video part: 45px. Audio part: 34px per track.
    heightPx = 45 + (numAudio * 34);
    
    container.style.top = `${30 + (clip.trackIndex * 50)}px`;
    container.style.height = `${heightPx}px`;
  } else {
    heightPx = 34; // Sync with CSS
    // Audio tracks stack below video area (approx 30 + 3*50 = 180)
    container.style.top = `${130 + (clip.laneIndex * 39)}px`; // 39 = 34 + 5 gap
    container.style.height = `${heightPx}px`;
  }

  // --- RENDER FADES ---
  let fadeOverlay = container.querySelector(".fade-overlay-svg");
  let fadePath = container.querySelector(".fade-line");
  let fadeHandleLeft = container.querySelector(".fade-handle.left");
  let fadeHandleRight = container.querySelector(".fade-handle.right");

  // lazy creation logic was here
  // if (container && !container.querySelector('.fade-handle')) {
  //    container.remove();
  //    _clipDomById.delete(clip.id);
  //    container = null; 
  // }
  // if (!container) { ... create ... }


  if (fadeOverlay && fadePath) {
    const fadeInW = (clip.fadeIn || 0) * scale;
    const fadeOutW = (clip.fadeOut || 0) * scale;
    const h = heightPx;
    const w = width;

    let pathD = "";
    if (clip.fadeIn > 0) {
      pathD += `M 0,${h} L ${fadeInW},0 `;
    }
    if (clip.fadeOut > 0) {
      pathD += `M ${w - fadeOutW},0 L ${w},${h}`;
    }
    fadePath.setAttribute("d", pathD);

    // Position handles
    if (fadeHandleLeft) {
      fadeHandleLeft.style.left = `${fadeInW}px`; 
      // Always show handle
      fadeHandleLeft.style.display = "block";
    }
    if (fadeHandleRight) {
    if (fadeHandleRight) {
      fadeHandleRight.style.right = ""; // Clear right style
      fadeHandleRight.style.left = `${w - fadeOutW}px`; 
      fadeHandleRight.style.display = "block";
    }
    }
  }

  // --- END Render Fades ---

  const r = container._refs || {};

  if (clip.type !== "audio" && r.videoPart) {
    const baseName = clip.filePath ? clip.filePath.split(/[\\/]/).pop() : "clip";
    if (r.titleSpan) r.titleSpan.textContent = baseName;
    if (r.thumbImg) {
       if (clip.thumbnailUrl) { r.thumbImg.src = clip.thumbnailUrl; r.thumbImg.style.display = ""; }
       else { r.thumbImg.style.display = "none"; }
    }
  }

  const audioTracks = Array.isArray(clip.audioTracks) && clip.audioTracks.length ? clip.audioTracks : [{ label: "Audio", enabled: true, waveformPeaks: null, volume: 1.0 }];
  if (r.audioRefs && r.audioRefs.length) {
    r.audioRefs.forEach((ar) => {
      const tr = audioTracks[ar.trackIndex];
      const vol = tr?.volume ?? 1.0;
      if (ar.updateVolVisual) ar.updateVolVisual(vol);
      const widthPx = Math.ceil(clip.duration * pixelsPerSecond);
      const heightPx = 34; // All audio tracks now uniform height
      const peaks = tr?.waveformPeaks || null;
      if (peaks && peaks.length) {
        _drawWaveformCanvas(ar.canvas, peaks, widthPx, heightPx);
        ar.canvas.style.display = "";
      } else { if (ar.canvas) ar.canvas.style.display = "none"; }
    });
  }
}

// renderTimeline - renders all timeline elements
function renderTimeline() {
  // 1. Render Ruler
  renderRuler(); 
  
  const end = getTimelineViewEnd();
  const totalWidth = Math.ceil(end * pixelsPerSecond);

  // 2. Manage Tracks Area Spacer
  let spacer = tracksArea.querySelector("#timeline-spacer");
  if (!spacer) {
    spacer = document.createElement("div");
    spacer.id = "timeline-spacer";
    spacer.style.height = "1px";
    spacer.style.width = `${totalWidth}px`;
    spacer.style.opacity = "0";
    spacer.style.pointerEvents = "none";
    spacer.style.position = "absolute";
    spacer.style.top = "0";
    spacer.style.left = "0";
    spacer.style.zIndex = "-10";
    tracksArea.appendChild(spacer);
  } else {
    spacer.style.width = `${totalWidth}px`;
  }

  // 3. Audio Lane Allocator & Clip Rendering
  const audioClips = clips.filter(c => c.type === 'audio').sort((a, b) => a.startTime - b.startTime);
  const lanes = [];
  audioClips.forEach(c => {
    let placed = false;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] <= c.startTime + 0.05) {
        c.laneIndex = i;
        lanes[i] = c.startTime + c.duration;
        placed = true;
        break;
      }
    }
    if (!placed) {
      c.laneIndex = lanes.length;
      lanes.push(c.startTime + c.duration);
    }
  });

  const liveIds = new Set();
  const frag = document.createDocumentFragment();

  for (const clip of clips) {
    liveIds.add(clip.id);
    let container = _clipDomById.get(clip.id);
    if (!container) {
      container = _createClipDom(clip);
      _clipDomById.set(clip.id, container);
    }
    _updateClipDom(container, clip);
    frag.appendChild(container);
  }

  tracksArea.insertBefore(frag, ghostPlayhead);
  _clearStaleClipDom(liveIds);
  updatePlayhead();

  if (tracksArea.scrollLeft !== timelineRuler.scrollLeft) {
      timelineRuler.scrollLeft = tracksArea.scrollLeft;
  }
}