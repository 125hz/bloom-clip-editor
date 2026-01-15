// keyboard.js - Handles keyboard shortcuts

function preventSpaceScroll(e) { if (e.code === "Space") e.preventDefault(); }
window.addEventListener("keydown", preventSpaceScroll);

// Helper: Selects the closest clip to the LEFT of the playhead
function selectClipLeftOfPlayhead() {
  const epsilon = 0.05; 
  const candidates = clips.filter(c => (c.startTime + c.duration) <= globalTime + epsilon);

  if (candidates.length === 0) return;

  // Sort: End Time DESC (closest to playhead first)
  candidates.sort((a, b) => (b.startTime + b.duration) - (a.startTime + a.duration));

  let bestMatch = null;
  if (selectedClipId) {
    const current = clips.find(c => c.id === selectedClipId);
    if (current) bestMatch = candidates.find(c => c.type === current.type);
  }

  if (!bestMatch) bestMatch = candidates[0];

  if (bestMatch) {
    selectedClipId = bestMatch.id;
    renderTimeline();
  }
}

// Helper: Selects the closest clip to the RIGHT of the playhead (or currently under it)
function selectClipRightOfPlayhead() {
  const epsilon = 0.05;
  const candidates = clips.filter(c => (c.startTime + c.duration) > globalTime + epsilon);

  if (candidates.length === 0) return;

  // Sort: Start Time ASC (closest to playhead first)
  candidates.sort((a, b) => a.startTime - b.startTime);

  let bestMatch = null;
  if (selectedClipId) {
    const current = clips.find(c => c.id === selectedClipId);
    if (current) bestMatch = candidates.find(c => c.type === current.type);
  }

  if (!bestMatch) bestMatch = candidates[0];

  if (bestMatch) {
    selectedClipId = bestMatch.id;
    renderTimeline();
  }
}

window.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;

  // Undo / Redo
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey && e.key.toLowerCase() === "y") || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z")) {
    e.preventDefault(); redo(); return;
  }

  // Export Shortcut (Ctrl + M)
  if (e.ctrlKey && e.key.toLowerCase() === "m") {
    e.preventDefault();
    exportBtn.click();
    return;
  }

  if (e.code === "Space") { e.preventDefault(); isPlaying ? stopPlayback() : startPlayback(); }
  else if (e.key.toLowerCase() === "s") splitAtPlayhead();
  
  // Q = Highlight Left
  else if (e.key.toLowerCase() === "q") selectClipLeftOfPlayhead();
  
  // E = Highlight Right
  else if (e.key.toLowerCase() === "e") selectClipRightOfPlayhead();
  
  else if (e.key === "Delete" || e.key === "Backspace" || e.key.toLowerCase() === "d") deleteSelected();
  
  // Go back one frame
  else if (e.key === "ArrowLeft") {
    e.preventDefault();

    const active = findClipAtTime(globalTime) || clips.find(c => c.id === selectedClipId) || null;
    const fps = (active && active.fps && active.fps > 0) ? active.fps : 60;
    const frameIdx = Math.round(globalTime * fps);
    const nextT = (frameIdx - 1) / fps;

    globalTime = clamp(nextT, 0, getTimelineViewEnd());
    playbackStartTime = globalTime;

    setPlayheadPosition();
    setGhostPlayheadPosition();
    ensurePlayheadVisibleEdge();
    routePreviewToTime(globalTime, { forceSeek: true });
  } 
  
  // Go forward one frame
  else if (e.key === "ArrowRight") {
    e.preventDefault();
    const active = findClipAtTime(globalTime) || clips.find(c => c.id === selectedClipId) || null;
    const fps = (active && active.fps && active.fps > 0) ? active.fps : 60;
    const frameIdx = Math.round(globalTime * fps);
    const nextT = (frameIdx + 1) / fps;
    globalTime = clamp(nextT, 0, getTimelineViewEnd());
    playbackStartTime = globalTime;
    setPlayheadPosition();
    setGhostPlayheadPosition();
    ensurePlayheadVisibleEdge();
    routePreviewToTime(globalTime, { forceSeek: true });
  }
});
