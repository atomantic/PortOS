// An original example figure: ochre pinafore, warm skin and shoulder-length moss hair.
// Builds solids for a solved skeleton; customize the palette and profiles for your own cast.
import { add, apply, at, clamp, col, dot, frame, len, lerp, lerp3, norm, scale, sub, smooth, TAU } from './core.js';
import { ring, loft, tube, chain, inkLine } from './solid.js';
import { headSolids, drawFace, hairPoint, hairBottom, HEAD_SCALE } from './head.js';

export const DEFAULT_PALETTE = {
  skin: '#c58e68', skinShade: '#8d5d4c',
  dress: '#d7ad47', dressShade: '#987335',
  hair: '#445643', hairShade: '#2b392e', hairLight: '#81936a',
  ink: '#302d29', inkSoft: '#715c48', lash: '#302d29',
  lip: '#995b49', mouthInside: '#543b33', blush: 'rgba(181,98,65,0.25)', blush0: 'rgba(181,98,65,0)',
  eyeWhite: '#f2ead2', eyeWhiteShade: '#c6b99d', iris: '#4e633f', irisLight: '#92a75c', pupil: '#252c22', glint: '#fff6dc',
  lineWidth: 2.2,
};

export const MAT = { skin: 1, face: 2, hair: 3, dress: 4 };
const skinProps = (pal, extra = {}) => ({ color: pal.skin, shadow: pal.skinShade, order: 1, mat: MAT.skin, inkGroup: 1, ...extra });

function legSolids(l, P, pal, side) {
  const mid = lerp3(l.hip, l.ankle, 0.5);
  let f = sub(l.knee, mid);
  f = len(f) < 0.015 ? col(P.R, 2) : norm(f);
  const fwd = norm(add(f, scale(col(P.R, 2), 0.5)));
  const group = side > 0 ? 'legL' : 'legR';
  // Hip to ankle as one form: a full thigh, the kneecap, the calf set back, a fine ankle.
  const leg = chain([l.hip, l.knee, l.ankle], [
    { u: 0.0, rx: 0.076, rz: 0.084 }, { u: 0.14, rx: 0.081, rz: 0.088 }, { u: 0.42, rx: 0.071, rz: 0.077 },
    { u: 0.72, rx: 0.056, rz: 0.061 }, { u: 0.9, rx: 0.047, rz: 0.052, oz: 0.003 }, { u: 1.0, rx: 0.0445, rz: 0.049, oz: 0.006 },
    { u: 1.08, rx: 0.0445, rz: 0.049, oz: 0.002 }, { u: 1.22, rx: 0.048, rz: 0.055, oz: -0.011 }, { u: 1.42, rx: 0.0445, rz: 0.049, oz: -0.008 },
    { u: 1.7, rx: 0.033, rz: 0.035, oz: -0.002 }, { u: 1.9, rx: 0.0265, rz: 0.029 }, { u: 2.0, rx: 0.0255, rz: 0.0275 },
  ], [fwd, fwd], skinProps(pal, { name: 'leg', group }), 24, 0.055);
  // Foot: a low wedge from the heel to the toes.
  const heel = add(l.ankle, apply(l.Rfoot, [0, -0.038, -0.04]));
  const toe = add(l.ankle, apply(l.Rfoot, [0, -0.061, 0.158]));
  const up = apply(l.Rfoot, [0, 1, 0]);
  const foot = tube(heel, toe, [
    { s: 0.0, rx: 0.020, rz: 0.022 }, { s: 0.1, rx: 0.028, rz: 0.031, oz: 0.008 }, { s: 0.32, rx: 0.032, rz: 0.031, oz: 0.011 },
    { s: 0.6, rx: 0.037, rz: 0.021, oz: 0.004 }, { s: 0.86, rx: 0.035, rz: 0.013 }, { s: 1.0, rx: 0.022, rz: 0.007 },
  ], up, skinProps(pal, { name: 'foot', group }), 12);
  return { leg, foot, side };
}

