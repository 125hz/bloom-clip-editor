// split_delete.js - handles splitting and deleting clips

// splitAtPlayhead - splits the clip at the playhead
function splitAtPlayhead() {
  let clipToSplit = null;

  if (selectedClipId) {
    const selected = clips.find(c => c.id === selectedClipId);
    if (selected && globalTime > selected.startTime && globalTime < selected.startTime + selected.duration) {
      clipToSplit = selected;
    }
  }

  if (!clipToSplit) {
    clipToSplit = findClipAtTime(globalTime);
  }

  if (!clipToSplit) {
    const audios = clips.filter(c => c.type === 'audio' && globalTime > c.startTime && globalTime < c.startTime + c.duration);
    if (audios.length > 0) clipToSplit = audios[0];
  }

  if (!clipToSplit) return;

  const clip = clipToSplit;
  const offset = globalTime - clip.startTime;
  if (offset <= MIN_CLIP_DURATION || offset >= clip.duration - MIN_CLIP_DURATION) {
    console.warn("Split too close to edge, ignored.");
    return;
  }

  pushHistory();

  const left = clip;
  const right = {
    ...clip,
    id: uid(),
    startTime: globalTime,
    inPoint: clip.inPoint + offset,
    duration: clip.duration - offset,
    audioTracks: (clip.audioTracks || []).map((t) => ({ ...t })),
    thumbnailUrl: clip.thumbnailUrl
  };

  left.duration = offset;
  
  // --- FADE SPLIT LOGIC ---
  left.fadeOut = 0; 
  right.fadeIn = 0;
  // ------------------------

  const idx = clips.findIndex((c) => c.id === left.id);
  clips.splice(idx + 1, 0, right);
  selectedClipId = right.id;

  Promise.resolve()
    .then(() => refreshClipWaveforms(left))
    .then(() => refreshClipWaveforms(right))
    .then(() => renderTimeline());
}

// deleteSelected - deletes the selected clip
function deleteSelected() {
  if (!selectedClipId) return;
  const idx = clips.findIndex((c) => c.id === selectedClipId);
  if (idx === -1) return;

  pushHistory();

  const deletedClip = clips[idx];
  const wasActive = activeClipId === selectedClipId;
  clips.splice(idx, 1);
  selectedClipId = null;

  if (magneticSnapping && deletedClip.type !== 'audio') {
    const videoClips = clips.filter(c => c.type !== 'audio').sort((a, b) => a.startTime - b.startTime);
    let cursor = 0;
    for (const c of videoClips) {
      c.startTime = cursor;
      cursor += c.duration;
    }
  }

  renderTimeline();

  if (wasActive) {
    activeClipId = null;
    routePreviewToTime(globalTime, { forceSeek: true });
  }
}
