/**
 * Measures swept-arc and outline curvature for Three.js scene parts declared to be curved.
 */

import { tokenizeSpecIdentifier } from './threejsModelSpecNames.js';
import { vectorLength } from './threejsTransform.js';

// Swept-arc curvature gate. A generated spec routinely DECLARES a curved feature
// — a horn, a tail, a hook, a bent conduit — and then implements it with a
// straight run of control points. Every bounds-based check is blind to that: the
// bounding box of a straight tube is a perfectly reasonable box, nothing
// penetrates anything, the part touches its parent, and the silhouette from the
// generated camera can even be right. Only the SHAPE of the swept path says the
// horn does not curve.
//
// Two different measurements, because the two sweep geometries carry their
// curvature in different places:
//
//  * `tube` sweeps a circle along an explicit list of control points, so the
//    curvature lives in that polyline. The points are fitted to their best-fit
//    plane and then to a circle within it, and the path counts as curved when it
//    rides that circle — a fit its points really lie on, spanning a minimum
//    angle, with the centre a bounded distance from the path — or, for a bend
//    that rides no single circle at all, when its excursion from its own
//    best-fit line is large enough to see. Each bound below rejects a different
//    degenerate fit.
//  * `extrude` sweeps a closed outline along a STRAIGHT axis, so there is no
//    sweep path to fit an arc to — and a closed ring is useless as one, since it
//    has no endpoints and always turns a full 360°. Its curvature is in the
//    outline's silhouette instead: a curved form (crescent, hook, claw) has a
//    concave side, while a straight tapered spike is convex however finely it is
//    subdivided. So the outline is measured by how much of its turning is
//    concave.
//
// Both gates fire only on a part the spec itself declares curved — by name, or
// through a `detailInventory` feature that names it. `tube` and `extrude` are
// the right answer for plenty of straight parts (a rail, a plate, a strut), so a
// straight sweep is evidence of nothing until something says it was meant to
// bend.

// How far a path has to turn to read as a curve rather than as authoring slack.
// The travel is accumulated as an ABSOLUTE sum per segment rather than as the
// signed range about the fitted centre: an S-curved tail sweeps one way and then
// back, and a signed range would cancel those halves and report a genuinely
// curved path as straight.
export const SWEPT_ARC_MIN_SPAN_DEGREES = 25;

// Absolute accumulation means authoring noise ADDS UP instead of cancelling, so
// a jittered straight run reaches the span threshold without ever bending. A
// span is therefore only credited when the points actually LIE on the circle
// that was fitted to them, measured as RMS radial error against its radius.
const SWEPT_ARC_MAX_RADIAL_ERROR_RATIO = 0.05;

// And the fitted circle has to sit alongside the path rather than out at
// infinity: an arc riding one circle puts its centre about a radius away, which
// at 25° of span is 2.25 times the path's own extent. For a clean fit this
// agrees with the span bound by construction — it is the bound that still holds
// when the fit is only approximate, and the span it produced cannot be trusted
// on its own.
const SWEPT_ARC_MAX_CENTER_DISTANCE_RATIO = 3;

// An arc fit answers "does this ride ONE circle", which an S-curved tail and a
// sharply kinked hook both fail while being obviously not straight. So bending
// is also measured directly, as the path's largest excursion from its own
// best-fit line relative to its extent — the one measure that survives a path
// with no single centre at all.
const SWEPT_PATH_MIN_SAGITTA_RATIO = 0.05;

// A crescent's concave (inner) boundary turns back through about the same angle
// its outer boundary sweeps, so the outline threshold is the arc threshold.
export const CURVED_OUTLINE_MIN_CONCAVE_TURN_DEGREES = 25;

// Concavity has to be SUSTAINED, not merely present. Summed over the whole ring,
// a single deep V-notch at the base of an otherwise straight spike buys hundreds
// of degrees, and serrated, stepped, and slotted silhouettes are common — so the
// gate would pass exactly the straight claw it exists to catch. A run of concave
// vertices only counts when the boundary it governs is a real stretch of the
// outline rather than a nick in it.
const CONCAVE_RUN_MIN_LENGTH_RATIO = 0.25;

