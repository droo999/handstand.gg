import type { Tilt } from "../hooks/useLevel";

type Props = { tilt: Tilt; isLevel: boolean; maxPitchDeg: number; hasData: boolean };

/**
 * Fixed reference line + a horizon line that rotates as the phone tilts left/right. When they
 * line up the horizon turns green. Inclining or declining the phone doesn't matter.
 */
export function LevelIndicator({ tilt, isLevel, maxPitchDeg, hasData }: Props) {
  const tooFlat = Math.abs(tilt.pitch) > maxPitchDeg;
  const color = isLevel ? "var(--ok)" : !tooFlat && Math.abs(tilt.roll) < 6 ? "var(--warn)" : "var(--bad)";

  return (
    <div className="level" aria-live="polite">
      <div className="level-ref" />
      <div
        className="level-horizon"
        style={{ transform: `rotate(${tilt.roll}deg)`, background: color }}
      />
      <div className="level-readout" style={{ color }}>
        {!hasData
          ? "Waiting for motion sensor…"
          : tooFlat
            ? "Phone is too flat. Stand it up more"
            : `Roll ${tilt.roll.toFixed(1)}°  Pitch ${tilt.pitch.toFixed(1)}°`}
      </div>
    </div>
  );
}
