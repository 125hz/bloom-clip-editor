// import.js - Handles import functionality.

async function handleImport(filePath) {
  if (!filePath) return;

  loadingOverlay.style.display = "flex";
  try {
    pushHistory();

    const fileUrl = `file://${filePath.replace(/\\/g, "/")}`;
    const probe = await ipcRenderer.invoke("probe-media", filePath);

  let duration = Number(probe?.duration) || 0;
  if (!duration) duration = await probeVideoDuration(fileUrl);

  const isAudio = !probe?.video || filePath.match(/\.(mp3|wav|flac|m4a|aac|ogg|wma)$/i);

  let fps = 60;
  if (!isAudio && probe?.video?.r_frame_rate) fps = parseFps(probe.video.r_frame_rate) || 60;

  if (!isAudio && clips.length === 0 && probe?.video?.width && probe?.video?.height) {
    setPreviewAspectFromFirstClip(probe.video.width, probe.video.height);
  }

  let startTime = 0;
  if (clips.length > 0) {
    if (!isAudio) {
      const videoClips = clips.filter(c => c.type !== 'audio');
      if (videoClips.length > 0) {
        startTime = videoClips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
      } else {
        startTime = 0;
      }
    } else {
      startTime = getTimelineContentEnd();
    }
  }

  const audioStreams = Array.isArray(probe?.audioStreams) ? probe.audioStreams : [];
  let audioTracks = [];

  if (audioStreams.length >= 2) {
    audioTracks = audioStreams.map((s, i) => ({
      audioOrder: s.order,
      streamIndex: s.index,
      label: guessShadowplayLabel(s, i),
      enabled: true,
      extractedUrl: null,
      waveformPeaks: null,
      waveformBars: null,
      volume: 1.0
    }));
  } else {
    audioTracks = [{
      audioOrder: audioStreams[0]?.order ?? 0,
      streamIndex: audioStreams[0]?.index ?? 0,
      label: isAudio ? "Music" : "Audio",
      enabled: true,
      extractedUrl: null,
      waveformPeaks: null,
      waveformBars: null,
      volume: 1.0,
      fadeIn: 0,
      fadeOut: 0
    }];
  }

  const clip = {
    id: uid(),
    type: isAudio ? 'audio' : 'video',
    filePath,
    fileUrl,
    startTime: isAudio ? 0 : startTime,
    inPoint: 0,
    duration: Math.max(MIN_CLIP_DURATION, duration),
    sourceDuration: Math.max(MIN_CLIP_DURATION, duration),
    fps,
    audioTracks,
    thumbnailUrl: null
  };

  clips.push(clip);
  selectedClipId = clip.id;

  await extractAudioForTracks(clip);
  await refreshClipWaveforms(clip);

  if (!isAudio) {
    const thumb = await ipcRenderer.invoke("generate-thumbnail", filePath);
    if (thumb) clip.thumbnailUrl = thumb;
  }

    renderTimeline();
    if (!isAudio) await routePreviewToTime(globalTime, { forceSeek: true });
  } finally {
    loadingOverlay.style.display = "none";
  }
}

importBtn.addEventListener("click", async () => {
  if (importBtn.disabled) return;
  const filePath = await ipcRenderer.invoke("open-file-dialog");
  if (filePath) await handleImport(filePath);
});

document.body.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
document.body.addEventListener("drop", async (e) => {
  e.preventDefault(); e.stopPropagation();
  if (isPlaying) return;
  const file = e.dataTransfer.files[0];
  if (file && (file.type.startsWith("video") || file.type.startsWith("audio") || file.name.match(/\.(mkv|mp3|wav|flac|ogg)$/i))) {
    await handleImport(file.path);
  }
});

function parseFps(fr) {
  const m = String(fr).split("/");
  if (m.length === 2) {
    const a = Number(m[0]), b = Number(m[1]);
    if (a && b) return a / b;
  }
  const v = Number(fr);
  return Number.isFinite(v) ? v : null;
}

function guessShadowplayLabel(stream, i) {
  const title = (stream?.tags?.title || stream?.tags?.TITLE || "").toString().toLowerCase();
  if (title.includes("mic") || title.includes("micro")) return "A2";
  if (title.includes("game") || title.includes("system") || title.includes("desktop")) return "A1";
  return i === 0 ? "A1" : `A${i + 1}`;
}

async function probeVideoDuration(fileUrl) {
  return new Promise((resolve) => {
    const tmp = document.createElement("video");
    tmp.preload = "metadata";
    tmp.src = fileUrl;
    tmp.addEventListener("loadedmetadata", () => resolve(Number.isFinite(tmp.duration) ? tmp.duration : 0));
    tmp.addEventListener("error", () => resolve(0));
  });
}

async function extractAudioForTracks(clip) {
  const unique = new Map();
  for (const tr of clip.audioTracks) {
    if (!Number.isFinite(tr.streamIndex)) continue;
    if (unique.has(tr.streamIndex)) continue;

    const r = await ipcRenderer.invoke("extract-audio-stream", {
      filePath: clip.filePath,
      streamIndex: tr.streamIndex,
    });

    if (r?.ok && r.outPath) {
      unique.set(tr.streamIndex, `file://${r.outPath.replace(/\\/g, "/")}`);
    }
  }
  for (const tr of clip.audioTracks) tr.extractedUrl = unique.get(tr.streamIndex) || null;
}