// Tokens that declare a form which has to bend to read as itself. Deliberately
// narrow, because this text is fed back into the next refinement pass: a false
// positive does not merely add noise, it TELLS the provider to bend a part that
// was right to be straight.
//
// So a noun earns a bare place here only when a straight version of the part
// would be wrong. "pipe", "rod", "trunk", "tail", "whisker", "bow", and "barb"
// are all absent — a tail boom runs down a fuselage, a tail fin is a flat plate,
// and a whisker is a straight bristle — and they declare a curve only through a
// modifier that is itself on the list, which is why "curved tail" and "coiled
// tail" still match. Bare "arc" and "hoop" are absent for a different reason: an
// "arcReactor" is a disc, and a hoop authored as an extruded ring has a convex
// outline with the curve in its HOLE, so both would report a correct build as
// the defect.
const CURVED_FORM_TOKENS = new Set([
  'horn', 'antler', 'tusk', 'fang', 'claw', 'talon', 'pincer', 'mandible',
  'tentacle', 'hook', 'crook',
  'curve', 'curved', 'curving', 'curl', 'curled', 'coil', 'coiled', 'spiral',
  'bend', 'bent', 'arced', 'arch', 'arched', 'bowed',
  'crescent', 'scythe', 'sickle', 'elbow',
]);

/**
 * True when an identifier names a form that has to bend. Reuses the material
 * tokenizer so `hornLeft`, `horn_left`, and `Horns` all match.
 */
const namesCurvedForm = (identifier) => tokenizeSpecIdentifier(identifier)
  .some((token) => CURVED_FORM_TOKENS.has(token));

// Exact collinearity only — the epsilon guards float noise, never near-straight
// paths, which sweep a perfectly good tube.
export const isCollinearPath = (points) => {
  const [origin] = points;
  const spread = points.find((point) => point.some((value, axis) => value !== origin[axis]));
  if (!spread) return true;
  const direction = spread.map((value, axis) => value - origin[axis]);
  return points.every((point) => {
    const offset = point.map((value, axis) => value - origin[axis]);
    const cross = [
      (direction[1] * offset[2]) - (direction[2] * offset[1]),
      (direction[2] * offset[0]) - (direction[0] * offset[2]),
      (direction[0] * offset[1]) - (direction[1] * offset[0]),
    ];
    return cross.every((component) => Math.abs(component) < 1e-9);
  });
};

const crossProduct = (a, b) => [
  (a[1] * b[2]) - (a[2] * b[1]),
  (a[2] * b[0]) - (a[0] * b[2]),
  (a[0] * b[1]) - (a[1] * b[0]),
];

/**
 * The eigenvector of the smallest eigenvalue of a symmetric 3x3 covariance —
 * the best-fit plane's normal. Closed-form rather than iterative: a path carries
 * at most 96 points and the audit runs on every refinement pass.
 *
 * @param {number[]} covariance `[xx, yy, zz, xy, xz, yz]`
 */
const smallestEigenvector = ([xx, yy, zz, xy, xz, yz]) => {
  const offDiagonal = (xy * xy) + (xz * xz) + (yz * yz);
  const mean = (xx + yy + zz) / 3;
  let smallest;
  if (offDiagonal <= 0) {
    smallest = Math.min(xx, yy, zz);
  } else {
    const spread = ((xx - mean) ** 2) + ((yy - mean) ** 2) + ((zz - mean) ** 2) + (2 * offDiagonal);
    const scale = Math.sqrt(spread / 6);
    const b = [
      (xx - mean) / scale, xy / scale, xz / scale,
      xy / scale, (yy - mean) / scale, yz / scale,
      xz / scale, yz / scale, (zz - mean) / scale,
    ];
    const determinant = (b[0] * ((b[4] * b[8]) - (b[5] * b[7])))
      - (b[1] * ((b[3] * b[8]) - (b[5] * b[6])))
      + (b[2] * ((b[3] * b[7]) - (b[4] * b[6])));
    const phi = Math.acos(Math.min(1, Math.max(-1, determinant / 2))) / 3;
    const first = mean + (2 * scale * Math.cos(phi));
    const third = mean + (2 * scale * Math.cos(phi + ((2 * Math.PI) / 3)));
    smallest = Math.min(first, third, (3 * mean) - first - third);
  }
  // The null space of (covariance - smallest * I): every pair of its rows spans
  // the plane, so their cross product is the normal. The longest one is taken
  // because a near-degenerate pair produces numerical dust.
  const rows = [
    [xx - smallest, xy, xz],
    [xy, yy - smallest, yz],
    [xz, yz, zz - smallest],
  ];
  let normal = null;
  let longest = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = i + 1; j < 3; j += 1) {
      const candidate = crossProduct(rows[i], rows[j]);
      const length = vectorLength(candidate);
      if (length > longest) {
        longest = length;
        normal = candidate;
      }
    }
  }
  return longest > 0 ? normal.map((value) => value / longest) : [0, 0, 1];
};

