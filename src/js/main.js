// main.js - boot and wiring

import { invoke, listen, openFileDialog } from "./tauri.js";
import {
  state,
  on,
  emit,
  addTrack,
  loadSettings,
  saveSettings,
} from "./state.js";
import { importFiles, warmAudioCaches } from "./media.js";
import * as player from "./player.js";
import * as timeline from "./timeline.js";
import { clearLoop } from "./interactions.js";
import { addTextClip } from "./textpanel.js";
import "./clippanel.js";
import "./exportui.js";
import "./keyboard.js";

const playBtn = document.getElementById("play-btn");
const statusLine = document.getElementById("status-line");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingSpinner = document.getElementById("loading-spinner");
const dropHint = document.getElementById("drop-hint");

// -------------------- bus wiring --------------------

on("project-changed", () => {
  timeline.requestRender();
  player.invalidatePool();
  if (!state.playing) player.draw(state.time);
});

on("project-restored", () => {
  player.invalidatePool();
  warmAudioCaches();
  if (!state.playing) player.seekPreview(state.time);
});

on("selection-changed", () => timeline.updateSelection());

on("tick", () => {
  timeline.updatePlayhead();
  if (state.playing) timeline.followPlayhead();
});

on("playstate", (playing) => {
  playBtn.textContent = playing ? "pause" : "play";
});

on("aspect-changed", () => player.applyQuality());

on("settings-changed", () => saveSettings());

const clearLoopBtn = document.getElementById("clear-loop-btn");
on("loop-changed", (loop) => {
  clearLoopBtn.hidden = !loop;
});
clearLoopBtn.addEventListener("click", () => clearLoop());

let statusTimer = null;
on("status", (msg) => {
  statusLine.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusLine.textContent = ""), 4000);
});

// loading overlay with spinner animation
let spinnerTimer = null;
const SPIN = ["|", "/", "-", "\\"];
on("loading", (isLoading) => {
  loadingOverlay.hidden = !isLoading;
  clearInterval(spinnerTimer);
  if (isLoading) {
    let i = 0;
    spinnerTimer = setInterval(() => {
      loadingSpinner.textContent = SPIN[i++ % SPIN.length];
    }, 120);
  }
});

// -------------------- controls --------------------

playBtn.addEventListener("click", () => player.togglePlay());

document.getElementById("import-btn").addEventListener("click", async () => {
  const picked = await openFileDialog();
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  await importFiles(paths);
  if (!state.playing) player.seekPreview(state.time);
});

document.getElementById("add-text-btn").addEventListener("click", () => addTextClip());

document.getElementById("preview-quality").addEventListener("change", (e) => {
  state.settings.previewScale = parseFloat(e.target.value) || 1;
  saveSettings();
  player.applyQuality();
});

document.getElementById("add-video-track").addEventListener("click", () => addTrack("video"));
document.getElementById("add-audio-track").addEventListener("click", () => addTrack("audio"));
document.getElementById("add-text-track").addEventListener("click", () => addTrack("text"));

// -------------------- modals --------------------

function wireModal(openBtnId, modalId, closeBtnId) {
  const modal = document.getElementById(modalId);
  document.getElementById(openBtnId).addEventListener("click", () => (modal.hidden = false));
  document.getElementById(closeBtnId).addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
}
wireModal("btn-settings", "settings-modal", "settings-close");
wireModal("btn-help", "help-modal", "help-close");

const checkMagnetic = document.getElementById("check-magnetic");
const checkLayerSnap = document.getElementById("check-layer-snap");
const checkPause = document.getElementById("check-pause-at-playhead");
checkMagnetic.addEventListener("change", () => {
  state.settings.magneticSnapping = checkMagnetic.checked;
  saveSettings();
});
checkLayerSnap.addEventListener("change", () => {
  state.settings.crossLayerSnapping = checkLayerSnap.checked;
  saveSettings();
});
checkPause.addEventListener("change", () => {
  state.settings.pauseAtPlayhead = checkPause.checked;
  saveSettings();
});

// terminal app: no browser context menu
window.addEventListener("contextmenu", (e) => e.preventDefault());

// -------------------- OS drag & drop --------------------

listen("tauri://drag-enter", () => {
  if (!state.playing) dropHint.hidden = false;
});
listen("tauri://drag-leave", () => (dropHint.hidden = true));
listen("tauri://drag-drop", async (event) => {
  dropHint.hidden = true;
  if (state.playing || state.exporting) return;
  const paths = (event.payload?.paths || []).filter((p) =>
    /\.(mp4|mkv|mov|webm|ogg|mp3|wav|m4a|flac|aac)$/i.test(p)
  );
  if (paths.length) {
    await importFiles(paths);
    if (!state.playing) player.seekPreview(state.time);
  }
});

// -------------------- boot --------------------

async function boot() {
  loadSettings();
  checkMagnetic.checked = state.settings.magneticSnapping;
  checkLayerSnap.checked = state.settings.crossLayerSnapping;
  checkPause.checked = state.settings.pauseAtPlayhead;
  document.getElementById("preview-quality").value = String(state.settings.previewScale);

  player.applyQuality();
  timeline.applyTrackScale();
  timeline.renderClips();
  timeline.updatePlayhead();

  try {
    const status = await invoke("tool_status");
    if (!status.ffmpegOk || !status.ffprobeOk) {
      emit("status", "warning: ffmpeg binaries missing — export/import disabled");
    }
  } catch (e) {
    console.error(e);
  }
}

boot();
