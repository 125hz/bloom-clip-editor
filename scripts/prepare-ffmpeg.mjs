// Copies the ffmpeg/ffprobe binaries from npm packages into src-tauri/binaries
// with the target-triple names Tauri expects for sidecar/externalBin bundling.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const triple = "x86_64-pc-windows-msvc";
const outDir = join(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

const targets = [
  {
    src: join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe"),
    dst: join(outDir, `ffmpeg-${triple}.exe`),
  },
  {
    src: join(root, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"),
    dst: join(outDir, `ffprobe-${triple}.exe`),
  },
];

for (const { src, dst } of targets) {
  if (!existsSync(src)) {
    console.error(`missing ${src} — run npm install first`);
    process.exit(1);
  }
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
  console.log(`copied ${src} -> ${dst}`);
}
console.log("ffmpeg binaries ready");
