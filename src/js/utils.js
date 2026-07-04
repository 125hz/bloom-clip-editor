// utils.js - small shared helpers

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function basename(p) {
  return (p || "").split(/[\\/]/).pop();
}

export function formatTime(seconds) {
  seconds = Math.max(0, seconds || 0);
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function formatTimeShort(seconds) {
  seconds = Math.max(0, seconds || 0);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (Number.isInteger(s)) return `${m}:${String(s).padStart(2, "0")}`;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export const MIN_CLIP_DURATION = 0.05;
