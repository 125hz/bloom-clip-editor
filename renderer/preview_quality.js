// preview_quality.js - Handles preview quality

const _holdCanvas = document.createElement('canvas');
const _holdCtx = _holdCanvas.getContext('2d', { alpha: false });

// _captureHoldFrame - Captures the current frame of the preview canvas
function _captureHoldFrame() {
  if (!previewCanvas || previewCanvas.width <= 1 || previewCanvas.height <= 1) return;
  if (_holdCanvas.width !== previewCanvas.width || _holdCanvas.height !== previewCanvas.height) {
    _holdCanvas.width = previewCanvas.width;
    _holdCanvas.height = previewCanvas.height;
  }
  try {
    _holdCtx.drawImage(previewCanvas, 0, 0);
  } catch { }
}

// _drawHoldFrameToPreview - Draws the captured frame to the preview canvas
function _drawHoldFrameToPreview() {
  if (_holdCanvas.width <= 1 || _holdCanvas.height <= 1) return;
  try {
    canvasCtx.drawImage(_holdCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
  } catch { }
}

// drawCanvasFrame - Draws the current frame of the video to the canvas
function drawCanvasFrame() {
  if (previewCanvas.style.display !== 'none' && front && front.readyState >= 2) {
    try {
      const op = parseFloat(front.style.opacity);
      canvasCtx.globalAlpha = isNaN(op) ? 1.0 : op;
      canvasCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      canvasCtx.drawImage(front, 0, 0, previewCanvas.width, previewCanvas.height);
      canvasCtx.globalAlpha = 1.0;
      _captureHoldFrame();
    } catch { }
  }
}

// startCanvasDrawLoop - Starts the canvas draw loop which handles drawing the video frame to the canvas
function startCanvasDrawLoop() {
  if (canvasDrawRaf) return;
  const draw = () => {
    if (isPlaying) {
      canvasDrawRaf = requestAnimationFrame(draw);
      drawCanvasFrame();
    }
  };
  canvasDrawRaf = requestAnimationFrame(draw);
}
function stopCanvasDrawLoop() { if (canvasDrawRaf) cancelAnimationFrame(canvasDrawRaf); canvasDrawRaf = null; }

// applyPreviewQuality - Applies the preview quality setting
function applyPreviewQuality() {
  previewScale = parseFloat(previewQualitySelect.value || "1");
  const useCanvas = previewScale < 0.999;

  if (!useCanvas) {
    previewCanvas.style.display = "none";
    front.style.visibility = "visible";
    back.style.visibility = "hidden";
    stopCanvasDrawLoop();
    return;
  }

  previewCanvas.style.display = "block";
  videoA.style.visibility = "hidden";
  videoB.style.visibility = "hidden";

  // Capture the current preview before any resize
  _captureHoldFrame();

  const vw = front.videoWidth || 1280;
  const vh = front.videoHeight || 720;
  previewCanvas.width = Math.max(2, Math.floor(vw * previewScale));
  previewCanvas.height = Math.max(2, Math.floor(vh * previewScale));

  _drawHoldFrameToPreview();

  requestAnimationFrame(drawCanvasFrame);
  if (isPlaying) startCanvasDrawLoop();
}
previewQualitySelect.addEventListener("change", applyPreviewQuality);
videoA.addEventListener("loadedmetadata", applyPreviewQuality);
videoB.addEventListener("loadedmetadata", applyPreviewQuality);
