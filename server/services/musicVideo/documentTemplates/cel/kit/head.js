// An original example head, drawn from any angle.
//
// The head and the hair are surfaces of revolution-like shapes described by profiles over height
// (half-width, front depth, back depth), so a turn of the head keeps the figure on model. The face itself
// (eyes, nose, mouth, blush) is drawn in 2D on patches that ride the surface.
import { add, apply, clamp, cross, lerp, norm, scale, sub, smooth, TAU } from './core.js';
import { loft, inkLine, blobPath } from './solid.js';

/** Smooth curve through [x, y] keys (Catmull-Rom on y, clamped ends). */
function curve(keys) {
  return (x) => {
    if (x <= keys[0][0]) return keys[0][1];
    const n = keys.length - 1;
    if (x >= keys[n][0]) return keys[n][1];
    let i = 1;
    while (keys[i][0] < x) i += 1;
    const p0 = keys[Math.max(0, i - 2)][1], p1 = keys[i - 1][1], p2 = keys[i][1], p3 = keys[Math.min(n, i + 1)][1];
    const u = (x - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
    const v = 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
    return Math.max(Math.min(p1, p2) - 0.004, Math.min(Math.max(p1, p2) + 0.004, v));
  };
}

export const HEAD = { top: 0.118, chin: -0.122, eyeY: -0.018, eyePhi: 0.43, noseY: -0.055, mouthY: -0.086, eye: 1.0 };

// Skull + face. y in metres from the head centre; phi 0 is straight ahead, +phi toward the figure’s left.
const W = curve([[-0.122, 0.011], [-0.117, 0.0235], [-0.107, 0.0355], [-0.09, 0.0485], [-0.068, 0.059], [-0.042, 0.0665], [-0.012, 0.0715], [0.02, 0.0745], [0.055, 0.070], [0.085, 0.056], [0.104, 0.038], [0.114, 0.021], [0.118, 0.006]]);
const F = curve([[-0.122, 0.050], [-0.116, 0.066], [-0.106, 0.0745], [-0.092, 0.079], [-0.075, 0.083], [-0.05, 0.086], [-0.02, 0.086], [0.01, 0.089], [0.045, 0.087], [0.08, 0.070], [0.105, 0.040], [0.118, 0.004]]);
const B = curve([[-0.122, 0.020], [-0.1, 0.036], [-0.07, 0.062], [-0.03, 0.086], [0.02, 0.096], [0.06, 0.088], [0.09, 0.064], [0.108, 0.036], [0.118, 0.004]]);
const bump = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));

// How far the nose stands off the face at height y: nothing at the brow, most at the tip, cut back under it.
const noseRise = (y) => (y > HEAD.noseY ? Math.pow(smooth(clamp((-0.016 - y) / (-0.016 - HEAD.noseY))), 1.25) : clamp(1 - (HEAD.noseY - y) / 0.0085));
// The underside of the head is not level: from the chin it climbs past the angle of the jaw to the nape.
const jawLift = (phi, y) => {
  const down = clamp((-0.035 - y) / 0.087);
  const back = (1 - Math.cos(phi)) / 2;
  return 0.072 * Math.pow(down, 1.15) * smooth(clamp((back - 0.1) / 0.72));
};

/** A point on the head surface, in head-local metres. */
function headPoint(phi, y) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const w = W(y) * 1.12;
  let d = c >= 0 ? F(y) : B(y);
  // The face is flatter across the front than a circle; the chin comes to a soft point.
  const e = c >= 0 ? lerp(2.0, 2.35, clamp((y + 0.11) / 0.07)) : 2;
  const cc = Math.sign(c) * Math.pow(Math.abs(c), 2 / e), ss = Math.sign(s) * Math.pow(Math.abs(s), 2 / e);
  if (c > 0) {
    d += 0.0105 * Math.exp(-((phi / 0.15) ** 2)) * noseRise(y);                                     // nose
    d += 0.0026 * Math.exp(-((phi / 0.3) ** 2)) * bump(y, HEAD.mouthY, 0.012);                     // lips
    d -= 0.0030 * bump(Math.abs(phi), 0.42, 0.22) * bump(y, HEAD.eyeY, 0.02);                       // eye sockets
    d += 0.0030 * bump(Math.abs(phi), 0.8, 0.3) * bump(y, -0.052, 0.03);                            // cheeks
  }
  return [w * ss, y + jawLift(phi, y), d * cc];
}

