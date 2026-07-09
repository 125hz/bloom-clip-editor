// keyboard.js - keyboard shortcuts, driven by the editable keymap in
// state.settings.hotkeys (see the settings modal). Combos are stored as
// strings like "s", "space", "ctrl+m", "ctrl+shift+z".

import { state, undo, redo, findVideoClipAtTime, clipById } from "./state.js";
import * as player from "./player.js";
import {
  splitAtPlayhead,
  deleteSelected,
  selectSideOfPlayhead,
  toggleSnapping,
} from "./interactions.js";
import { addTextClip } from "./textpanel.js";
import { openExportModal } from "./exportui.js";
import { saveProject, openProject } from "./project.js";
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

/// every rebindable action, in the order shown in settings / help
export const HOTKEY_ACTIONS = [
  { id: "playPause", label: "play / pause", run: () => player.togglePlay() },
  { id: "split", label: "split clip", run: () => splitAtPlayhead() },
  { id: "selectLeft", label: "select left of playhead", run: () => selectSideOfPlayhead(-1) },
  { id: "selectRight", label: "select right of playhead", run: () => selectSideOfPlayhead(1) },
  { id: "addText", label: "add text", run: () => addTextClip() },
  { id: "deleteClip", label: "delete clip", run: () => deleteSelected() },
  { id: "toggleSnapping", label: "toggle snapping", run: () => toggleSnapping() },
  { id: "seekBack", label: "seek frame back", run: () => stepFrame(-1) },
  { id: "seekFwd", label: "seek frame forward", run: () => stepFrame(1) },
  { id: "export", label: "export", run: () => openExportModal() },
  { id: "undo", label: "undo", run: () => undo() },
  { id: "redo", label: "redo", run: () => redo() },
  { id: "save", label: "save project", run: () => saveProject() },
  { id: "open", label: "open project", run: () => openProject() },
];

/// fixed bindings that always work, shown in help but not rebindable
export const FIXED_SHORTCUTS = [
  ["delete clip (always)", "del / backspace"],
  ["redo (alternate)", "ctrl + shift + z"],
  ["zoom timeline (on playhead)", "scroll wheel"],
  ["track height", "ctrl + scroll wheel"],
  ["slow down clip", "ctrl + drag clip edge"],
  ["edit text on preview", "double-click text"],
];

/// normalize a keydown event into a combo string, or null for bare modifiers
export function comboFromEvent(e) {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  let key = e.key === " " ? "space" : e.key.toLowerCase();
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

window.addEventListener("keydown", (e) => {
  const el = document.activeElement;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName) || el?.isContentEditable) return;
  if (state.exporting) return;

  // fixed extras
  if ((e.key === "Delete" || e.key === "Backspace") && !e.ctrlKey && !e.altKey) {
    deleteSelected();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    redo();
    return;
  }

  const combo = comboFromEvent(e);
  if (!combo) return;
  const hotkeys = state.settings.hotkeys || {};
  for (const action of HOTKEY_ACTIONS) {
    if (hotkeys[action.id] === combo) {
      e.preventDefault();
      action.run();
      return;
    }
  }
});
