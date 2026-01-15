// -------------------- Diagnostics --------------------
(async () => {
  const st = await ipcRenderer.invoke("ffmpeg-status");
  if (!st?.ffprobeOk || !st?.ffmpegOk) {
    console.warn("FFmpeg tools missing.", st);
  }
})();
