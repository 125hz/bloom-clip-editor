// project.js - save / open .bloom project files.
//
// A project file stores the full edit state (tracks, clips, styles, fades,
// loop region, zoom) but none of the derived media artifacts — audio wavs,
// waveform peaks and thumbnails are re-derived on load from the Rust caches
// (keyed by file hash, so reopening a project is fast).

import {
  invoke,
  convertFileSrc,
  saveProjectDialog,
  openProjectDialog,
  messageBox,
  confirmBox,
  setWindowTitle,
} from "./tauri.js";
import { state, emit, replaceProject } from "./state.js";
import { loadAudio } from "./media.js";
import * as player from "./player.js";
import { basename, uid } from "./utils.js";

const FORMAT_VERSION = 1;

let currentProjectPath = null;

function markTitle() {
  setWindowTitle(
    currentProjectPath ? `bloom editor — ${basename(currentProjectPath)}` : "bloom editor"
  );
}

// -------------------- save --------------------

function serialize() {
  return JSON.stringify(
    {
      app: "bloom-editor",
      version: FORMAT_VERSION,
      savedAt: new Date().toISOString(),
      baseAspect: state.baseAspect,
      time: state.time,
      pps: state.pps,
      loop: state.loop,
      tracks: state.tracks,
      clips: state.clips.map((c) => ({
        id: c.id,
        kind: c.kind,
        trackId: c.trackId,
        filePath: c.filePath || "",
        startTime: c.startTime,
        inPoint: c.inPoint || 0,
        duration: c.duration,
        // JSON can't hold Infinity (text clips) — null means unbounded
        sourceDuration: Number.isFinite(c.sourceDuration) ? c.sourceDuration : null,
        fps: c.fps || 60,
        fadeIn: c.fadeIn || 0,
        fadeOut: c.fadeOut || 0,
        speed: c.speed || 1,
        opacity: c.opacity ?? 1,
        crop: c.crop || null,
        audioTracks: (c.audioTracks || []).map((t) => ({
          order: t.order || 0,
          streamIndex: t.streamIndex ?? 0,
          label: t.label || "",
          enabled: t.enabled !== false,
          volume: t.volume ?? 1,
        })),
        text: c.text || null,
      })),
    },
    null,
    2
  );
}

async function writeTo(path) {
  try {
    await invoke("save_project", { path, data: serialize() });
    currentProjectPath = path;
    markTitle();
    emit("status", `saved ${basename(path)}`);
  } catch (e) {
    await messageBox(`save failed:\n${e}`);
  }
}

export async function saveProjectAs() {
  const path = await saveProjectDialog();
  if (!path) return;
  await writeTo(path);
}

export async function saveProject() {
  if (currentProjectPath) await writeTo(currentProjectPath);
  else await saveProjectAs();
}

// -------------------- new --------------------

export async function newProject() {
  if (state.clips.length) {
    const ok = await confirmBox("start a new project? unsaved changes will be lost");
    if (!ok) return;
  }
  player.stop();
  replaceProject({
    tracks: [
      { id: uid(), kind: "text", name: "t1" },
      { id: uid(), kind: "video", name: "v1" },
      { id: uid(), kind: "audio", name: "a1" },
    ],
    clips: [],
    baseAspect: null,
    time: 0,
    loop: null,
    pps: 20,
  });
  currentProjectPath = null;
  markTitle();
  emit("aspect-changed");
  player.invalidatePool();
  player.seekPreview(0);
  emit("status", "new project");
}

// -------------------- open --------------------

export async function openProject() {
  const picked = await openProjectDialog();
  if (!picked) return;
  const path = Array.isArray(picked) ? picked[0] : picked;

  emit("loading", true);
  try {
    const raw = await invoke("load_project", { path });
    const data = JSON.parse(raw);
    if (data.app !== "bloom-editor" || !Array.isArray(data.tracks) || !Array.isArray(data.clips)) {
      throw new Error("not a bloom project file");
    }
    await applyProject(data);
    currentProjectPath = path;
    markTitle();
    emit("status", `loaded ${basename(path)}`);
  } catch (e) {
    await messageBox(`load failed:\n${e}`);
  } finally {
    emit("loading", false);
  }
}

async function applyProject(data) {
  player.stop();

  const clips = data.clips.map((c) => ({
    ...c,
    inPoint: c.inPoint || 0,
    speed: c.speed || 1,
    sourceDuration: c.sourceDuration == null ? Infinity : c.sourceDuration,
    fileUrl: c.filePath ? convertFileSrc(c.filePath) : "",
    thumbnailUrl: null,
    audioTracks: (c.audioTracks || []).map((t) => ({ ...t, wavPath: null })),
  }));

  replaceProject({
    tracks: data.tracks,
    clips,
    baseAspect: data.baseAspect,
    time: data.time,
    loop: data.loop,
    pps: data.pps,
  });
  emit("aspect-changed");

  // re-derive media artifacts (audio wavs, decoded peaks, thumbnails)
  const missing = new Set();
  for (const c of clips) {
    if (!c.filePath) continue;
    const seen = new Map();
    for (const tr of c.audioTracks) {
      try {
        if (!seen.has(tr.streamIndex)) {
          seen.set(
            tr.streamIndex,
            await invoke("extract_audio", { path: c.filePath, streamIndex: tr.streamIndex })
          );
        }
        tr.wavPath = seen.get(tr.streamIndex);
        await loadAudio(tr.wavPath);
      } catch {
        tr.wavPath = null;
        missing.add(basename(c.filePath));
      }
    }
    if (c.kind === "video") {
      try {
        c.thumbnailUrl = convertFileSrc(await invoke("generate_thumbnail", { path: c.filePath }));
      } catch {
        missing.add(basename(c.filePath));
      }
    }
  }

  emit("project-changed");
  player.invalidatePool();
  if (!state.playing) player.seekPreview(state.time);

  if (missing.size) {
    await messageBox(`some media files could not be loaded:\n${[...missing].join("\n")}`);
  }
}