function armSolids(a, hand, pal, side) {
  const group = side > 0 ? 'armL' : 'armR';
  const props = (name, extra = {}) => skinProps(pal, { name, order: 2, depthBias: 0.035, group, ...extra });
  const stations = [
    { u: 0.0, rx: 0.012, rz: 0.014 }, { u: 0.035, rx: 0.026, rz: 0.029 }, { u: 0.085, rx: 0.033, rz: 0.036 }, { u: 0.16, rx: 0.0355, rz: 0.038 }, { u: 0.34, rx: 0.0335, rz: 0.0355 }, { u: 0.7, rx: 0.029, rz: 0.031 },
    { u: 0.92, rx: 0.026, rz: 0.0275 }, { u: 1.0, rx: 0.0255, rz: 0.0265 }, { u: 1.1, rx: 0.027, rz: 0.0285 }, { u: 1.26, rx: 0.0285, rz: 0.0295 },
    { u: 1.66, rx: 0.0225, rz: 0.0215 }, { u: 1.92, rx: 0.0185, rz: 0.0165 }, { u: 2.0, rx: 0.018, rz: 0.015 },
  ];
  const forwards = [col(a.Rua, 2), col(a.Rfa, 2)];
  // The cap of the shoulder belongs to the torso's outline; the arm grows out of it without a seam.
  const cut = 5;
  const whole = chain([a.shoulder, a.elbow, a.wrist], stations, forwards, {}, 20, 0.04);
  const deltoid = loft(whole.rings.slice(0, cut + 1), skinProps(pal, { name: 'deltoid', group: 'torso', order: 1, depthBias: 0.03 }));
  const arm = loft(whole.rings.slice(cut - 1), props('arm', { openStart: 0.046 }));
  // Hand: slim, fingers together and a little curled. Thickness along local X, width along Z, fingers along -Y.
  const R = hand.R;
  const curl = hand.curl ?? 0.4;
  const shape = [[0, 0.0105, 0.0185], [0.022, 0.0115, 0.028], [0.058, 0.011, 0.0335], [0.088, 0.0095, 0.031], [0.118, 0.008, 0.0245], [0.14, 0.0055, 0.015], [0.15, 0.003, 0.006]];
  const rings = shape.map(([d, rx, rz]) => {
    const bend = Math.max(0, d - 0.058);
    const o = add(hand.o, apply(R, [-side * curl * bend * bend * 10, -d + curl * bend * bend * 1.6, 0.002]));
    return ring(o, R, rx, rz, { n: 12 });
  });
  const palm = loft(rings, props('hand'));
  const thumbA = add(hand.o, apply(R, [-side * 0.003, -0.022, 0.022]));
  const thumbB = add(hand.o, apply(R, [-side * 0.016, -0.076, 0.043]));
  const thumb = tube(thumbA, thumbB, [{ s: 0, rx: 0.0115, rz: 0.011 }, { s: 0.55, rx: 0.0085, rz: 0.008 }, { s: 1, rx: 0.005, rz: 0.0045 }], apply(R, [0, 0, 1]), props('thumb'), 10);
  return { deltoid, arm, palm, thumb, side };
}