/**
 * Least-squares circle through 2D points (Kasa). Returns `null` when the points
 * are collinear, where the normal equations are singular and any "circle"
 * through them is an artifact of float noise.
 */
const fitCircle2D = (points) => {
  const count = points.length;
  const meanX = points.reduce((total, [x]) => total + x, 0) / count;
  const meanY = points.reduce((total, [, y]) => total + y, 0) / count;
  let suu = 0; let svv = 0; let suv = 0; let suuu = 0; let svvv = 0; let suvv = 0; let svuu = 0;
  for (const [x, y] of points) {
    const u = x - meanX;
    const v = y - meanY;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v;
    suvv += u * v * v; svuu += v * u * u;
  }
  const determinant = (suu * svv) - (suv * suv);
  // Relative, not absolute: the same collinear path authored in millimetres and
  // in metres must both read as collinear.
  if (Math.abs(determinant) <= ((suu + svv) ** 2) * 1e-12) return null;
  const rhsU = (suuu + suvv) / 2;
  const rhsV = (svvv + svuu) / 2;
  const centerU = ((rhsU * svv) - (rhsV * suv)) / determinant;
  const centerV = ((rhsV * suu) - (rhsU * suv)) / determinant;
  return {
    center: [meanX + centerU, meanY + centerV],
    radius: Math.sqrt((centerU * centerU) + (centerV * centerV) + ((suu + svv) / count)),
    centroid: [meanX, meanY],
  };
};

/**
 * The largest perpendicular excursion of 2D points from their own best-fit
 * line. Straightness measured directly, so a path that bends without riding any
 * single circle still reads as bent.
 */
const maxDeviationFromBestFitLine = (points) => {
  const meanX = points.reduce((total, [x]) => total + x, 0) / points.length;
  const meanY = points.reduce((total, [, y]) => total + y, 0) / points.length;
  let sxx = 0; let syy = 0; let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - meanX) ** 2;
    syy += (y - meanY) ** 2;
    sxy += (x - meanX) * (y - meanY);
  }
  // The principal direction of a symmetric 2x2 scatter, in closed form.
  const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  const normal = [-Math.sin(angle), Math.cos(angle)];
  return points.reduce((widest, [x, y]) => Math.max(
    widest,
    Math.abs(((x - meanX) * normal[0]) + ((y - meanY) * normal[1])),
  ), 0);
};

/**
 * Measure how far a swept path actually bends.
 *
 * The points are projected onto their own best-fit plane and fitted to a circle
 * there. The path is credited as curved when it rides that circle — a fit its
 * points really lie on, spanning a minimum angle, with the centre a bounded
 * distance from the path — OR, for a bend that rides no single circle, when its
 * excursion from its own best-fit line is large enough to see.
 *
 * @param {Array<number[]>} points ordered `[x, y, z]` control points
 * @returns {{straight: boolean, collinear: boolean, arcSpanDegrees: number,
 *   radius: number|null, centerDistanceRatio: number|null,
 *   radialErrorRatio: number|null, sagittaRatio: number, extent: number}}
 */
