import type { Tilt } from "../hooks/useLevel";

type Props = { tilt: Tilt; isLevel: boolean; toleranceDeg: number; hasData: boolean };

const PITCH_RANGE_DEG = 10;

/**
 * Fixed reference line + a horizon line that rotates as the phone tilts. When they line up
 * (and the pitch dot sits in the middle band) the horizon turns green.
 */
export function LevelIndicator({ tilt, isLevel, toleranceDeg, hasData }: Props) {
  const color = isLevel ? "var(--ok)" : Math.abs(tilt.roll) < 6 ? "var(--warn)" : "var(--bad)";
  const pitchPct = 50 + (Math.max(-PITCH_RANGE_DEG, Math.min(PITCH_RANGE_DEG, tilt.pitch)) / PITCH_RANGE_DEG) * 50;
  const bandPct = (toleranceDeg / PITCH_RANGE_DEG) * 50;

  return (
    <div className="level" aria-live="polite">
      <div className="level-ref" />
      <div
        className="level-horizon"
        style={{ transform: `rotate(${tilt.roll}deg)`, background: color }}
      />
      <div className="level-pitch">
        <div className="level-pitch-band" style={{ top: `${50 - bandPct}%`, height: `${bandPct * 2}%` }} />
        <div className="level-pitch-dot" style={{ top: `${pitchPct}%`, background: color }} />
      </div>
      <div className="level-readout" style={{ color }}>
        {hasData
          ? `Roll ${tilt.roll.toFixed(1)}°  Pitch ${tilt.pitch.toFixed(1)}°`
          : "Waiting for motion sensor…"}
      </div>
    </div>
  );
}