/** All solids for a solved skeleton. opts: { skirtLag, hairSway, detail } (world-space vectors, metres). */
export function buildFigure(sk, pal = DEFAULT_PALETTE, opts = {}) {
  const { P, W, C, N, H } = sk;
  const legL = legSolids(sk.legL, P, pal, 1), legR = legSolids(sk.legR, P, pal, -1);
  const armL = armSolids(sk.armL, sk.handL, pal, 1), armR = armSolids(sk.armR, sk.handR, pal, -1);

  const R = (f, y, rx, rz, oz = 0, extra = {}) => ring(at(f, [0, y, 0]), f.R, rx, rz, { n: 44, oz, ...extra });
  // Skin above the dress: collar, sloping shoulders, the root of the neck.
  const torso = loft([
    R(C, -0.02, 0.114, 0.088), R(C, 0.045, 0.122, 0.080), R(C, 0.082, 0.132, 0.070), R(C, 0.104, 0.134, 0.060, -0.004),
    R(C, 0.122, 0.118, 0.054, -0.006), R(C, 0.14, 0.096, 0.052, -0.008), R(C, 0.158, 0.072, 0.048, -0.012), R(C, 0.176, 0.054, 0.045, -0.016), R(C, 0.198, 0.042, 0.041, -0.018),
  ], skinProps(pal, { name: 'torso', group: 'torso' }));
  const neck = tube(at(N, [0, -0.04, -0.002]), at(H, [0, 0.07, 0.0]), [{ s: 0, rx: 0.043, rz: 0.042 }, { s: 0.22, rx: 0.036, rz: 0.037 }, { s: 0.55, rx: 0.0325, rz: 0.0345 }, { s: 1, rx: 0.033, rz: 0.037 }], col(N.R, 2), skinProps(pal, { name: 'neck', group: 'torso', depthBias: 0.004 }), 24);

  // Pinafore: a straight bodice and a flared skirt. Below the hips the cloth is draped over the legs: every ring of the
  // skirt is the wrap of both thighs plus its own fullness, so a leg swinging forward pushes the cloth out
  // instead of passing through it. Lower rings trail where the body just was (opts.prev: an earlier pose).
  const lat = col(P.R, 0), fwd = col(P.R, 2);
  const alongLeg = (l, s) => (s <= 1 ? lerp3(l.hip, l.knee, s) : lerp3(l.knee, l.ankle, s - 1));
  const legRadius = (s) => lerp(0.088, 0.05, clamp(s));
  const prev = opts.prev;
  const skirtRing = (s, full, k) => {
    const cL = alongLeg(sk.legL, s), cR = alongLeg(sk.legR, s);
    let centre = lerp3(cL, cR, 0.5);
    if (prev) {
      const before = lerp3(alongLeg(prev.legL, s), alongLeg(prev.legR, s), 0.5);
      centre = add(centre, scale(sub(before, centre), 0.75 * k * k));
    }
    centre = add(centre, scale(opts.skirtLag || [0, 0, 0], k));
    const pts = [];
    const n = 72;
    for (let i = 0; i < n; i += 1) {
      const ang = (i / n) * TAU, c = Math.cos(ang), sn = Math.sin(ang);
      const u = add(scale(lat, c), scale(fwd, sn));
      let r = Math.hypot(full[0] * c, full[1] * sn);
      for (const p of [cL, cR]) r = Math.max(r, dot(sub(p, centre), u) + legRadius(s) + 0.016);
      r *= 1 + 0.03 * k * Math.sin(ang * 5 + 0.6) + 0.016 * k * Math.sin(ang * 9 + 2.1);
      pts.push(add(centre, scale(u, r)));
    }
    return pts;
  };
  const hemAt = opts.hem ?? 1.12;
  const skirtLevels = [1, 0.8, 0.6, 0.42, 0.26, 0.12].map((k) => skirtRing(hemAt * k, [lerp(0.166, 0.205, k), lerp(0.112, 0.146, k)], k));
  const D = (f, y, rx, rz, oz = 0, extra = {}) => ring(at(f, [0, y, 0]), f.R, rx, rz, { n: 72, oz, ...extra });
  const scoop = (ang) => -0.01 * Math.cos(ang * 2); // shallow square-neck variation
  const dress = loft([
    ...skirtLevels,
    D(P, -0.02, 0.162, 0.110), D(P, 0.05, 0.130, 0.093),
    D(W, 0.0, 0.106, 0.081), D(W, 0.07, 0.112, 0.087),
    D(C, -0.02, 0.122, 0.097, 0.010), D(C, 0.03, 0.128, 0.104, 0.019), D(C, 0.066, 0.124, 0.093, 0.011), D(C, 0.096, 0.122, 0.08, 0.002, { lift: scoop }),
  ], { name: 'dress', color: pal.dress, shadow: pal.dressShade, order: 2, depthBias: -0.02, noCaps: true, mat: MAT.dress, inkGroup: 4 });
  const strapPart = (pts) => loft(pts.map((p) => ring(at(C, p), C.R, 0.014, 0.007, { n: 8 })), { name: 'strap', color: pal.dress, shadow: pal.dressShade, order: 2, depthBias: 0, lineWidth: pal.lineWidth * 0.7, mat: MAT.dress, inkGroup: 4 });
  const straps = [];
  for (const side of [1, -1]) {
    straps.push(strapPart([[side * 0.074, 0.058, 0.09], [side * 0.076, 0.094, 0.073], [side * 0.078, 0.122, 0.05], [side * 0.08, 0.14, 0.012]]));
    straps.push(strapPart([[side * 0.08, 0.14, 0.012], [side * 0.08, 0.128, -0.038], [side * 0.078, 0.09, -0.068]]));
  }

  const H2 = frame(sk.headCenter, H.R);
  let sway = opts.hairSway || [0, 0, 0];
  if (prev && opts.hairLag) {
    const d = add(scale(sub(prev.headCenter, sk.headCenter), opts.hairLag), opts.hairStream || [0, 0, 0]);
    sway = [dot(d, col(H.R, 0)), dot(d, col(H.R, 1)), dot(d, col(H.R, 2))];
  }
  const { head, hairBack, hairFront } = headSolids(H2, pal, { sway, detail: opts.detail || 1 });

  const solids = [
    hairBack,
    legL.leg, legL.foot, legR.leg, legR.foot,
    torso, neck, armL.deltoid, armR.deltoid, dress, ...straps,
    armL.arm, armL.palm, armL.thumb, armR.arm, armR.palm, armR.thumb,
    head, hairFront,
  ];
  return { solids, H2, parts: { head, hairFront, hairBack, neck, torso, dress, legL, legR, armL, armR, C } };
}

function dressDetail(ctx, parts, view, pal) {
  // Fold lines from the hip toward the hem follow the skirt rings, so they swing with it.
  const rings = parts.dress.rings;
  const n = rings[0].length;
  ctx.save();
  for (let fold = 0; fold < 5; fold += 1) {
    // One line down each valley of the hem's wave.
    const j = Math.round((0.1309 + 0.2 * fold) * n) % n;
    const normal = parts.dress.normals[1][j];
    if (view.facing(normal) < 0.1) continue;
    const pts = [rings[4][j], rings[3][j], rings[2][j], rings[1][j], rings[0][j]].map(view.project);
    inkLine(ctx, pts, { width: pal.lineWidth * 0.8, color: pal.dressShade, taper: 0.75, taperEnd: 0.02 });
  }
  ctx.restore();
}

