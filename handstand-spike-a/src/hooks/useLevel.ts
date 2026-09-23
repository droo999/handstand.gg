import { useCallback, useEffect, useRef, useState } from "react";

export type MotionPermission = "unknown" | "granted" | "denied" | "unsupported";
export type Tilt = { roll: number; pitch: number };

/**
 * Turns a gravity reading into tilt angles, in degrees.
 *  - roll: how far the screen plane is rotated from level, wrapped to the nearest 90 degrees,
 *    so portrait, landscape and upside-down all read 0 when level. This also makes the result
 *    independent of iOS/Android sign conventions for accelerationIncludingGravity.
 *  - pitch: how far the camera axis points above/below the horizon (0 = phone vertical).
 *    The SIGN of pitch differs between iOS and Android. Pitch is logged but not gated on.
 */
export function computeTilt(x: number, y: number, z: number): Tilt {
  const inPlane = (Math.atan2(x, y) * 180) / Math.PI;
  const roll = ((((inPlane + 45) % 90) + 90) % 90) - 45;
  const pitch = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
  return { roll, pitch };
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

type Options = { toleranceDeg?: number; holdMs?: number; maxPitchDeg?: number };

/**
 * Level gate: `isLevel` becomes true once |roll| stays within tolerance for `holdMs`, and false
 * as soon as it leaves it. Inclining or declining the phone (pitch) is allowed, up to
 * `maxPitchDeg`: near flat, almost no gravity falls in the screen plane, so roll is just noise.
 */
export function useLevel(
  active: boolean,
  { toleranceDeg = 1.5, holdMs = 600, maxPitchDeg = 26 }: Options = {},
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

  useEffect(() => {
    if (!active || permission !== "granted") return;
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

      const t = computeTilt(s.x, s.y, s.z);
      latest.current = t;

      const now = performance.now();
      const within = Math.abs(t.roll) <= toleranceDeg && Math.abs(t.pitch) <= maxPitchDeg;
      if (within) {
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
  }, [active, permission, toleranceDeg, holdMs, maxPitchDeg]);

  return { permission, request, tilt, isLevel, hasData, latest, toleranceDeg, maxPitchDeg };
}
