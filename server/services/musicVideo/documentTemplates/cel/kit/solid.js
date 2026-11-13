// Geometry for cel.js: ring-based posed solids with surface normals, plus 2D ink details.
// The cel renderer supplies true depth, flat paint, shadows and silhouette lines.
import { add, apply, cross, dot, len, norm, scale, sub, frameAlong, fromCols, TAU, noise2 } from './core.js';

/** Ring of `n` points in the XZ plane of frame (o, R); rx is half-width, rz half-depth. */
export function ring(o, R, rx, rz, { n = 14, ox = 0, oz = 0, exp = 2, flatBack = 0, lift = null, wave = null } = {}) {
  const pts = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * TAU;
    let c = Math.cos(a), s = Math.sin(a);
    if (exp !== 2) { c = Math.sign(c) * Math.pow(Math.abs(c), 2 / exp); s = Math.sign(s) * Math.pow(Math.abs(s), 2 / exp); }
    let z = oz + rz * s;
    if (flatBack && s < 0) z = oz + rz * s * (1 - flatBack);
    const k = wave ? 1 + wave(a) : 1;
    pts[i] = add(o, apply(R, [ox + rx * c * k, lift ? lift(a) : 0, z * k]));
  }
  return pts;
}

/** A solid from rings (all the same length). Ends are capped. */
export function loft(rings, props = {}) {
  const n = rings[0].length;
  const centers = rings.map((r) => scale(r.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / n));
  const normals = rings.map((r, i) => r.map((p, j) => {
    const du = sub(r[(j + 1) % n], r[(j + n - 1) % n]);
    const up = rings[Math.min(rings.length - 1, i + 1)][j], down = rings[Math.max(0, i - 1)][j];
    let nrm = cross(du, sub(up, down));
    if (len(nrm) < 1e-9) nrm = sub(p, centers[i]);
    nrm = norm(nrm);
    return dot(nrm, sub(p, centers[i])) < 0 ? scale(nrm, -1) : nrm;
  }));
  const axis0 = norm(sub(centers[0], centers[Math.min(1, centers.length - 1)]));
  const axis1 = norm(sub(centers[centers.length - 1], centers[Math.max(0, centers.length - 2)]));
  return { rings, normals, centers, capNormals: [axis0, axis1], ...props };
}

/** Tube from a to b. stations: [{ s, rx, rz, ox, oz, exp }]; `forward` orients the sections' depth axis. */
export function tube(a, b, stations, forward, props = {}, n = 14) {
  const R = frameAlong(sub(b, a), forward);
  const rings = stations.map((st) => ring(add(a, scale(sub(b, a), st.s)), R, st.rx, st.rz ?? st.rx, { n, ox: st.ox || 0, oz: st.oz || 0, exp: st.exp || 2 }));
  return loft(rings, props);
}

/**
 * One solid along a chain of joints (hip, knee, ankle ...). stations: [{ u, rx, rz, ox, oz }] where u counts
 * bones (1.0 is the first joint). `forwards` gives each bone's depth axis. Corners are rounded over `blend` metres.
 */
