import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

export type Landmark = { x: number; y: number; z: number; visibility: number };
export type ModelVariant = "lite" | "full";
export type DelegatePref = "auto" | "cpu";

/** MediaPipe pose landmark indices we use (of the 33 it returns). */
export const LM = {
  nose: 0,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;

export type LandmarkerHandle = {
  landmarker: PoseLandmarker;
  delegate: "GPU" | "CPU";
};

/** Loads the self-hosted wasm + model (see scripts/setup-assets.mjs). */
export async function createPoseLandmarker(
  variant: ModelVariant,
  pref: DelegatePref,
): Promise<LandmarkerHandle> {
  const base = import.meta.env.BASE_URL;
  const vision = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
  const modelAssetPath = `${base}models/pose_landmarker_${variant}.task`;

  const make = (delegate: "GPU" | "CPU") =>
    PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

  if (pref === "cpu") return { landmarker: await make("CPU"), delegate: "CPU" };
  try {
    return { landmarker: await make("GPU"), delegate: "GPU" };
  } catch (err) {
    console.warn("GPU delegate failed, falling back to CPU", err);
    return { landmarker: await make("CPU"), delegate: "CPU" };
  }
}

/**
 * Prepares each camera frame for inference: downscales to `maxSide` and optionally rotates
 * it 180 degrees so an inverted person looks upright to the model.
 * If rotated, the returned landmarks must be mapped back with `unrotate180`.
 */
export class FrameSource {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;

  prepare(video: HTMLVideoElement, rotate180: boolean, maxSide: number): HTMLCanvasElement {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(vw, vh)) : 1;
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (rotate180) {
      ctx.translate(w, h);
      ctx.rotate(Math.PI);
    }
    ctx.drawImage(video, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return this.canvas;
  }
}

/** Maps landmarks detected on a 180-degree-rotated frame back to the original frame. */
export function unrotate180(lm: Landmark[]): Landmark[] {
  return lm.map((p) => ({ x: 1 - p.x, y: 1 - p.y, z: p.z, visibility: p.visibility }));
}
