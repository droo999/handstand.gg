import type { Tilt } from "../hooks/useLevel";

type Props = { tilt: Tilt; isLevel: boolean; maxPitchDeg: number; hasData: boolean };
type Status = "ok" | "warn" | "bad";

/**
 * Fixed reference line + a horizon line that rotates as the phone tilts left/right. When they
 * line up (green) the phone is level enough to record. Inclining or declining the phone
 * (pitch) doesn't matter, up to `maxPitchDeg`.
 */
export function LevelIndicator({ tilt, isLevel, maxPitchDeg, hasData }: Props) {
  const tooFlat = Math.abs(tilt.pitch) > maxPitchDeg;
  const status: Status = isLevel ? "ok" : !tooFlat && Math.abs(tilt.roll) < 6 ? "warn" : "bad";
  const color = status === "ok" ? "var(--ok)" : status === "warn" ? "var(--warn)" : "var(--bad)";

  const message = !hasData
    ? "Waiting for motion sensor…"
    : status === "ok"
      ? `Roll ${tilt.roll.toFixed(1)}°  Pitch ${tilt.pitch.toFixed(1)}°`
      : status === "warn"
        ? "Please tilt phone less"
        : tooFlat
          ? "Phone is too flat. Stand it up more"
          : "Hold phone in portrait";

  return (
    <div className="level" aria-live="polite">
      <div className="level-ref" />
      <div
        className="level-horizon"
        style={{ transform: `rotate(${tilt.roll}deg)`, background: color }}
      />
      <div className="level-readout" style={{ color }}>
        {message}
      </div>
    </div>
  );
}
