// wheel.js - Scroll wheel events
async function handleTimelineWheel(e) {
  e.preventDefault();

  const before = pixelsPerSecond;
  const zoomFactor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const newPps = clamp(pixelsPerSecond * zoomFactor, 5, 240);

  if (Math.abs(newPps - before) < 0.0001) return;
  pixelsPerSecond = newPps;

  const end = getTimelineViewEnd();
  const totalWidth = Math.ceil(end * pixelsPerSecond);

  let trackSpacer = tracksArea.querySelector("#timeline-spacer");
  if (!trackSpacer) { 
      trackSpacer = document.createElement("div"); 
      trackSpacer.id = "timeline-spacer"; 
      tracksArea.appendChild(trackSpacer); 
  }
  trackSpacer.style.width = `${totalWidth}px`;

  if (timelineRuler.firstChild && timelineRuler.firstChild.style) {
      timelineRuler.firstChild.style.width = `${totalWidth}px`;
  }

  // --- FORCE REFLOW ---
  void tracksArea.offsetWidth;
  void timelineRuler.offsetWidth;

  // --- CENTER ON PLAYHEAD ---
  const playheadX = globalTime * pixelsPerSecond;
  const halfScreen = tracksArea.clientWidth / 2;
  const desiredScrollLeft = Math.max(0, playheadX - halfScreen);

  // Sync both immediately
  tracksArea.scrollLeft = desiredScrollLeft;
  timelineRuler.scrollLeft = desiredScrollLeft;

  requestAnimationFrame(() => {
    tracksArea.scrollLeft = desiredScrollLeft;
    timelineRuler.scrollLeft = desiredScrollLeft;
  });

  setPlayheadPosition();
  setGhostPlayheadPosition();
  requestRenderTimeline();
}

tracksArea.addEventListener("wheel", (e) => handleTimelineWheel(e), { passive: false });
timelineRuler.addEventListener("wheel", (e) => handleTimelineWheel(e), { passive: false });

// --- SCROLL SYNC ---
// Keeps ruler locked to tracks when dragging/swiping
tracksArea.addEventListener("scroll", () => {
  if (Math.abs(timelineRuler.scrollLeft - tracksArea.scrollLeft) > 1) {
    timelineRuler.scrollLeft = tracksArea.scrollLeft;
  }
});