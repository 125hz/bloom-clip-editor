// keyboard.js - keyboard shortcuts

import { state, undo, redo, findVideoClipAtTime, clipById } from "./state.js";
import * as player from "./player.js";
import { splitAtPlayhead, deleteSelected, selectSideOfPlayhead } from "./interactions.js";
import { addTextClip } from "./textpanel.js";
import { openExportModal } from "./exportui.js";
import { updatePlayhead, followPlayhead } from "./timeline.js";
import { clamp } from "./utils.js";

function stepFrame(dir) {
  const active = findVideoClipAtTime(state.time) || clipById(state.selectedId);
  const fps = active?.fps > 0 ? active.fps : 60;
  const frame = Math.round(state.time * fps) + dir;
  const t = clamp(frame / fps, 0, 60 * 60 * 10);
  state.anchorTime = t;
  player.seek(t);
  updatePlayhead();
  followPlayhead();
}

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
  if (state.exporting) return;

  if (e.code === "Space") {
    e.preventDefault();
    player.togglePlay();
    return;
  }

  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey && e.key.toLowerCase() === "y") || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z")) {
    e.preventDefault();
    redo();
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === "m") {
    e.preventDefault();
    openExportModal();
    return;
  }

  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key.toLowerCase()) {
    case "s":
      splitAtPlayhead();
      break;
    case "q":
      selectSideOfPlayhead(-1);
      break;
    case "e":
      selectSideOfPlayhead(1);
      break;
    case "t":
      addTextClip();
      break;
    case "d":
    case "delete":
    case "backspace":
      deleteSelected();
      break;
    case "arrowleft":
      e.preventDefault();
      stepFrame(-1);
      break;
    case "arrowright":
      e.preventDefault();
      stepFrame(1);
      break;
  }
});
