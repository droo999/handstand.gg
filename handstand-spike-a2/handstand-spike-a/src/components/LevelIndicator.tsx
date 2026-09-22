import { isWithinLimits, type LevelLimits, type Tilt } from "../hooks/useLevel";

type Props = { tilt: Tilt; isLevel: boolean; limits: LevelLimits; hasData: boolean };

const PITCH_RANGE_DEG = 12; // the pitch bar shows -12° to +12°

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Fixed reference line + a horizon line that rotates as the phone tilts, and a vertical bar
 * showing where the camera is aimed. The green band on the bar is the allowed range (taller
 * above the middle, because a slight upward lean is tolerated). Everything turns green once
 * the phone has been within limits for a moment.
 */
export function LevelIndicator({ tilt, isLevel, limits, hasData }: Props) {
  const near: LevelLimits = {
    rollDeg: 6,
    pitchUpDeg: limits.pitchUpDeg + 4,
    pitchDownDeg: limits.pitchDownDeg + 4,
  };
  const color = isLevel
    ? "var(--ok)"
    : isWithinLimits(tilt, limits) || isWithinLimits(tilt, near)
      ? "var(--warn)"
      : "var(--bad)";

  // Camera aimed up moves the dot up.
  const dotTop = 50 - (clamp(tilt.pitch, -PITCH_RANGE_DEG, PITCH_RANGE_DEG) / PITCH_RANGE_DEG) * 50;
  const bandTop = 50 - (limits.pitchUpDeg / PITCH_RANGE_DEG) * 50;
  const bandHeight = ((limits.pitchUpDeg + limits.pitchDownDeg) / PITCH_RANGE_DEG) * 50;

  let hint = "";
  if (hasData && !isLevel) {
    if (tilt.pitch > limits.pitchUpDeg) hint = "Aim the camera lower";
    else if (tilt.pitch < -limits.pitchDownDeg) hint = "Aim the camera higher";
    else if (Math.abs(tilt.roll) > limits.rollDeg) hint = "Straighten the phone";
    else hint = "Hold still…";
  }

  return (
    <div className="level" aria-live="polite">
      <div className="level-ref" />
      <div
        className="level-horizon"
        style={{ transform: `rotate(${tilt.roll}deg)`, background: color }}
      />
      <div className="level-pitch">
        <div className="level-pitch-band" style={{ top: `${bandTop}%`, height: `${bandHeight}%` }} />
        <div className="level-pitch-dot" style={{ top: `${dotTop}%`, background: color }} />
      </div>
      <div className="level-readout" style={{ color }}>
        {hasData ? (
          <>
            Roll {tilt.roll.toFixed(1)}° · Camera {tilt.pitch >= 0 ? "up" : "down"} {Math.abs(tilt.pitch).toFixed(1)}°
            {hint && <div>{hint}</div>}
          </>
        ) : (
          "Waiting for motion sensor…"
        )}
      </div>
    </div>
  );
}