export { clamp };

/**
 * Draw the figure with the cel camera (cel.js): true depth, cast shadows, ink on every overlap.
 * `stage` lends the scratch canvases for the 2D-drawn details; `cel` is makeCel(W, H).
 */
export function drawFigure(ctx, cel, stage, built, view, { light, pal = DEFAULT_PALETTE, face = {}, lineWidth = pal.lineWidth, wobble = 0.5, wobbleSeed = 0, centre } = {}) {
  const { solids, H2, parts } = built;
  const local = { ...pal, lineWidth };
  const flat = makeViewLike(view);
  // 2D details, each laid only onto the surface it belongs to.
  const faceC = stage.scratch('ov-face');
  drawFace(faceC.getContext('2d'), H2, flat, local, face, 1);
  const hairC = stage.scratch('ov-hair');
  hairSheen(hairC.getContext('2d'), H2, flat, light, local);
  const bodyC = stage.scratch('ov-body');
  const bg = bodyC.getContext('2d');
  dressDetail(bg, parts, flat, local);
  const materials = [null,
    { lit: pal.skin, shade: pal.skinShade, depthStep: 1.5 }, { lit: pal.skin, shade: pal.skinShade, depthStep: 2.4, castReach: 0.034 },
    { lit: pal.hair, shade: pal.hairShade, backDark: true }, { lit: pal.dress, shade: pal.dressShade, backDark: true }];
  const drawn = solids.filter((s) => s.name !== 'hairFront');
  const image = cel.render({
    solids: drawn, view, light, centre: centre || [parts.C.o[0], parts.C.o[1] - 0.35, parts.C.o[2]], materials,
    overlays: [{ canvas: faceC, materials: [MAT.face] }, { canvas: hairC, materials: [MAT.hair] }, { canvas: bodyC, materials: [MAT.dress] }],
    lineWidth, ink: pal.ink, wobble, wobbleSeed,
  });
  ctx.drawImage(image, 0, 0);
}

// The 2D details are projected without the painter's own line wobble (the cel camera adds its own).
function makeViewLike(view) {
  const { V, s, cx, cy } = view;
  return {
    V, s, cx, cy,
    project: (p) => [cx + s * (V[0] * p[0] + V[1] * p[1] + V[2] * p[2]), cy - s * (V[3] * p[0] + V[4] * p[1] + V[5] * p[2]), V[6] * p[0] + V[7] * p[1] + V[8] * p[2]],
    facing: (n) => V[6] * n[0] + V[7] * n[1] + V[8] * n[2],
  };
}

function hairSheen(ctx, H2, view, light, pal) {
  const world = (p) => add(H2.o, apply(H2.R, scale(p, HEAD_SCALE)));
  const P = (phi, v) => view.project(world(hairPoint(phi, v)));
  const facingAt = (phi) => view.facing(apply(H2.R, [Math.sin(phi), 0, Math.cos(phi)]));
  const lightLocal = [dot(light, col(H2.R, 0)), dot(light, col(H2.R, 1)), dot(light, col(H2.R, 2))];
  const phiL = Math.atan2(lightLocal[0], lightLocal[2]);
  ctx.fillStyle = pal.hairLight;
  for (let k = 0; k < 11; k += 1) {
    const u = (k + 0.5) / 11;
    const phi = phiL + (u - 0.5) * 2.1 + 0.05 * Math.sin(k * 7.3);
    if (facingAt(phi) < 0.12) continue;
    const env = Math.sin(u * Math.PI);
    const half = (0.035 + 0.03 * Math.abs(Math.sin(k * 3.7))) * env;
    const wide = 0.045 + 0.03 * Math.abs(Math.sin(k * 5.1));
    const v0 = 0.3 + 0.012 * Math.sin(k * 2.3);
    const pts = [P(phi - wide, v0), P(phi, v0 - half * 0.55), P(phi + wide, v0), P(phi + wide * 0.2, v0 + half)];
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill();
  }
  for (let k = 0; k < 22; k += 1) {
    const phi = -Math.PI + (k + 0.5) * (TAU / 22) + 0.07 * Math.sin(k * 12.9);
    if (facingAt(phi) < 0.05) continue;
    const fringe = hairBottom(phi) > -0.05;
    const v0 = fringe ? 0.62 + 0.1 * Math.sin(k * 3.1) : 0.5 + 0.12 * Math.sin(k * 5.7);
    inkLine(ctx, [P(phi, v0), P(phi + 0.012, (v0 + 1) / 2), P(phi + 0.02, 0.985)], { width: pal.lineWidth * 0.85, color: pal.ink, taper: 0.6, taperEnd: 0.05 });
  }
}
