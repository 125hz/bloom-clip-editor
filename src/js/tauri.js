// tauri.js - bridge to the Tauri runtime (withGlobalTauri)

const T = window.__TAURI__;

export const invoke = (...args) => T.core.invoke(...args);
export const listen = (...args) => T.event.listen(...args);
export const convertFileSrc = (p) => T.core.convertFileSrc(p);

export async function openFileDialog() {
  return await T.dialog.open({
    multiple: true,
    filters: [
      {
        name: "media",
        extensions: ["mp4", "mkv", "mov", "webm", "ogg", "mp3", "wav", "m4a", "flac", "aac"],
      },
    ],
  });
}

export async function saveExportDialog() {
  return await T.dialog.save({
    title: "export video",
    defaultPath: `export_${Date.now()}.mp4`,
    filters: [{ name: "mp4", extensions: ["mp4"] }],
  });
}

export async function messageBox(msg, title = "bloom editor") {
  try {
    await T.dialog.message(String(msg), { title, kind: "error" });
  } catch {
    alert(msg);
  }
}
