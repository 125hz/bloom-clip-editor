// init.js - Handles initialization and setup of the application.

const { ipcRenderer } = require("electron");

// --- Elements ---
const previewSection = document.getElementById("preview-section");
const videoA = document.getElementById("video-a");
const videoB = document.getElementById("video-b");
const previewCanvas = document.getElementById("preview-canvas");
const noClipOverlay = document.getElementById("no-clip-overlay");
const loadingOverlay = document.getElementById("loading-overlay");

const tracksArea = document.getElementById("tracks-area");
const timelineRuler = document.getElementById("timeline-ruler");
const playhead = document.getElementById("playhead");

const ghostPlayhead = document.createElement("div");
ghostPlayhead.id = "ghost-playhead";
tracksArea.appendChild(ghostPlayhead);

const importBtn = document.getElementById("import-btn");
const playPauseBtn = document.getElementById("play-pause-btn");
const previewQualitySelect = document.getElementById("preview-quality");
const timeDisplay = document.getElementById("time-display");

const exportBtn = document.getElementById("export-btn");

const exportProgress = document.getElementById("export-progress");
const exportProgressFill = document.getElementById("export-progress-fill");
const exportProgressPct = document.getElementById("export-progress-pct");
const exportProgressText = document.getElementById("export-progress-text");
const cancelExportBtn = document.getElementById("cancel-export-btn");

const settingsModal = document.getElementById("settings-modal");
const helpModal = document.getElementById("help-modal");
const btnSettings = document.getElementById("btn-settings");
const btnHelp = document.getElementById("btn-help");
const closeSettingsBtn = document.getElementById("close-settings");
const closeHelpBtn = document.getElementById("close-help");
const checkMagnetic = document.getElementById("check-magnetic");
const checkPauseAtPlayhead = document.getElementById("check-pause-at-playhead");

// --- State ---
let clips = [];
let globalTime = 0;
let playbackStartTime = 0;
let pixelsPerSecond = 20;
let isPlaying = false;
let selectedClipId = null;
let activeClipId = null;

let magneticSnapping = true;
let pauseAtPlayhead = false;

let isSeeking = false;
let seekTicket = 0;

let baseAspect = null;

let front = videoA;
let back = videoB;

videoA.style.opacity = 1; 
videoA.style.zIndex = 1;
videoB.style.opacity = 0;
videoB.style.zIndex = -1;

let previewScale = 0.5;
const canvasCtx = previewCanvas.getContext("2d", { alpha: false, desynchronized: true });
let canvasDrawRaf = null;

let scrubbing = false;
let frameStepSeconds = 1 / 60;
const MIN_CLIP_DURATION = 0.1;

const waveformCache = new Map();

const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 200;

let audioCtx = null;
const previewMix = {
  activeIds: [],
  sources: [],
  masterGain: null,
  playing: false,
};
let lastMixKey = "";
