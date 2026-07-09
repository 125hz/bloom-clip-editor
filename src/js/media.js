// media.js - import pipeline: probe, audio extraction, decoding, waveform peaks.
//
// Waveform peaks are computed ONCE per source file at a fixed resolution and
// sliced per clip when drawing — trimming a clip never recomputes audio data.

import { invoke, convertFileSrc } from "./tauri.js";
import { state, emit, ensureTrack, tracksOfKind, clipsInTrack, pushHistory } from "./state.js";
import { uid, basename, MIN_CLIP_DURATION } from "./utils.js";

export const PEAKS_PER_SEC = 100;

// wavPath -> { audioBuffer, peaks: Float32Array, duration }
const audioCache = new Map();
let decodeCtx = null;

function getDecodeCtx() {
  if (!decodeCtx) decodeCtx = new AudioContext({ sampleRate: 48000 });
  return decodeCtx;
}

export function getAudioEntry(wavPath) {
  return audioCache.get(wavPath) || null;
}

export async function loadAudio(wavPath) {
  if (audioCache.has(wavPath)) return audioCache.get(wavPath);
  const promise = (async () => {
    const res = await fetch(convertFileSrc(wavPath));
    const raw = await res.arrayBuffer();
    const audioBuffer = await getDecodeCtx().decodeAudioData(raw);
    const peaks = computePeaks(audioBuffer);
    const entry = { audioBuffer, peaks, duration: audioBuffer.duration };
    audioCache.set(wavPath, entry);
    return entry;
  })();
  audioCache.set(wavPath, promise);
  try {
    return await promise;
  } catch (e) {
    audioCache.delete(wavPath);
    throw e;
  }
}

function computePeaks(buf) {
  const n = Math.ceil(buf.duration * PEAKS_PER_SEC);
  const peaks = new Float32Array(n);
  const channels = Math.min(2, buf.numberOfChannels);
  const spb = Math.floor(buf.sampleRate / PEAKS_PER_SEC);

  for (let ch = 0; ch < channels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const s0 = i * spb;
      const s1 = Math.min(data.length, s0 + spb);
      let sum = 0;
      // stride to keep import fast on long files; RMS estimate is fine visually
      const step = s1 - s0 > 256 ? 4 : 1;
      let count = 0;
      for (let s = s0; s < s1; s += step) {
        sum += data[s] * data[s];
        count++;
      }
      const rms = count ? Math.sqrt(sum / count) : 0;
      if (rms > peaks[i]) peaks[i] = rms;
    }
  }
  // normalize + perceptual curve
  let max = 1e-6;
  for (let i = 0; i < n; i++) max = Math.max(max, peaks[i]);
  for (let i = 0; i < n; i++) peaks[i] = Math.pow(peaks[i] / max, 0.65);
  return peaks;
}

function guessTrackLabel(stream, i) {
  const title = (stream.title || "").toLowerCase();
  if (title.includes("mic")) return "mic";
  if (title.includes("game") || title.includes("system") || title.includes("desktop")) return "game";
  return `a${i + 1}`;
}

const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|wma)$/i;

/// place a clip in the first gap at/after `want` inside a track
function placeInTrack(trackId, want, duration) {
  const others = clipsInTrack(trackId);
  let t = Math.max(0, want);
  for (const o of others) {
    if (t + duration <= o.startTime + 0.001) break;
    if (o.startTime + o.duration > t) t = o.startTime + o.duration;
  }
  return t;
}

export async function importFile(filePath) {
  const probe = await invoke("probe_media", { path: filePath });
  const isAudio = !probe.video || AUDIO_EXT.test(filePath);
  const duration = Math.max(MIN_CLIP_DURATION, Number(probe.duration) || 0);
  const fps = !isAudio && probe.video?.fps > 0 ? probe.video.fps : 60;

  if (!isAudio && !state.baseAspect && probe.video?.width && probe.video?.height) {
    state.baseAspect = { w: probe.video.width, h: probe.video.height };
    emit("aspect-changed");
  }

  const streams = probe.audioStreams || [];
  const audioTracks = (streams.length ? streams : [{ order: 0, index: 0 }]).map((s, i) => ({
    order: s.order ?? i,
    streamIndex: s.index ?? 0,
    label: isAudio ? "music" : guessTrackLabel(s, i),
    enabled: true,
    volume: 1.0,
    wavPath: null,
  }));

  let track, startTime;
  if (isAudio) {
    track = ensureTrack("audio");
    startTime = placeInTrack(track.id, state.time, duration);
  } else {
    const videoTracks = tracksOfKind("video");
    track = videoTracks[videoTracks.length - 1]; // bottom video track
    const existing = clipsInTrack(track.id);
    startTime = existing.length ? Math.max(...existing.map((c) => c.startTime + c.duration)) : 0;
  }

  const clip = {
    id: uid(),
    kind: isAudio ? "audio" : "video",
    trackId: track.id,
    filePath,
    fileUrl: convertFileSrc(filePath),
    startTime,
    inPoint: 0,
    duration,
    sourceDuration: duration,
    fps,
    fadeIn: 0,
    fadeOut: 0,
    speed: 1,
    opacity: 1,
    crop: { zoom: 1, cx: 0.5, cy: 0.5 },
    audioTracks: streams.length ? audioTracks : isAudio ? audioTracks : [],
    thumbnailUrl: null,
    text: null,
  };

  state.clips.push(clip);
  state.selectedId = clip.id;

  // extract + decode each unique audio stream (cached in Rust by file hash)
  const seen = new Map();
  for (const tr of clip.audioTracks) {
    try {
      if (!seen.has(tr.streamIndex)) {
        seen.set(tr.streamIndex, await invoke("extract_audio", {
          path: filePath,
          streamIndex: tr.streamIndex,
        }));
      }
      tr.wavPath = seen.get(tr.streamIndex);
      await loadAudio(tr.wavPath);
    } catch (e) {
      console.warn("audio extraction failed for stream", tr.streamIndex, e);
      tr.wavPath = null;
    }
  }

  if (!isAudio) {
    try {
      clip.thumbnailUrl = convertFileSrc(await invoke("generate_thumbnail", { path: filePath }));
    } catch {}
  }

  emit("project-changed");
  emit("selection-changed", clip.id);
  return clip;
}

export async function importFiles(paths) {
  if (!paths?.length) return;
  pushHistory();
  emit("loading", true);
  try {
    for (const p of paths) {
      try {
        await importFile(p);
      } catch (e) {
        console.error("import failed:", p, e);
        emit("status", `import failed: ${basename(p)}`);
      }
    }
  } finally {
    emit("loading", false);
  }
}

/// re-decode audio for all clips after project restore (cache hits are free)
export async function warmAudioCaches() {
  for (const clip of state.clips) {
    for (const tr of clip.audioTracks || []) {
      if (tr.wavPath) loadAudio(tr.wavPath).catch(() => {});
    }
  }
}
