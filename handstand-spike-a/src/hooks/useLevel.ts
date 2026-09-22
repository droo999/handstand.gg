import { useCallback, useEffect, useRef, useState } from "react";
import type { Facing } from "./useCamera";

export type MotionPermission = "unknown" | "granted" | "denied" | "unsupported";

/** roll: degrees the screen plane is rotated from level. pitch: degrees the camera points above the horizon (negative = below). */
export type Tilt = { roll: number; pitch: number };

/**
 * How far from level the phone may be while still counting as level.
 * Pitch is asymmetric on purpose: a phone propped on the floor usually leans back, so the
 * camera ends up aimed slightly upward. Roll can be corrected later from the logged tilt;
 * pitch (perspective) cannot, so it stays fairly tight.
 */
export type LevelLimits = { rollDeg: number; pitchUpDeg: number; pitchDownDeg: number };
export const DEFAULT_LIMITS: LevelLimits = { rollDeg: 2, pitchUpDeg: 6, pitchDownDeg: 3 };

/**
 * iOS Safari reports accelerationIncludingGravity with the opposite sign to Android and the
 * spec. If the pitch readout says "up" when you aim the camera down, flip this to false/true.
 */
export const GRAVITY_READS_INVERTED =
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/**
 * Turns a gravity reading into tilt angles, in degrees.
 *  - roll is wrapped to the nearest 90°, so portrait, landscape and upside-down all read 0
 *    when level. It is also independent of the iOS/Android sign convention.
 *  - pitch is measured along the camera you are using (back camera looks out of the back of
 *    the phone, front camera out of the screen). Positive = camera aimed above the horizon.
 */
export function computeTilt(
  x: number,
  y: number,
  z: number,
  facing: Facing = "environment",
  invertedGravity: boolean = GRAVITY_READS_INVERTED,
): Tilt {
  const inPlane = (Math.atan2(x, y) * 180) / Math.PI;
  const roll = ((((inPlane + 45) % 90) + 90) % 90) - 45;

  // In spec convention the reading points UP in device coordinates.
  const alongCamera = (facing === "environment" ? -z : z) * (invertedGravity ? -1 : 1);
  const pitch = (Math.atan2(alongCamera, Math.hypot(x, y)) * 180) / Math.PI;
  return { roll, pitch };
}

export function isWithinLimits(t: Tilt, limits: LevelLimits): boolean {
  return (
    Math.abs(t.roll) <= limits.rollDeg && t.pitch <= limits.pitchUpDeg && t.pitch >= -limits.pitchDownDeg
  );
}

/** iOS requires an explicit permission request, and it must run inside a tap handler. */
export async function requestMotionPermission(): Promise<MotionPermission> {
  const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } })
    .DeviceMotionEvent;
  if (!DME) return "unsupported";
  if (typeof DME.requestPermission === "function") {
    try {
      return (await DME.requestPermission()) === "granted" ? "granted" : "denied";
    } catch {
      return "denied";
    }
  }
  return "granted";
}

type Options = { facing?: Facing; limits?: LevelLimits; holdMs?: number };

/**
 * Level gate: `isLevel` becomes true once the tilt stays within `limits` for `holdMs`,
 * and false as soon as it leaves them.
 */
export function useLevel(
  active: boolean,
  { facing = "environment", limits = DEFAULT_LIMITS, holdMs = 600 }: Options = {},
) {
  const [permission, setPermission] = useState<MotionPermission>("unknown");
  const [tilt, setTilt] = useState<Tilt>({ roll: 0, pitch: 0 });
  const [isLevel, setIsLevel] = useState(false);
  const [hasData, setHasData] = useState(false);

  const latest = useRef<Tilt>({ roll: 0, pitch: 0 }); // unthrottled, for logging
  const smooth = useRef({ x: 0, y: 0, z: 0, ready: false });
  const levelSince = useRef<number | null>(null);
  const lastUi = useRef(0);

  const request = useCallback(async () => {
    const result = await requestMotionPermission();
    setPermission(result);
    return result;
  }, []);

  const { rollDeg, pitchUpDeg, pitchDownDeg } = limits;

  useEffect(() => {
    if (!active || permission !== "granted") return;
    const lim: LevelLimits = { rollDeg, pitchUpDeg, pitchDownDeg };
    levelSince.current = null;
    smooth.current.ready = false;

    const onMotion = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null || g.y == null || g.z == null) return;

      // Low-pass filter so hand tremor and sensor noise don't flicker the gate.
      const s = smooth.current;
      const a = 0.2;
      if (!s.ready) {
        s.x = g.x; s.y = g.y; s.z = g.z; s.ready = true;
      } else {
        s.x += a * (g.x - s.x);
        s.y += a * (g.y - s.y);
        s.z += a * (g.z - s.z);
      }

      const t = computeTilt(s.x, s.y, s.z, facing);
      latest.current = t;

      const now = performance.now();
      if (isWithinLimits(t, lim)) {
        if (levelSince.current == null) levelSince.current = now;
      } else {
        levelSince.current = null;
      }

      if (now - lastUi.current > 66) {
        lastUi.current = now;
        setTilt(t);
        setIsLevel(levelSince.current != null && now - levelSince.current >= holdMs);
        setHasData(true);
      }
    };

    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [active, permission, facing, rollDeg, pitchUpDeg, pitchDownDeg, holdMs]);

  return { permission, request, tilt, isLevel, hasData, latest, limits };
}