export function chain(joints, stations, forwards, props = {}, n = 14, blend = 0.05) {
  const bones = [];
  for (let i = 0; i < joints.length - 1; i += 1) {
    const d = sub(joints[i + 1], joints[i]);
    bones.push({ a: joints[i], b: joints[i + 1], l: len(d) || 1e-6, R: frameAlong(d, forwards[Math.min(i, forwards.length - 1)]) });
  }
  const mixR = (A, B, k) => {
    const y = norm([A[1] + (B[1] - A[1]) * k, A[4] + (B[4] - A[4]) * k, A[7] + (B[7] - A[7]) * k]);
    const z0 = [A[2] + (B[2] - A[2]) * k, A[5] + (B[5] - A[5]) * k, A[8] + (B[8] - A[8]) * k];
    const x = norm(cross(y, z0));
    return fromCols(x, y, cross(x, y));
  };
  const rings = stations.map((st) => {
    const i = Math.max(0, Math.min(bones.length - 1, Math.floor(st.u - 1e-9)));
    const bone = bones[i];
    const local = st.u - i;
    let o = add(bone.a, scale(sub(bone.b, bone.a), local));
    let R = bone.R;
    // Near a joint: follow a rounded corner and turn the section gradually.
    const nextBone = bones[i + 1], prevBone = bones[i - 1];
    const dNext = (1 - local) * bone.l, dPrev = local * bone.l;
    if (nextBone && dNext < blend) {
      const k = 0.5 * (1 - dNext / blend);
      const p0 = add(bone.b, scale(sub(bone.a, bone.b), blend / bone.l)), p2 = add(bone.b, scale(sub(nextBone.b, bone.b), blend / nextBone.l));
      o = add(add(scale(p0, (1 - k) * (1 - k)), scale(bone.b, 2 * k * (1 - k))), scale(p2, k * k));
      R = mixR(bone.R, nextBone.R, k);
    } else if (prevBone && dPrev < blend) {
      const k = 0.5 + 0.5 * (dPrev / blend);
      const p0 = add(bone.a, scale(sub(prevBone.a, bone.a), blend / prevBone.l)), p2 = add(bone.a, scale(sub(bone.b, bone.a), blend / bone.l));
      o = add(add(scale(p0, (1 - k) * (1 - k)), scale(bone.a, 2 * k * (1 - k))), scale(p2, k * k));
      R = mixR(prevBone.R, bone.R, k);
    }
    return ring(o, R, st.rx, st.rz ?? st.rx, { n, ox: st.ox || 0, oz: st.oz || 0, exp: st.exp || 2 });
  });
  return loft(rings, props);
}

/**
 * A view: orthographic, `s` pixels per metre, world origin drawn at (cx, cy).
 * V rotates the world into view space (x right, y up, z toward the viewer).
 */
export function makeView({ V, s, cx, cy, wobble = 0, wobbleSeed = 0 }) {
  const project = (p) => {
    const x = V[0] * p[0] + V[1] * p[1] + V[2] * p[2];
    const y = V[3] * p[0] + V[4] * p[1] + V[5] * p[2];
    const z = V[6] * p[0] + V[7] * p[1] + V[8] * p[2];
    let px = cx + s * x, py = cy - s * y;
    if (wobble) {
      // A slow field, new on every drawing, so lines breathe the way re-traced cels do.
      px += noise2(px * 0.011 + wobbleSeed * 7.1, py * 0.011, 3) * wobble;
      py += noise2(px * 0.011, py * 0.011 + wobbleSeed * 5.3, 9) * wobble;
    }
    return [px, py, z];
  };
  return { V, s, cx, cy, project, depthOf: (p) => V[6] * p[0] + V[7] * p[1] + V[8] * p[2], facing: (nrm) => V[6] * nrm[0] + V[7] * nrm[1] + V[8] * nrm[2] };
}

/** Tapered ink line through points (Catmull-Rom), drawn as a filled ribbon. width: px at the middle. */
export function inkLine(ctx, points, { width = 2.4, color = '#1a1630', taper = 0.35, taperEnd = null, samples = 10 } = {}) {
  if (points.length < 2) return;
  const pts = [];
  const P = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < samples; k += 1) {
      const u = k / samples, u2 = u * u, u3 = u2 * u;
      pts.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * u + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * u + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3),
      ]);
    }
  }
  pts.push(points[points.length - 1]);
  const total = pts.length - 1;
  const endTaper = taperEnd ?? taper;
  const left = [], right = [];
  for (let i = 0; i <= total; i += 1) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(total, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const u = i / total;
    let w = 1;
    if (taper > 0 && u < taper) w = Math.sin((u / taper) * Math.PI / 2);
    if (endTaper > 0 && u > 1 - endTaper) w = Math.min(w, Math.sin(((1 - u) / endTaper) * Math.PI / 2));
    const h = (width / 2) * Math.max(0.12, w);
    left.push([pts[i][0] - dy * h, pts[i][1] + dx * h]);
    right.push([pts[i][0] + dy * h, pts[i][1] - dx * h]);
  }
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < left.length; i += 1) ctx.lineTo(left[i][0], left[i][1]);
  for (let i = right.length - 1; i >= 0; i -= 1) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** Closed smooth shape through points (midpoint quadratics). */
export function blobPath(points) {
  const path = new Path2D();
  const n = points.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(points[n - 1], points[0]);
  path.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i += 1) { const m = mid(points[i], points[(i + 1) % n]); path.quadraticCurveTo(points[i][0], points[i][1], m[0], m[1]); }
  path.closePath();
  return path;
}

export { frameAlong, fromCols };
