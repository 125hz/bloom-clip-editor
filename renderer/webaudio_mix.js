// webaudio_mix.js - plays audio tracks in real-time

// ensureAudioCtx - Ensures the audio context is initialized
function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  return audioCtx;
}

// stopPreviewMix - Stops the preview mix
function stopPreviewMix() {
  for (const s of previewMix.sources) { try { s.stop(); } catch { } try { s.disconnect(); } catch { } }
  previewMix.sources = [];
  if (previewMix.masterGain) { try { previewMix.masterGain.disconnect(); } catch { } }
  previewMix.masterGain = null;
  previewMix.activeIds = [];
  previewMix.playing = false;
  lastMixKey = "";
}

// makeMixKey - Creates a mix key for the given clips
function makeMixKey(activeClips) {
  return activeClips.map(c => {
    const vol = c.audioTracks.map(t => t.volume).join(',');
    return `${c.id}:${vol}`;
  }).join('|');
}

let pendingMixKey = null;

async function updateAudioMix(timelineTime) {
  const activeClips = findClipsAtTime(timelineTime);
  const key = makeMixKey(activeClips);

  // If the audio is already playing/loading for this exact clip setup, do nothing.
  if (key === lastMixKey) return;
  
  pendingMixKey = key;

  const ctx = ensureAudioCtx();
  
  if (ctx.state === "suspended") await ctx.resume();

  // --- PREPARE PHASE ---
  const newMaster = ctx.createGain();
  newMaster.gain.value = 1.0;
  newMaster.connect(ctx.destination);

  const preparedSources = [];
  let allCached = true;

  // Check if all needed assets are in cache
  for (const clip of activeClips) {
    const tracks = (clip.audioTracks || []).filter(t => t.enabled !== false && t.extractedUrl);
    for (const tr of tracks) {
        if (!window.getWaveformCacheEntry || !window.getWaveformCacheEntry(tr.extractedUrl)) {
            allCached = false;
        }
    }
  }
  // Build the audio graph
  const buildGraph = async (useAsyncLoad) => {
      for (const clip of activeClips) {
        const localTime = clip.inPoint + (timelineTime - clip.startTime);
        const offset = Math.max(0, localTime);
        const tracks = (clip.audioTracks || []).filter(t => t.enabled !== false && t.extractedUrl);

        for (const tr of tracks) {
          if (pendingMixKey !== key) return false;

          let buf = null;
          if (useAsyncLoad) {
               const entry = await loadWaveformBuffer(tr.extractedUrl);
               buf = entry.audioBuffer;
          } else {
               const entry = window.getWaveformCacheEntry(tr.extractedUrl);
               buf = entry ? entry.audioBuffer : null;
          }
          
          if (!buf) continue;

          const src = ctx.createBufferSource();
          src.buffer = buf;
          const g = ctx.createGain();
          
          // --- Gain / Fade Logic ---
          const volume = tr.volume !== undefined ? tr.volume : 1.0;
          const timeIntoClip = timelineTime - clip.startTime;
          const fadeInEnd = clip.fadeIn || 0;
          const fadeOutStart = clip.duration - (clip.fadeOut || 0);
          
          let startGain = volume;
          if (timeIntoClip < fadeInEnd) {
            startGain = volume * (timeIntoClip / fadeInEnd);
          } else if (timeIntoClip > fadeOutStart) {
            const remaining = clip.duration - timeIntoClip;
            startGain = volume * (remaining / (clip.duration - fadeOutStart));
          }
          g.gain.setValueAtTime(Math.max(0, startGain), ctx.currentTime);
          
          if (timeIntoClip < fadeInEnd) {
            const timeToFull = fadeInEnd - timeIntoClip;
            g.gain.linearRampToValueAtTime(volume, ctx.currentTime + timeToFull);
          }
          if (timeIntoClip < clip.duration) {
             if (timeIntoClip < fadeOutStart) {
               const timeToFadeStart = fadeOutStart - timeIntoClip;
               const timeToFadeEnd = clip.duration - timeIntoClip;
               g.gain.setValueAtTime(volume, ctx.currentTime + timeToFadeStart);
               g.gain.linearRampToValueAtTime(0, ctx.currentTime + timeToFadeEnd);
             } else {
               const timeToEnd = clip.duration - timeIntoClip;
               g.gain.linearRampToValueAtTime(0, ctx.currentTime + timeToEnd);
             }
          }

          src.connect(g);
          g.connect(newMaster);
          const safeOffset = Math.min(offset, Math.max(0, buf.duration - 0.01));
          preparedSources.push({ node: src, offset: safeOffset });
        }
      }
      return true;
  };

  // Execute the audio graph
  if (allCached) {
      for (const clip of activeClips) {
        const localTime = clip.inPoint + (timelineTime - clip.startTime);
        const offset = Math.max(0, localTime);
        const tracks = (clip.audioTracks || []).filter(t => t.enabled !== false && t.extractedUrl);

        for (const tr of tracks) {
           const entry = window.getWaveformCacheEntry(tr.extractedUrl);
           const buf = entry ? entry.audioBuffer : null;
           if (!buf) continue;

           const src = ctx.createBufferSource();
           src.buffer = buf;
           const g = ctx.createGain();
           
           const volume = tr.volume !== undefined ? tr.volume : 1.0;
           const timeIntoClip = timelineTime - clip.startTime;
           const fadeInEnd = clip.fadeIn || 0;
           const fadeOutStart = clip.duration - (clip.fadeOut || 0);
           
           let startGain = volume;
           if (timeIntoClip < fadeInEnd) {
             startGain = volume * (timeIntoClip / fadeInEnd);
           } else if (timeIntoClip > fadeOutStart) {
             const remaining = clip.duration - timeIntoClip;
             startGain = volume * (remaining / (clip.duration - fadeOutStart));
           }
           g.gain.setValueAtTime(Math.max(0, startGain), ctx.currentTime);
           
           if (timeIntoClip < fadeInEnd) {
             const timeToFull = fadeInEnd - timeIntoClip;
             g.gain.linearRampToValueAtTime(volume, ctx.currentTime + timeToFull);
           }
           if (timeIntoClip < clip.duration) {
              if (timeIntoClip < fadeOutStart) {
                const timeToFadeStart = fadeOutStart - timeIntoClip;
                const timeToFadeEnd = clip.duration - timeIntoClip;
                g.gain.setValueAtTime(volume, ctx.currentTime + timeToFadeStart);
                g.gain.linearRampToValueAtTime(0, ctx.currentTime + timeToFadeEnd);
              } else {
                const timeToEnd = clip.duration - timeIntoClip;
                g.gain.linearRampToValueAtTime(0, ctx.currentTime + timeToEnd);
              }
           }
           src.connect(g);
           g.connect(newMaster);
           const safeOffset = Math.min(offset, Math.max(0, buf.duration - 0.01));
           preparedSources.push({ node: src, offset: safeOffset });
        }
      }
      // Commit Sync
      if (pendingMixKey === key) {
        stopPreviewMix(); 
        lastMixKey = key;
        previewMix.activeIds = activeClips.map(c => c.id);
        previewMix.sources = preparedSources.map(p => p.node);
        previewMix.masterGain = newMaster;
        previewMix.playing = true;
        preparedSources.forEach(p => p.node.start(0, p.offset));
      }

  } else {
      // ASYNC PATH
      const success = await buildGraph(true);
      if (success && pendingMixKey === key) {
        stopPreviewMix();
        lastMixKey = key;
        previewMix.activeIds = activeClips.map(c => c.id);
        previewMix.sources = preparedSources.map(p => p.node);
        previewMix.masterGain = newMaster;
        previewMix.playing = true;
        preparedSources.forEach(p => p.node.start(0, p.offset));
      } else {
        preparedSources.forEach(p => { try { p.node.disconnect(); } catch {} });
        try { newMaster.disconnect(); } catch {}
      }
  }
}
