// The figure's skeleton: joint positions and bone frames from a pose. Metres, Y up.
// At yaw 0 the figure faces +Z (toward the viewer); +X is the figure’s left.
import { add, apply, at, child, clamp, col, cross, dot, frame, len, mul, mulAll, norm, rotX, rotY, rotZ, scale, sub, I3, frameAlong } from './core.js';

export const DIM = {
  hipX: 0.082, hipY: -0.04,
  thigh: 0.435, shin: 0.415, ankle: 0.07, foot: 0.215, heel: 0.05,
  waistY: 0.11, chestY: 0.15, neckY: 0.188, neckLen: 0.046, headY: 0.108,
  shoulderX: 0.142, shoulderY: 0.116,
  upperArm: 0.262, foreArm: 0.232, hand: 0.165,
};
/** Height of the pelvis centre when standing straight. */
export const STAND = DIM.thigh + DIM.shin + DIM.ankle - DIM.hipY;

/** Two-bone IK: the middle joint for root a, target c, lengths l1 and l2, bending toward `pole`. */
export function ik2(a, c, l1, l2, pole) {
  const d = sub(c, a);
  const full = len(d);
  const D = clamp(full, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const dir = full > 1e-6 ? scale(d, 1 / full) : [0, -1, 0];
  const cosA = clamp((l1 * l1 + D * D - l2 * l2) / (2 * l1 * D), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  let p = sub(pole, scale(dir, dot(pole, dir)));
  if (len(p) < 1e-5) p = cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  p = norm(p);
  const mid = add(a, add(scale(dir, l1 * cosA), scale(p, l1 * sinA)));
  const end = add(a, scale(dir, D));
  return { mid, end };
}

const DEFAULT = {
  pos: [0, STAND, 0], yaw: 0, pitch: 0, roll: 0,
  spine: [0, 0, 0],            // bend forward, twist (toward the figure’s left), lean to the figure’s left
  neck: [0, 0, 0], head: [0, 0, 0], // pitch (nod down +), yaw (toward the figure’s left +), roll
  armL: { swing: 0, raise: 0.1, twist: 0, bend: 0.12 }, armR: { swing: 0, raise: 0.1, twist: 0, bend: 0.12 },
  handL: [0, 0, 0], handR: [0, 0, 0],
  legL: null, legR: null,       // { foot: [x, y, z] ankle in the world, yaw, pitch, pole }
};

function arm(C, side, spec, dims) {
  const shoulder = at(C, [side * dims.shoulderX, dims.shoulderY, -0.012]);
  let Rua;
  let elbow, wrist;
  if (spec.target) {
    const pole = spec.pole || add(scale(col(C.R, 0), side * 0.4), add(scale(col(C.R, 1), -1), scale(col(C.R, 2), -0.5)));
    const { mid, end } = ik2(shoulder, spec.target, dims.upperArm, dims.foreArm, norm(pole));
    elbow = mid; wrist = end;
    // Bone frames: Y points back up the bone, so the tube runs along -Y; Z is the hinge's forward side.
    Rua = frameAlong(sub(shoulder, elbow), sub(wrist, elbow));
  } else {
    Rua = mulAll(C.R, rotZ(side * spec.raise), rotX(-spec.swing), rotY(side * (spec.twist || 0)));
    elbow = add(shoulder, apply(Rua, [0, -dims.upperArm, 0]));
    const Rfa0 = mul(Rua, rotX(-(spec.bend || 0)));
    wrist = add(elbow, apply(Rfa0, [0, -dims.foreArm, 0]));
  }
  const Rfa = frameAlong(sub(elbow, wrist), col(Rua, 2));
  return { shoulder, elbow, wrist, Rua, Rfa };
}

function leg(P, side, spec, dims, yaw) {
  const hip = at(P, [side * dims.hipX, dims.hipY, 0]);
  const ankleRest = add(hip, [0, -(dims.thigh + dims.shin) * 0.999, 0]);
  const target = spec?.foot || ankleRest;
  const footYaw = spec?.yaw ?? yaw;
  const forward = apply(rotY(footYaw), [0, 0, 1]);
  const pole = spec?.pole || norm(add(col(P.R, 2), scale(forward, 0.6)));
  const { mid, end } = ik2(hip, target, dims.thigh, dims.shin, pole);
  const Rfoot = mul(rotY(footYaw), rotX(spec?.pitch || 0));
  return { hip, knee: mid, ankle: end, Rfoot, forward };
}

/** Joint positions and frames for a pose. */
export function solve(input, dims = DIM) {
  const pose = { ...DEFAULT, ...input };
  const P = frame(pose.pos, mulAll(rotY(pose.yaw), rotX(pose.pitch), rotZ(pose.roll)));
  const [bend, twist, side] = pose.spine;
  const part = (k) => mulAll(rotY(twist * k), rotX(bend * k), rotZ(-side * k));
  const W = child(P, [0, dims.waistY, 0], part(0.45));
  const C = child(W, [0, dims.chestY, 0], part(0.55));
  const N = child(C, [0, dims.neckY, -0.018], mulAll(rotY(pose.neck[1]), rotX(pose.neck[0]), rotZ(pose.neck[2])));
  const H = child(N, [0, dims.neckLen, 0.01], mulAll(rotY(pose.head[1]), rotX(pose.head[0]), rotZ(pose.head[2])));
  const headCenter = at(H, [0, dims.headY, 0.026]);
  const L = arm(C, 1, pose.armL, dims), R = arm(C, -1, pose.armR, dims);
  const handFrame = (a, spec) => frame(a.wrist, mulAll(a.Rfa, rotX(spec[0]), rotY(spec[1]), rotZ(spec[2])));
  return {
    pose, dims, P, W, C, N, H, headCenter,
    armL: L, armR: R, handL: handFrame(L, pose.handL), handR: handFrame(R, pose.handR),
    legL: leg(P, 1, pose.legL, dims, pose.yaw), legR: leg(P, -1, pose.legR, dims, pose.yaw),
  };
}
export { I3 };

const blendR = (A, B, k) => {
  // Blend two rotations by their axes and square the result up again; fine for the small angles of a spine.
  const y = [A[1] + (B[1] - A[1]) * k, A[4] + (B[4] - A[4]) * k, A[7] + (B[7] - A[7]) * k];
  const z = [A[2] + (B[2] - A[2]) * k, A[5] + (B[5] - A[5]) * k, A[8] + (B[8] - A[8]) * k];
  const yn = norm(y);
  const x = norm(cross(yn, z));
  const zn = cross(x, yn);
  return [x[0], yn[0], zn[0], x[1], yn[1], zn[1], x[2], yn[2], zn[2]];
};

/**
 * The same skeleton, posed from targets instead of angles (for captured motion):
 * { pelvis: [x,y,z], pelvisR, chestR, headR, wristL, wristR, elbowL, elbowR (pole directions),
 *   handRL, handRR, ankleL, ankleR, kneeL, kneeR (pole directions), footL: { yaw, pitch }, footR }
 */
export function solveTargets(t, dims = DIM) {
  const P = frame(t.pelvis, t.pelvisR);
  const W = frame(at(P, [0, dims.waistY, 0]), blendR(t.pelvisR, t.chestR, 0.45));
  const C = frame(at(W, [0, dims.chestY, 0]), t.chestR);
  const N = frame(at(C, [0, dims.neckY, -0.018]), blendR(t.chestR, t.headR, 0.45));
  const H = frame(at(N, [0, dims.neckLen, 0.01]), t.headR);
  const headCenter = at(H, [0, dims.headY, 0.026]);
  const arm = (side, wrist, pole, R) => {
    const shoulder = at(C, [side * dims.shoulderX, dims.shoulderY, -0.012]);
    const { mid, end } = ik2(shoulder, wrist(shoulder), dims.upperArm, dims.foreArm, norm(pole));
    const Rua = frameAlong(sub(shoulder, mid), sub(end, mid));
    const Rfa = frameAlong(sub(mid, end), col(Rua, 2));
    return { arm: { shoulder, elbow: mid, wrist: end, Rua, Rfa }, hand: frame(end, R || Rfa) };
  };
  const leg = (side, ankle, pole, foot) => {
    const hip = at(P, [side * dims.hipX, dims.hipY, 0]);
    const { mid, end } = ik2(hip, ankle(hip), dims.thigh, dims.shin, norm(pole));
    const Rfoot = mul(rotY(foot.yaw), rotX(foot.pitch));
    return { hip, knee: mid, ankle: end, Rfoot, forward: apply(rotY(foot.yaw), [0, 0, 1]), toe: foot.toe || 0 };
  };
  const L = arm(1, t.wristL, t.elbowL, t.handRL), R = arm(-1, t.wristR, t.elbowR, t.handRR);
  return {
    pose: null, dims, P, W, C, N, H, headCenter,
    armL: L.arm, armR: R.arm, handL: L.hand, handR: R.hand,
    legL: leg(1, t.ankleL, t.kneeL, t.footL), legR: leg(-1, t.ankleR, t.kneeR, t.footR),
  };
}
