// waveform_decoding.js - Waveform decoding

let waveformDecodeCtx = null;

// getWaveformDecodeCtx - Gets the waveform decode context
function getWaveformDecodeCtx() {
  if (waveformDecodeCtx) return waveformDecodeCtx;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  waveformDecodeCtx = new AudioCtx();

  window.addEventListener("beforeunload", () => {
    try { waveformDecodeCtx && waveformDecodeCtx.close(); } catch { }
    waveformDecodeCtx = null;
  }, { once: true });

  return waveformDecodeCtx;
}

// loadWaveformBuffer - Loads the waveform buffer
async function loadWaveformBuffer(extractedUrl) {
  if (waveformCache.has(extractedUrl)) return waveformCache.get(extractedUrl);

  // Cache entry includes decoded buffer + bytes + peaks cache
  const entry = { audioBuffer: null, arrayBuffer: null, peaksCache: new Map() };
  waveformCache.set(extractedUrl, entry);

  try {
    const res = await fetch(extractedUrl);
    const buf = await res.arrayBuffer();
    entry.arrayBuffer = buf;

    const ctx = getWaveformDecodeCtx();
    entry.audioBuffer = await ctx.decodeAudioData(buf.slice(0));

    return entry;
  } catch (e) {
    waveformCache.delete(extractedUrl);
    throw e;
  }
}

// getWaveformCacheEntry - Gets the waveform cache entry
function getWaveformCacheEntry(extractedUrl) {
  return waveformCache.get(extractedUrl);
}
window.getWaveformCacheEntry = getWaveformCacheEntry;

// desiredWaveformBarsForClip - Gets the desired waveform bars for a clip
function desiredWaveformBarsForClip(clip) {
  return Math.max(100, Math.floor(clip.duration * 50));
}

// computeWaveformPeaksForSegment - Computes the waveform peaks for a segment
async function computeWaveformPeaksForSegment(extractedUrl, inPoint, duration, bars) {
  try {
    const entry = await loadWaveformBuffer(extractedUrl);

    const nBars = clamp(bars, 2, 4000);
    const key = `${inPoint}|${duration}|${nBars}`;
    if (entry.peaksCache.has(key)) return entry.peaksCache.get(key);

    const audioBuffer = entry.audioBuffer;
    const sr = audioBuffer.sampleRate;
    const startSample = Math.floor(clamp(inPoint, 0, audioBuffer.duration) * sr);
    const endSample = Math.floor(clamp(inPoint + duration, 0, audioBuffer.duration) * sr);
    const n = Math.max(1, endSample - startSample);

    const channels = audioBuffer.numberOfChannels || 1;
    const samplesPerBar = Math.max(1, Math.floor(n / nBars));
    const peaks = new Array(nBars).fill(0);

    for (let i = 0; i < nBars; i++) {
      const s0 = startSample + i * samplesPerBar;
      const s1 = Math.min(endSample, s0 + samplesPerBar);

      let sumSq = 0;
      let count = 0;

      for (let ch = 0; ch < channels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let s = s0; s < s1; s++) {
          const v = data[s] || 0;
          sumSq += v * v;
          count++;
        }
      }

      const rms = count ? Math.sqrt(sumSq / count) : 0;
      peaks[i] = clamp(rms, 0, 1);
    }

    const max = Math.max(...peaks, 1e-6);
    for (let i = 0; i < peaks.length; i++) {
      const nrm = peaks[i] / max;
      peaks[i] = Math.pow(nrm, 0.65);
    }

    entry.peaksCache.set(key, peaks);
    return peaks;
  } catch {
    return null;
  }
}

// refreshClipWaveforms - Refreshes the waveform for a clip
async function refreshClipWaveforms(clip) {
  for (const tr of clip.audioTracks || []) {
    if (!tr.extractedUrl) continue;
    const bars = desiredWaveformBarsForClip(clip);
    tr.waveformBars = bars;
    tr.waveformPeaks = await computeWaveformPeaksForSegment(tr.extractedUrl, clip.inPoint, clip.duration, bars);
  }
}

// refreshAllWaveforms - Refreshes the waveform for all clips
async function refreshAllWaveforms() {
  const concurrency = 4;
  const queue = clips.slice();
  const workers = [];

  async function worker() {
    while (queue.length) {
      const c = queue.shift();
      if (!c) return;
      await refreshClipWaveforms(c);
    }
  }

  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
}
