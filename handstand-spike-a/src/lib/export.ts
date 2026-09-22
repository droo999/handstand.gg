import type { Landmark } from "./pose";

/** One inference result. `lm` is flat: x, y, z, visibility for each of the 33 landmarks. */
export type FrameRecord = { t: number; lm: number[] | null };

export type TiltSample = { t: number; roll: number; pitch: number };

/** Page visibility changes while recording (e.g. app switched away, screen locked). */
export type LogEvent = { t: number; type: string };

export type SpikeExport = {
  schema: "handstand-spike-a/v1";
  createdAt: string;
  userAgent: string;
  layout: string;
  video: { width: number; height: number; facing: "user" | "environment" };
  settings: Record<string, unknown>;
  tiltAtStart: { roll: number; pitch: number } | null;
  tiltSamples: TiltSample[];
  events: LogEvent[];
  summary: { durationMs: number; frames: number; poseFrames: number; avgInferenceMs: number };
  frames: FrameRecord[];
};

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Flattens landmarks in the ORIGINAL (un-rotated, un-mirrored) frame coordinates. */
export function flattenLandmarks(lm: Landmark[]): number[] {
  const out: number[] = [];
  for (const p of lm) out.push(round4(p.x), round4(p.y), round4(p.z), round4(p.visibility));
  return out;
}

/**
 * Sends the log to the phone's share sheet (Save to Files, AirDrop, ...). Falls back to a
 * normal file download where sharing files is not supported. Call from a tap handler.
 */
export async function shareOrDownload(data: SpikeExport): Promise<void> {
  const json = JSON.stringify(data);
  const name = `handstand-spike-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

  for (const type of ["application/json", "text/plain"]) {
    const file = new File([json], name, { type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (err) {
        if ((err as DOMException).name === "AbortError") return; // user closed the sheet
        break; // fall through to download
      }
    }
  }

  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
