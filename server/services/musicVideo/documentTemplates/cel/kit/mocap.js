// Captured or authored joint paths fitted to the example skeleton.
// Rows contain 25 XYZ joints followed by head-forward, head-up and four hand axes.
// Retargeting preserves figure proportions while retaining the source timing and arcs.
import { add, sub, scale, norm, cross, lerp3, apply, rotY, len, fromCols, clamp, lerp } from './core.js';
import { DIM, solveTargets } from './skeleton.js';

const NAMES = ['root', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'ballL', 'ballR', 'toeL', 'toeR', 'spine1', 'spine2', 'chest', 'neck1', 'neck2', 'headTop', 'shL', 'shR', 'elL', 'elR', 'wrL', 'wrR', 'handL', 'handR'];
const AT = Object.fromEntries(NAMES.map((n, i) => [n, i * 3]));
const EXTRA = NAMES.length * 3; // head forward, head up, handL y, handL z, handR y, handR z

/** A row at fractional frame f. `loop` wraps (walk cycles); otherwise the ends hold. */
export function sampleRow(data, f, loop = false) {
  const n = data.frames.length - (loop ? 1 : 0);
  let i = Math.floor(f), k = f - i;
  if (loop) { i = ((i % n) + n) % n; } else if (i < 0) { i = 0; k = 0; } else if (i >= n - 1) { i = n - 1; k = 0; }
  const A = data.frames[i], B = data.frames[Math.min(data.frames.length - 1, i + 1)];
  const out = new Array(A.length);
  for (let c = 0; c < A.length; c += 1) out[c] = A[c] + (B[c] - A[c]) * k;
  return out;
}

/**
 * Fit a row to the figure. opts: { yaw (turn the whole motion), at: [x, y, z] added after the turn,
 * shift: [x, y, z] extra travel for everything but planted feet, plantL, plantR (0..1) }.
 */
export function retarget(row, data, opts = {}) {
  const { yaw = 0, at = [0, 0, 0], shift = [0, 0, 0], plantL = 0, plantR = 0 } = opts;
  const R = rotY(yaw);
  const kL = (DIM.thigh + DIM.shin) / data.leg, kA = (DIM.upperArm + DIM.foreArm) / data.arm;
  const raw = (name) => [row[AT[name]], row[AT[name] + 1], row[AT[name] + 2]];
  const dir = (i) => apply(R, [row[EXTRA + i * 3], row[EXTRA + i * 3 + 1], row[EXTRA + i * 3 + 2]]);
  const turned = (name) => apply(R, raw(name));
  // Where a captured point sits in figure space: scaled about the ground, so planted feet stay planted.
  const place = (p) => add([p[0] * kL, (p[1] - data.ankle) * kL + DIM.ankle, p[2] * kL], at);
  const hipL = turned('hipL'), hipR = turned('hipR');
  const hipMid = lerp3(hipL, hipR, 0.5);
  const px = norm(sub(hipL, hipR));
  const pz = norm(cross(px, norm(sub(turned('spine1'), hipMid))));
  const pelvisR = fromCols(px, cross(pz, px), pz);
  const pelvis = add(add(place(hipMid), apply(pelvisR, [0, -DIM.hipY, 0])), shift);
  const cx = norm(sub(turned('shL'), turned('shR')));
  const cz = norm(cross(cx, norm(sub(turned('neck1'), turned('spine2')))));
  const chestR = fromCols(cx, cross(cz, cx), cz);
  const hz = norm(dir(0));
  const hx = norm(cross(dir(1), hz));
  const headR = fromCols(hx, cross(hz, hx), hz);
  const handR = (i) => {
    const y = norm(dir(i));
    const x = norm(cross(y, dir(i + 1)));
    return fromCols(x, y, cross(x, y));
  };
  const reach = (from, to, k) => (origin) => add(origin, scale(sub(turned(to), turned(from)), k));
  const pole = (from, mid, to, fallback) => { const p = sub(turned(mid), lerp3(turned(from), turned(to), 0.5)); return len(p) < 0.01 ? fallback : p; };
  const foot = (side) => {
    const d = sub(turned(`ball${side}`), turned(`ankle${side}`));
    const t = sub(turned(`toe${side}`), turned(`ball${side}`));
    const drop = Math.atan2(-d[1], Math.hypot(d[0], d[2]));
    const toeDrop = Math.atan2(-t[1], Math.hypot(t[0], t[2]));
    return { yaw: Math.atan2(d[0], d[2]), pitch: drop - data.footDrop, toe: clamp(drop - toeDrop, 0, 1.2) };
  };
  // A planted foot keeps its place on the ground while a held drawing travels on.
  const ankle = (side, plant) => (hip) => {
    const moving = add(hip, scale(sub(turned(`ankle${side}`), turned(`hip${side}`)), kL));
    return plant > 0 ? lerp3(moving, sub(moving, shift), plant) : moving;
  };
  return solveTargets({
    pelvis, pelvisR, chestR, headR,
    wristL: reach('shL', 'wrL', kA), wristR: reach('shR', 'wrR', kA),
    elbowL: pole('shL', 'elL', 'wrL', [0, -1, -0.3]), elbowR: pole('shR', 'elR', 'wrR', [0, -1, -0.3]),
    handRL: handR(2), handRR: handR(4),
    ankleL: ankle('L', plantL), ankleR: ankle('R', plantR),
    kneeL: pole('hipL', 'kneeL', 'ankleL', pz), kneeR: pole('hipR', 'kneeR', 'ankleR', pz),
    footL: foot('L'), footR: foot('R'),
  });
}

/**
 * A captured walk on the beat. The cycle's left heel strike lands on even beats, the right on odd ones.
 * `beat` is where the root really is; `drawBeat` the held beat the drawing is made from. Travel is the captured
 * stride scaled to the legs, so the feet never slide.
 * opts: { heading (0 walks toward +Z), origin: [x, z], beatsPerCycle (2) }
 */
export function walkOn(data, beat, drawBeat, opts = {}) {
  const { heading = 0, origin = [0, 0], beatsPerCycle = 2 } = opts;
  const kL = (DIM.thigh + DIM.shin) / data.leg;
  const stride = (data.travel * kL) / beatsPerCycle; // metres per beat
  const phase = (b) => (((b / beatsPerCycle) % 1) + 1) % 1;
  const f = phase(drawBeat) * data.n;
  const row = sampleRow(data, f, true);
  const fwd = apply(rotY(heading), [0, 0, 1]);
  const drawTravel = drawBeat * stride, travel = beat * stride;
  const i = Math.round(f) % data.n;
  const sk = retarget(row, data, {
    yaw: heading,
    at: [origin[0] + fwd[0] * drawTravel, 0, origin[1] + fwd[2] * drawTravel],
    shift: scale(fwd, travel - drawTravel),
    plantL: data.plantL[i], plantR: data.plantR[i],
  });
  return { sk, stride, travel, phase: phase(drawBeat) };
}

export { lerp };
