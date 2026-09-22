import { LM, type Landmark } from "./pose";

const MIN_VIS = 0.35;
const LEFT = "#4cc9f0"; // left-side landmarks
const RIGHT = "#ffb04a"; // right-side landmarks
const TORSO_FILL = "rgba(236, 240, 244, 0.16)";
const TORSO_STROKE = "rgba(236, 240, 244, 0.85)";

type Pt = { x: number; y: number };

function pt(lm: Landmark[], i: number, w: number, h: number): Pt | null {
  const p = lm[i];
  if (!p || p.visibility < MIN_VIS) return null;
  return { x: p.x * w, y: p.y * h };
}

function line(ctx: CanvasRenderingContext2D, a: Pt | null, b: Pt | null, color: string, width: number) {
  if (!a || !b) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, p: Pt | null, color: string, r: number) {
  if (!p) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Stick figure: trapezoid torso (shoulders to hips), line limbs, small head circle.
 * Left and right sides use different colors, so a left/right swap (which can happen on
 * inverted poses) is easy to spot.
 */
export function drawStickFigure(
  ctx: CanvasRenderingContext2D,
  lm: Landmark[],
  w: number,
  h: number,
) {
  const s = Math.max(2, Math.round(Math.min(w, h) / 110)); // stroke scale
  const P = (i: number) => pt(lm, i, w, h);

  const lS = P(LM.leftShoulder), rS = P(LM.rightShoulder);
  const lH = P(LM.leftHip), rH = P(LM.rightHip);

  // Torso trapezoid
  if (lS && rS && lH && rH) {
    ctx.fillStyle = TORSO_FILL;
    ctx.strokeStyle = TORSO_STROKE;
    ctx.lineWidth = s;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lS.x, lS.y);
    ctx.lineTo(rS.x, rS.y);
    ctx.lineTo(rH.x, rH.y);
    ctx.lineTo(lH.x, lH.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Limbs
  const limbs: Array<[number[], string]> = [
    [[LM.leftShoulder, LM.leftElbow, LM.leftWrist], LEFT],
    [[LM.rightShoulder, LM.rightElbow, LM.rightWrist], RIGHT],
    [[LM.leftHip, LM.leftKnee, LM.leftAnkle, LM.leftHeel, LM.leftFootIndex, LM.leftAnkle], LEFT],
    [[LM.rightHip, LM.rightKnee, LM.rightAnkle, LM.rightHeel, LM.rightFootIndex, LM.rightAnkle], RIGHT],
  ];
  for (const [chain, color] of limbs) {
    for (let i = 0; i < chain.length - 1; i++) {
      line(ctx, P(chain[i]), P(chain[i + 1]), color, s * 1.8);
    }
    for (const idx of chain) dot(ctx, P(idx), color, s * 1.6);
  }

  // Head
  const nose = P(LM.nose);
  const lE = P(LM.leftEar), rE = P(LM.rightEar);
  let head: Pt | null = null;
  let r = Math.min(w, h) * 0.04;
  if (lE && rE) {
    head = { x: (lE.x + rE.x) / 2, y: (lE.y + rE.y) / 2 };
    r = Math.max(r, Math.hypot(lE.x - rE.x, lE.y - rE.y) * 0.8);
  } else if (nose) {
    head = nose;
  }
  if (head) {
    ctx.strokeStyle = TORSO_STROKE;
    ctx.lineWidth = s;
    ctx.beginPath();
    ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}