// Shoulder-length hair with a high, side-swept opening and outward ends.
const HAIR = { top: 0.128, fringe: 0.064, bottom: -0.205, opening: 0.92, edge: 0.3 };
const WH = curve([[-0.205, 0.104], [-0.16, 0.099], [-0.112, 0.09], [-0.098, 0.086], [-0.06, 0.0895], [-0.01, 0.0875], [0.04, 0.084], [0.075, 0.073], [0.1, 0.056], [0.116, 0.037], [0.1245, 0.02], [0.128, 0.007]]);
const FH = curve([[-0.205, 0.055], [-0.16, 0.066], [-0.112, 0.074], [-0.06, 0.092], [-0.01, 0.098], [0.03, 0.101], [0.07, 0.092], [0.1, 0.071], [0.116, 0.046], [0.1245, 0.024], [0.128, 0.008]]);
const BH = curve([[-0.205, 0.086], [-0.16, 0.097], [-0.112, 0.10], [-0.095, 0.088], [-0.05, 0.103], [0.0, 0.108], [0.05, 0.102], [0.09, 0.083], [0.112, 0.055], [0.1235, 0.03], [0.128, 0.009]]);
const wrapPhi = (phi) => Math.abs(((phi + Math.PI) % TAU + TAU) % TAU - Math.PI);
export function hairBottom(phi) {
  return lerp(HAIR.fringe, HAIR.bottom, smooth(clamp((wrapPhi(phi + 0.22) - HAIR.opening) / HAIR.edge)));
}
/** v runs 0 (crown) to 1 (the ends); across the face the hair stops at the fringe. */
export function hairPoint(phi, v, sway = [0, 0, 0]) {
  const y = Math.max(lerp(HAIR.top, HAIR.bottom, v), hairBottom(phi));
  const c = Math.cos(phi), s = Math.sin(phi);
  const d = c >= 0 ? FH(y) : BH(y);
  const hang = clamp((HAIR.fringe - y) / (HAIR.fringe - HAIR.bottom)); // 0 at the fringe line, 1 at the ends
  const lag = hang * hang;
  return [WH(y) * s + sway[0] * lag, y + sway[1] * lag, d * c + sway[2] * lag];
}
export const hairV = (y) => clamp((HAIR.top - y) / (HAIR.top - HAIR.bottom));

/** Solids for the head and hair in frame H2 (origin at the head centre). */
export const HEAD_SCALE = 1.06;
export function headSolids(H2, pal, { sway = [0, 0, 0], detail = 1 } = {}) {
  const world = (p) => add(H2.o, apply(H2.R, scale(p, HEAD_SCALE)));
  const nPhi = Math.round(80 * detail), nY = Math.round(36 * detail);
  const headRings = [];
  for (let i = 0; i <= nY; i += 1) {
    const y = lerp(HEAD.chin, HEAD.top, i / nY);
    const r = [];
    for (let j = 0; j < nPhi; j += 1) r.push(world(headPoint((j / nPhi) * TAU, y)));
    headRings.push(r);
  }
  const hairRings = [];
  const nV = Math.round(28 * detail);
  for (let i = 0; i <= nV; i += 1) {
    const r = [];
    for (let j = 0; j < nPhi; j += 1) r.push(i === 0 ? world([0, HAIR.top + 0.0005, 0]) : world(hairPoint((j / nPhi) * TAU, i / nV, sway)));
    hairRings.push(r);
  }
  const head = loft(headRings, { name: 'head', color: pal.skin, shadow: pal.skinShade, order: 2, depthBias: 0.02, shadeBias: -0.42, mat: 2, inkGroup: 1 });
  const hairBack = loft(hairRings, { name: 'hairBack', color: pal.hairShade, shadow: pal.hairShade, order: 0, mat: 3, inkGroup: 3, noCaps: true });
  const hairFront = loft(hairRings, { name: 'hairFront', color: pal.hair, shadow: pal.hairShade, order: 2, depthBias: 0.06, frontOnly: true, shadeBias: 0.2 });
  return { head, hairBack, hairFront };
}

