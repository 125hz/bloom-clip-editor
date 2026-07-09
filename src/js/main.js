// main.js - boot and wiring

import { invoke, listen, openFileDialog, openExternal } from "./tauri.js";
import {
  state,
  on,
  emit,
  addTrack,
  loadSettings,
  saveSettings,
  HOTKEY_DEFAULTS,
} from "./state.js";
import { importFiles, warmAudioCaches } from "./media.js";
import * as player from "./player.js";
import * as timeline from "./timeline.js";
import { clearLoop, toggleSnapping } from "./interactions.js";
import { addTextClip } from "./textpanel.js";
import { saveProject, openProject, newProject } from "./project.js";
import { HOTKEY_ACTIONS, FIXED_SHORTCUTS, comboFromEvent } from "./keyboard.js";
import "./clippanel.js";
import "./exportui.js";

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

document.getElementById("btn-save").addEventListener("click", () => saveProject());
document.getElementById("btn-open").addEventListener("click", () => openProject());
document.getElementById("btn-new").addEventListener("click", () => newProject());

// snapping toggle + indicator
const snapBtn = document.getElementById("snap-btn");
function updateSnapIndicator() {
  const onOff = state.settings.snapping ? "on" : "off";
  snapBtn.textContent = `snap: ${onOff}`;
  snapBtn.classList.toggle("off", !state.settings.snapping);
}
snapBtn.addEventListener("click", () => toggleSnapping());
on("snapping-changed", () => {
  updateSnapIndicator();
  checkSnapping.checked = state.settings.snapping;
});

document.getElementById("preview-quality").addEventListener("change", (e) => {
  state.settings.previewScale = parseFloat(e.target.value) || 1;
  saveSettings();
  player.applyQuality();
});

document.getElementById("add-video-track").addEventListener("click", () => addTrack("video"));
document.getElementById("add-audio-track").addEventListener("click", () => addTrack("audio"));
document.getElementById("add-text-track").addEventListener("click", () => addTrack("text"));

// -------------------- modals --------------------

function wireModal(openBtnId, modalId, closeBtnId, onOpen) {
  const modal = document.getElementById(modalId);
  document.getElementById(openBtnId).addEventListener("click", () => {
    if (onOpen) onOpen();
    modal.hidden = false;
  });
  document.getElementById(closeBtnId).addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
}
wireModal("btn-settings", "settings-modal", "settings-close", () => renderHotkeyList());
wireModal("btn-help", "help-modal", "help-close", () => renderHelpList());

const checkMagnetic = document.getElementById("check-magnetic");
const checkLayerSnap = document.getElementById("check-layer-snap");
const checkPause = document.getElementById("check-pause-at-playhead");
const checkSnapping = document.getElementById("check-snapping");
checkSnapping.addEventListener("change", () => {
  state.settings.snapping = checkSnapping.checked;
  saveSettings();
  updateSnapIndicator();
});
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

// -------------------- editable hotkeys --------------------

const hotkeyList = document.getElementById("hotkey-list");
let captureCleanup = null;

function cancelCapture() {
  if (captureCleanup) {
    captureCleanup();
    captureCleanup = null;
  }
}

function renderHotkeyList() {
  cancelCapture();
  hotkeyList.innerHTML = "";
  for (const action of HOTKEY_ACTIONS) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = action.label;
    const btn = document.createElement("button");
    btn.className = "tbtn small hk-bind";
    btn.textContent = state.settings.hotkeys[action.id] || "unbound";
    btn.addEventListener("click", () => startCapture(action, btn));
    li.append(name, btn);
    hotkeyList.appendChild(li);
  }
}

function startCapture(action, btn) {
  cancelCapture();
  btn.textContent = "press a key...";
  btn.classList.add("capturing");

  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return; // wait for a real key
    cancelCapture();
    if (e.key === "Escape") {
      renderHotkeyList();
      return;
    }
    const combo = comboFromEvent(e);
    const clash = HOTKEY_ACTIONS.find(
      (a) => a.id !== action.id && state.settings.hotkeys[a.id] === combo
    );
    if (clash) {
      emit("status", `"${combo}" is already bound to ${clash.label}`);
    } else {
      state.settings.hotkeys[action.id] = combo;
      saveSettings();
    }
    renderHotkeyList();
  };
  const onMouse = (e) => {
    if (e.target === btn) return;
    cancelCapture();
    renderHotkeyList();
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("mousedown", onMouse, true);
  captureCleanup = () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("mousedown", onMouse, true);
  };
}

document.getElementById("hotkeys-reset").addEventListener("click", () => {
  state.settings.hotkeys = { ...HOTKEY_DEFAULTS };
  saveSettings();
  renderHotkeyList();
});

// -------------------- help modal (generated from the live keymap) --------------------

function renderHelpList() {
  const ul = document.getElementById("help-shortcut-list");
  ul.innerHTML = "";
  const add = (label, keys) => {
    const li = document.createElement("li");
    const l = document.createElement("span");
    l.textContent = label;
    const k = document.createElement("span");
    k.textContent = keys;
    li.append(l, k);
    ul.appendChild(li);
  };
  for (const action of HOTKEY_ACTIONS) {
    add(action.label, state.settings.hotkeys[action.id] || "unbound");
  }
  for (const [label, keys] of FIXED_SHORTCUTS) add(label, keys);
}

// about links open in the default browser
for (const link of document.querySelectorAll(".ext-link")) {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    openExternal(link.dataset.url);
  });
}

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
  checkSnapping.checked = state.settings.snapping;
  updateSnapIndicator();
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