export function evaluateSweptArcCurvature(points) {
  const usable = (Array.isArray(points) ? points : [])
    .filter((point) => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite));
  const straightResult = (extent) => ({
    straight: true,
    collinear: true,
    arcSpanDegrees: 0,
    radius: null,
    centerDistanceRatio: null,
    radialErrorRatio: null,
    sagittaRatio: 0,
    extent,
  });
  const separation = (a, b) => vectorLength(b.map((value, axis) => value - a[axis]));
  // Two points ARE a straight segment, and an exactly collinear run of any
  // length sweeps one too — no fit is needed, and none would be meaningful.
  if (usable.length < 3) return straightResult(usable.length === 2 ? separation(usable[0], usable[1]) : 0);
  if (isCollinearPath(usable)) return straightResult(separation(usable[0], usable[usable.length - 1]));

  const centroid = [0, 1, 2].map((axis) => usable.reduce((total, point) => total + point[axis], 0) / usable.length);
  const offsets = usable.map((point) => point.map((value, axis) => value - centroid[axis]));
  const covariance = [0, 0, 0, 0, 0, 0];
  for (const [x, y, z] of offsets) {
    covariance[0] += (x * x) / offsets.length;
    covariance[1] += (y * y) / offsets.length;
    covariance[2] += (z * z) / offsets.length;
    covariance[3] += (x * y) / offsets.length;
    covariance[4] += (x * z) / offsets.length;
    covariance[5] += (y * z) / offsets.length;
  }
  const normal = smallestEigenvector(covariance);
  // Any seed not parallel to the normal spans the plane with it; the axis with
  // the smallest component is the one guaranteed not to be.
  const seed = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const uAxis = crossProduct(normal, seed);
  const uLength = vectorLength(uAxis);
  const u = uLength > 0 ? uAxis.map((value) => value / uLength) : [1, 0, 0];
  const v = crossProduct(normal, u);
  const projected = offsets.map((offset) => [
    (offset[0] * u[0]) + (offset[1] * u[1]) + (offset[2] * u[2]),
    (offset[0] * v[0]) + (offset[1] * v[1]) + (offset[2] * v[2]),
  ]);

  let extent = 0;
  for (let i = 0; i < projected.length; i += 1) {
    for (let j = i + 1; j < projected.length; j += 1) {
      extent = Math.max(extent, Math.hypot(projected[i][0] - projected[j][0], projected[i][1] - projected[j][1]));
    }
  }
  if (!(extent > 0)) return straightResult(extent);
  const sagittaRatio = maxDeviationFromBestFitLine(projected) / extent;

  const circle = fitCircle2D(projected);
  if (!circle) {
    return {
      straight: sagittaRatio < SWEPT_PATH_MIN_SAGITTA_RATIO,
      collinear: false,
      arcSpanDegrees: 0,
      radius: null,
      centerDistanceRatio: null,
      radialErrorRatio: null,
      sagittaRatio,
      extent,
    };
  }

  // Per-segment and absolute, so an S-curve accumulates its two opposing bends
  // instead of cancelling them. Safe to sum unsigned only because the radial
  // error below refuses to credit a span the points did not trace.
  let arcSpanRadians = 0;
  for (let index = 1; index < projected.length; index += 1) {
    const previous = Math.atan2(projected[index - 1][1] - circle.center[1], projected[index - 1][0] - circle.center[0]);
    const current = Math.atan2(projected[index][1] - circle.center[1], projected[index][0] - circle.center[0]);
    let step = current - previous;
    while (step > Math.PI) step -= 2 * Math.PI;
    while (step < -Math.PI) step += 2 * Math.PI;
    arcSpanRadians += Math.abs(step);
  }
  const arcSpanDegrees = (arcSpanRadians * 180) / Math.PI;
  const squaredRadialError = projected.reduce((total, [x, y]) => {
    const deviation = Math.hypot(x - circle.center[0], y - circle.center[1]) - circle.radius;
    return total + ((deviation * deviation) / projected.length);
  }, 0);
  const radialErrorRatio = Math.sqrt(squaredRadialError) / circle.radius;
  const centerDistanceRatio = Math.hypot(
    circle.center[0] - circle.centroid[0],
    circle.center[1] - circle.centroid[1],
  ) / extent;

  const ridesArc = radialErrorRatio <= SWEPT_ARC_MAX_RADIAL_ERROR_RATIO
    && arcSpanDegrees >= SWEPT_ARC_MIN_SPAN_DEGREES
    && centerDistanceRatio <= SWEPT_ARC_MAX_CENTER_DISTANCE_RATIO;

  return {
    straight: !ridesArc && sagittaRatio < SWEPT_PATH_MIN_SAGITTA_RATIO,
    collinear: false,
    arcSpanDegrees,
    radius: circle.radius,
    centerDistanceRatio,
    radialErrorRatio,
    sagittaRatio,
    extent,
  };
}

/**
 * The largest SUSTAINED concave turn in a closed outline, in degrees: the
 * longest unbroken run of concave vertices whose stretch of boundary is a real
 * fraction of the outline's own size. A convex ring returns 0; a crescent
 * returns roughly the arc its inner boundary sweeps; a notch or a serration in
 * an otherwise straight silhouette returns 0 however deep it is cut.
 *
 * @param {Array<number[]>} ring ordered `[x, y]` outline points
 */