/** Map patch coordinates (u across toward the figure’s left, w up, metres) at (phi0, y0) to a world point on the face. */
function facePatch(H2, phi0, y0) {
  const p0 = headPoint(phi0, y0);
  const rho = Math.hypot(p0[0], p0[2]);
  return (u, w, lift = 0.0012) => {
    const p = headPoint(phi0 + u / rho, y0 + w);
    const k = 1 + lift / Math.max(0.02, rho);
    return add(H2.o, apply(H2.R, scale([p[0] * k, p[1], p[2] * k], HEAD_SCALE)));
  };
}
function patchNormal(H2, phi0, y0) {
  const e = 0.01;
  const a = headPoint(phi0 + e, y0), b = headPoint(phi0 - e, y0), c = headPoint(phi0, y0 + e), d = headPoint(phi0, y0 - e);
  return apply(H2.R, norm(cross(sub(a, b), sub(c, d))));
}

/**
 * Draw the face on top of the painted head. `face`: { blink 0..1, gaze [x, y] -1..1, mouth 0..1 open, brow, smile }.
 */
export function drawFace(ctx, H2, view, pal, face = {}, scalePx = 1) {
  const { blink = 0, gaze = [0, 0], mouth = 0, smile = 0 } = face;
  const P = (pt) => view.project(pt);
  const lw = pal.lineWidth * scalePx;
  const simple = view.s < 700;

  // Blush first, under the lines.
  for (const side of [1, -1]) {
    const n = patchNormal(H2, side * 0.78, -0.055);
    const facing = view.facing(n);
    if (facing < 0.15) continue;
    const patch = facePatch(H2, side * 0.78, -0.055);
    const c = P(patch(0, 0)), ex = P(patch(0.02, 0)), ey = P(patch(0, 0.012));
    const rx = Math.hypot(ex[0] - c[0], ex[1] - c[1]), ry = Math.hypot(ey[0] - c[0], ey[1] - c[1]);
    ctx.save();
    ctx.translate(c[0], c[1]);
    ctx.scale(1, ry / Math.max(1, rx));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, rx));
    g.addColorStop(0, pal.blush); g.addColorStop(1, pal.blush0);
    ctx.fillStyle = g; ctx.globalAlpha = clamp(facing * 1.4);
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1, rx), 0, TAU); ctx.fill();
    ctx.restore();
  }

  // Eyes.
  for (const side of [1, -1]) {
    const n = patchNormal(H2, side * HEAD.eyePhi, HEAD.eyeY);
    const facing = view.facing(n);
    if (facing < 0.12) continue;
    const patch = facePatch(H2, side * HEAD.eyePhi, HEAD.eyeY);
    // u runs toward the figure’s left; mirror so "outer" is always away from the nose.
    const E = (u, w) => P(patch(side * u * HEAD.eye, w * HEAD.eye));
    const open = 1 - blink;
    const upper = [[-0.0175, -0.0015], [-0.011, 0.0055 * open + 0.0005], [-0.002, 0.0098 * open], [0.008, 0.0092 * open], [0.0158, 0.0036 * open - 0.0012], [0.0195, -0.0006]].map(([u, w]) => E(u, w));
    const lower = [[0.0195, -0.0006], [0.0145, -0.0058 * open - 0.0012], [0.004, -0.0092 * open - 0.001], [-0.007, -0.0085 * open - 0.001], [-0.0175, -0.0015]].map(([u, w]) => E(u, w));
    if (simple) {
      ctx.fillStyle = pal.lash; ctx.fill(blobPath([...upper, ...lower.slice(1, -1)]));
      if (open > 0.3) { const gl = E(-0.004, 0.003); ctx.fillStyle = pal.glint; ctx.beginPath(); ctx.arc(gl[0], gl[1], Math.max(0.9, view.s * 0.0026), 0, TAU); ctx.fill(); }
      continue;
    }
    if (open > 0.12) {
      const shape = blobPath([...upper, ...lower.slice(1, -1)]);
      ctx.save();
      ctx.clip(shape);
      ctx.fillStyle = pal.eyeWhite; ctx.fill(shape);
      // Shadow the lid casts across the top of the eye.
      ctx.fillStyle = pal.eyeWhiteShade;
      ctx.fill(blobPath([E(-0.019, 0.012), E(0.021, 0.012), E(0.021, 0.0042 * open), E(0.0, 0.0058 * open), E(-0.019, 0.0005)]));
      const gx = gaze[0] * 0.0035 * side, gy = gaze[1] * 0.002;
      const ic = E(0.0008 + gx, -0.0002 + gy), ix = E(0.0008 + gx + 0.0088, -0.0002 + gy), iy = E(0.0008 + gx, -0.0002 + gy + 0.0098);
      const rx = Math.hypot(ix[0] - ic[0], ix[1] - ic[1]), ry = Math.hypot(iy[0] - ic[0], iy[1] - ic[1]);
      const ang = Math.atan2(ix[1] - ic[1], ix[0] - ic[0]);
      ctx.fillStyle = pal.iris;
      ctx.beginPath(); ctx.ellipse(ic[0], ic[1], rx, ry, ang, 0, TAU); ctx.fill();
      ctx.fillStyle = pal.irisLight;
      ctx.beginPath(); ctx.ellipse(ic[0], ic[1] + ry * 0.42, rx * 0.72, ry * 0.5, ang, 0, TAU); ctx.fill();
      ctx.fillStyle = pal.pupil;
      ctx.beginPath(); ctx.ellipse(ic[0], ic[1] - ry * 0.05, rx * 0.5, ry * 0.56, ang, 0, TAU); ctx.fill();
      ctx.fillStyle = pal.glint;
      ctx.beginPath(); ctx.ellipse(ic[0] - rx * 0.36, ic[1] - ry * 0.4, rx * 0.3, ry * 0.26, ang, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(ic[0] + rx * 0.36, ic[1] + ry * 0.42, rx * 0.13, ry * 0.11, ang, 0, TAU); ctx.fill();
      ctx.restore();
    }
    // Lash line: the heaviest line on the face, with a flick at the outer corner.
    inkLine(ctx, upper, { width: lw * (2.5 + 0.6 * (1 - open)), color: pal.lash, taper: 0.3, taperEnd: 0.16 });
    inkLine(ctx, [E(0.0158, 0.0036 * open - 0.0012), E(0.0205, 0.001 * open + 0.0004), E(0.0232, 0.0038 * open + 0.0004)], { width: lw * 1.5, color: pal.lash, taper: 0.1, taperEnd: 0.7 });
    if (open > 0.12) inkLine(ctx, lower.slice(0, 4), { width: lw * 0.75, color: pal.ink, taper: 0.4, taperEnd: 0.5 });
    // Brow: a fine arc that shows just under the fringe.
    inkLine(ctx, [E(-0.0135, 0.0198 + (face.brow || 0) * 0.002), E(-0.002, 0.0232 + (face.brow || 0) * 0.003), E(0.0125, 0.0212), E(0.0185, 0.0182)], { width: lw * 0.9, color: pal.ink, taper: 0.35, taperEnd: 0.55 });
    // Crease above the lid.
    inkLine(ctx, [E(-0.011, 0.0122), E(-0.001, 0.015), E(0.011, 0.0128)], { width: lw * 0.5, color: pal.inkSoft, taper: 0.5 });
  }

  // Nose. Turned, its far edge is a line from the bridge to the tip; facing us it is only the small shadow
  // under the tip. Both lie on the face itself, so they turn with the head.
  const fwd = apply(H2.R, [0, 0, 1]);
  const turned = Math.abs(view.V[0] * fwd[0] + view.V[1] * fwd[1] + view.V[2] * fwd[2]); // 0 facing us, 1 in profile
  const farSide = (view.V[0] * fwd[0] + view.V[1] * fwd[1] + view.V[2] * fwd[2]) > 0 ? 1 : -1; // which way the face points on screen
  const leftOnScreen = view.V[0] * H2.R[0] + view.V[1] * H2.R[3] + view.V[2] * H2.R[6];        // the figure’s left, across the screen
  const far = farSide * Math.sign(leftOnScreen || 1);                                            // +1: the far edge is toward the figure’s left
  const onFace = (phi, y) => P(add(H2.o, apply(H2.R, scale(headPoint(phi, y), HEAD_SCALE))));
  if (!simple && view.facing(fwd) > 0.05) {
    const ridge = smooth(clamp((turned - 0.14) / 0.28)) * (1 - smooth(clamp((turned - 0.82) / 0.14)));
    if (ridge > 0.02) {
      ctx.globalAlpha = ridge;
      inkLine(ctx, [onFace(far * 0.05, -0.03), onFace(far * 0.06, -0.044), onFace(far * 0.055, HEAD.noseY + 0.001), onFace(far * 0.02, HEAD.noseY - 0.0065)], { width: lw * 0.9, color: pal.ink, taper: 0.5, taperEnd: 0.2 });
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 1 - 0.6 * smooth(clamp((turned - 0.3) / 0.4));
    inkLine(ctx, [onFace(-0.03, HEAD.noseY - 0.0075), onFace(0, HEAD.noseY - 0.0095), onFace(0.03, HEAD.noseY - 0.0075)], { width: lw * 0.7, color: pal.inkSoft, taper: 0.5 });
    ctx.globalAlpha = 1;
  }

  // Mouth: small, rose, parted a little.
  const mouthN = patchNormal(H2, 0, HEAD.mouthY);
  if (view.facing(mouthN) > 0.1) {
    const m = facePatch(H2, 0, HEAD.mouthY);
    const M = (u, w) => P(m(u, w, 0.002));
    const half = 0.0125, up = smile * 0.0022;
    const top = [M(-half, up), M(-half * 0.45, 0.0022), M(0, 0.0012), M(half * 0.45, 0.0022), M(half, up)];
    const bottom = [M(half, up), M(half * 0.5, -0.0048 - mouth * 0.006), M(0, -0.006 - mouth * 0.008), M(-half * 0.5, -0.0048 - mouth * 0.006), M(-half, up)];
    ctx.fillStyle = pal.lip;
    if (simple) { ctx.fill(blobPath([M(-half * 0.8, 0.001), M(0, 0.002), M(half * 0.8, 0.001), M(0, -0.0045)])); return; }
    ctx.fill(blobPath([...top, ...bottom.slice(1, -1)]));
    if (mouth > 0.15) { ctx.fillStyle = pal.mouthInside; ctx.fill(blobPath([M(-half * 0.7, up - 0.0005), M(0, 0.0002), M(half * 0.7, up - 0.0005), M(half * 0.4, -0.003 - mouth * 0.006), M(-half * 0.4, -0.003 - mouth * 0.006)])); }
    inkLine(ctx, [M(-half, up), M(-half * 0.45, 0.0006), M(0, -0.0002), M(half * 0.45, 0.0006), M(half, up)], { width: lw * 0.95, color: pal.ink, taper: 0.3 });
  }
}

export { scale };
