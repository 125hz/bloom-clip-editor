// Downloads the self-contained Windows VapourSynth + RIFE runtime used by
// Bloom's GPU motion-blur backend. These files are build artifacts, not source
// files, and are intentionally ignored by Git.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const runtimeDir = join(tauriDir, "vapoursynth");
const pluginsDir = join(runtimeDir, "vs-plugins");
const modelsDir = join(tauriDir, "rife-models", "rife-v4.26_ensembleFalse");

const portableInstaller =
  "https://github.com/vapoursynth/vapoursynth/releases/download/R70/Install-Portable-VapourSynth-R70.ps1";
const rifePlugin =
  "https://github.com/styler00dollar/VapourSynth-RIFE-ncnn-Vulkan/releases/download/r9_mod_v33/librife_windows_x86-64.dll";
const lsmashPlugin =
  "https://github.com/HomeOfAviSynthPlusEvolution/L-SMASH-Works/releases/download/1194.0.0.0/L-SMASH-Works-r1194.0.0.0.7z";
const mvtoolsPlugin =
  "https://github.com/dubhater/vapoursynth-mvtools/releases/download/v24/vapoursynth-mvtools-v24-win64.7z";
const modelBase =
  "https://raw.githubusercontent.com/styler00dollar/VapourSynth-RIFE-ncnn-Vulkan/c3ec6aabc07c8fa37a4f58d7fed9e2ad1fc1b13f/models/rife-v4.26_ensembleFalse";

async function download(url, path) {
  if (existsSync(path)) return;
  console.log(`downloading ${url}`);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`download attempt ${attempt} failed; retrying...`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw new Error(`download failed after 3 attempts: ${url}\n${lastError}`);
}

mkdirSync(runtimeDir, { recursive: true });
mkdirSync(pluginsDir, { recursive: true });
mkdirSync(modelsDir, { recursive: true });

const vspipe = join(runtimeDir, "vspipe.exe");
if (!existsSync(vspipe)) {
  const installerPath = join(runtimeDir, "Install-Portable-VapourSynth-R70.ps1");
  await download(portableInstaller, installerPath);
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerPath, "-Unattended", "-TargetFolder", runtimeDir],
    { cwd: runtimeDir, stdio: "inherit" },
  );
  if (result.status !== 0 || !existsSync(vspipe)) {
    throw new Error("portable VapourSynth setup failed");
  }
  rmSync(installerPath, { force: true });
  rmSync(join(runtimeDir, "doc"), { recursive: true, force: true });
  rmSync(join(runtimeDir, "Scripts"), { recursive: true, force: true });
  rmSync(join(runtimeDir, "vs-temp-dl"), { recursive: true, force: true });
}

await download(rifePlugin, join(pluginsDir, "rife-ncnn-vulkan.dll"));
const lsmashDll = join(pluginsDir, "LSMASHSource.dll");
if (!existsSync(lsmashDll)) {
  const archive = join(runtimeDir, "lsmash.7z");
  await download(lsmashPlugin, archive);
  const extract = spawnSync(
    join(runtimeDir, "7z.exe"),
    ["e", archive, "x64/LSMASHSource.dll", `-o${pluginsDir}`, "-y"],
    { stdio: "inherit" },
  );
  if (extract.status !== 0 || !existsSync(lsmashDll)) {
    throw new Error("L-SMASH plugin extraction failed");
  }
  rmSync(archive, { force: true });
}
// mvtools backs the "balanced" motion-blur method (CPU block motion comp)
const mvtoolsDll = join(pluginsDir, "libmvtools.dll");
if (!existsSync(mvtoolsDll)) {
  const archive = join(runtimeDir, "mvtools.7z");
  await download(mvtoolsPlugin, archive);
  const extract = spawnSync(
    join(runtimeDir, "7z.exe"),
    ["e", archive, "libmvtools.dll", "-r", `-o${pluginsDir}`, "-y"],
    { stdio: "inherit" },
  );
  if (extract.status !== 0 || !existsSync(mvtoolsDll)) {
    throw new Error("mvtools plugin extraction failed");
  }
  rmSync(archive, { force: true });
}

await download(`${modelBase}/flownet.bin`, join(modelsDir, "flownet.bin"));
await download(`${modelBase}/flownet.param`, join(modelsDir, "flownet.param"));

console.log("VapourSynth RIFE runtime ready");
