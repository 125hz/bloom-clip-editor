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

export async function saveProjectDialog() {
  return await T.dialog.save({
    title: "save project",
    defaultPath: "untitled.bloom",
    filters: [{ name: "bloom project", extensions: ["bloom"] }],
  });
}

export async function openProjectDialog() {
  return await T.dialog.open({
    multiple: false,
    title: "open project",
    filters: [{ name: "bloom project", extensions: ["bloom"] }],
  });
}

export function openExternal(url) {
  invoke("plugin:opener|open_url", { url }).catch((e) => console.error("open url:", e));
}

export async function revealInFolder(path) {
  // the opener plugin command signature is reveal_item_in_dir(paths: Vec<PathBuf>)
  return await invoke("plugin:opener|reveal_item_in_dir", { paths: [path] });
}

export function setWindowTitle(title) {
  try {
    T.window.getCurrentWindow().setTitle(title);
  } catch {}
}

export async function messageBox(msg, title = "bloom editor") {
  try {
    await T.dialog.message(String(msg), { title, kind: "error" });
  } catch {
    alert(msg);
  }
}

export async function confirmBox(msg, title = "bloom editor") {
  try {
    return await T.dialog.confirm(String(msg), { title });
  } catch {
    return confirm(msg);
  }
}