export function measureOutlineConcaveTurn(ring) {
  const points = (Array.isArray(ring) ? ring : [])
    .filter((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
  if (points.length < 3) return 0;
  const segmentLength = (index) => {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    return Math.hypot(next[0] - current[0], next[1] - current[1]);
  };
  const turns = points.map((current, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const incoming = [current[0] - previous[0], current[1] - previous[1]];
    const outgoing = [next[0] - current[0], next[1] - current[1]];
    return Math.atan2(
      (incoming[0] * outgoing[1]) - (incoming[1] * outgoing[0]),
      (incoming[0] * outgoing[0]) + (incoming[1] * outgoing[1]),
    );
  });
  // A simple ring turns through a full circle exactly once, so the sign of the
  // total is its winding — measured from the turns themselves rather than from a
  // signed area, so the two can never disagree about which side is concave.
  const winding = turns.reduce((total, turn) => total + turn, 0) >= 0 ? 1 : -1;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const extent = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!(extent > 0)) return 0;

  // Walked over two laps so a run straddling the start of the array is measured
  // whole rather than split into two short ones.
  let runTurn = 0;
  let runLength = 0;
  let widest = 0;
  for (let step = 0; step < points.length * 2; step += 1) {
    const index = step % points.length;
    const concave = -turns[index] * winding;
    if (concave > 0) {
      // The boundary a concave vertex governs runs from the segment arriving at
      // it to the segment leaving it, so a run picks up its leading segment once.
      if (runTurn === 0) runLength += segmentLength((index - 1 + points.length) % points.length);
      runTurn += concave;
      runLength += segmentLength(index);
      if (runLength >= extent * CONCAVE_RUN_MIN_LENGTH_RATIO) {
        widest = Math.max(widest, runTurn);
      }
    } else {
      runTurn = 0;
      runLength = 0;
    }
  }
  return (widest * 180) / Math.PI;
}

/**
 * Measure whichever sweep geometry this is, using the measure that geometry
 * carries its curvature in. Returns `null` for anything this gate cannot speak
 * about — a straight `box` rail named "elbowBracket", a closed tube, an extrude
 * whose curve may live in a hole — so a caller can tell "measured and straight"
 * from "not measurable".
 */
export function evaluateSweptGeometryCurvature(geometry) {
  if (geometry?.type === 'tube') {
    // A closed tube is a loop: the schema already refuses a collinear one, and a
    // loop has no endpoints for an arc span to mean anything between.
    if (geometry.closed === true) return null;
    const curvature = evaluateSweptArcCurvature(geometry.path);
    return { kind: 'tube', straight: curvature.straight, arcSpanDegrees: curvature.arcSpanDegrees };
  }
  if (geometry?.type === 'extrude') {
    // A ring, an arch, and a slotted plate all put their curve in a HOLE, and a
    // hole leaves the outline convex, so an outline measurement would report the
    // canonical build as the defect. There is no measurement here that separates
    // those from a straight spike with a cutout, so the gate declines to speak.
    if ((geometry.holes || []).length > 0) return null;
    const concaveTurnDegrees = measureOutlineConcaveTurn(geometry.outline);
    return {
      kind: 'extrude',
      straight: concaveTurnDegrees < CURVED_OUTLINE_MIN_CONCAVE_TURN_DEGREES,
      concaveTurnDegrees,
    };
  }
  return null;
}

/**
 * Parts the spec declares as curved forms, keyed by part id, with the name or
 * feature phrase that declared it. A `detailInventory` feature counts as a
 * declaration, which is how a part called `part_17` still gets measured when the
 * feature it builds is "curved brass horn".
 *
 * Only declarations that name ONE sweep are returned. A curved form built from
 * several parts — a tail of five tapered segments, a horn split into a base and
 * a tip — curves by ARRANGEMENT, and every piece of it is legitimately straight,
 * so measuring the pieces would report the correct build as the defect. That is
 * why a segment nested under an already-declared part is skipped, why a part
 * that owns sweep-carrying children is skipped even when it carries a sweep of
 * its own (its geometry is the base of an assembly, not the whole curve), and
 * why a feature implementing itself with more than one sweep is skipped too.
 */
export function collectDeclaredCurvedParts(spec) {
  const declared = new Map();
  const byId = new Map();
  const declare = (partId, declaredBy) => {
    if (!declared.has(partId)) declared.set(partId, declaredBy);
  };
  const hasSweepDescendant = (part) => (part.children || []).some((child) => (
    evaluateSweptGeometryCurvature(child.geometry) || hasSweepDescendant(child)
  ));
  const walk = (parts, ancestorDeclared) => {
    for (const part of parts || []) {
      byId.set(part.id, part);
      const name = part.name || part.id;
      const isDeclared = namesCurvedForm(name);
      if (isDeclared && !ancestorDeclared && !hasSweepDescendant(part)) declare(part.id, name);
      walk(part.children, ancestorDeclared || isDeclared);
    }
  };
  walk(spec?.parts, false);
  for (const detail of spec?.detailInventory || []) {
    if (!namesCurvedForm(detail.feature)) continue;
    const sweeps = (detail.implementationPartIds || [])
      .filter((partId) => evaluateSweptGeometryCurvature(byId.get(partId)?.geometry));
    if (sweeps.length !== 1) continue;
    declare(sweeps[0], detail.feature);
  }
  return declared;
}
