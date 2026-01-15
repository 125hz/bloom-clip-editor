// snapping.js - handles snapping functionality

// applySnapping - applies snapping to the proposed start time
function applySnapping(proposedStart, movingClip) {
  const thresholdSec = 10 / pixelsPerSecond;
  let best = proposedStart;
  let bestDiff = Infinity;

  const candidates = clips.filter(c => c.id !== movingClip.id && c.type === movingClip.type);

  if (proposedStart < thresholdSec) best = 0;

  for (const c of candidates) {
    const points = [c.startTime, c.startTime + c.duration];
    for (const sp of points) {
      const diff = Math.abs(proposedStart - sp);
      if (diff < bestDiff && diff <= thresholdSec) {
        bestDiff = diff;
        best = sp;
      }
    }
  }
  return Math.max(0, best);
}
