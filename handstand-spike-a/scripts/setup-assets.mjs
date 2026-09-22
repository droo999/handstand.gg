// Copies MediaPipe's WASM runtime out of node_modules and downloads the pose models,
// so the app self-hosts everything (works offline later, no CDN dependency).
// Runs automatically after `npm install`. Failures only warn, so installs never break.
import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const wasmSrc = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmDst = path.join(root, "public", "mediapipe", "wasm");
const modelDir = path.join(root, "public", "models");

const BASE = "https://storage.googleapis.com/mediapipe-models/pose_landmarker";
const MODELS = {
  "pose_landmarker_lite.task": `${BASE}/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  "pose_landmarker_full.task": `${BASE}/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
};

async function main() {
  if (existsSync(wasmSrc)) {
    await mkdir(wasmDst, { recursive: true });
    await cp(wasmSrc, wasmDst, { recursive: true });
    console.log("[setup] copied MediaPipe wasm ->", path.relative(root, wasmDst));
  } else {
    console.warn("[setup] MediaPipe wasm not found; run npm install first");
  }

  await mkdir(modelDir, { recursive: true });
  for (const [file, url] of Object.entries(MODELS)) {
    const dest = path.join(modelDir, file);
    if (existsSync(dest)) continue;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      console.log("[setup] downloaded", file);
    } catch (err) {
      console.warn(`[setup] could not download ${file}: ${err.message}`);
      console.warn(`        download it manually from ${url} into public/models/`);
    }
  }
}

main().catch((err) => console.warn("[setup] skipped:", err.message));
