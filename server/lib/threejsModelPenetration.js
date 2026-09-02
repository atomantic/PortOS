/**
 * Cross-part penetration gate for an already-validated Three.js scene spec.
 *
 * Every other gate reads one part at a time. `threejsSculptSpecSchema` proves
 * each geometry is well formed (a hole inside its outline, a tube that does not
 * retrace itself), the coverage gate proves the assembly backs the inventory,
 * and the flatness gate proves the identity parts have a cross-section. None of
 * them ever compares two parts to each other, so the whole class of defect where
 * sibling parts occupy the SAME space is invisible: an eye socket punched
 * through the back of a skull, a limb rooted a whole radius inside a torso, a
 * greeble modelled at the wrong scale and swallowed entirely by the hull it was
 * meant to sit on. Each of those renders perfectly from the generated hero
 * camera and only reads as broken once the model is orbited or taken apart.
 *
 * This module reconstructs each part's world placement (the same
 * position/rotation/scale composition the preview and the exported factory
 * apply), derives an analytic solid for its geometry, and samples one part's
 * interior against another's to estimate how much of it is swallowed.
 *
 * Its honest limits, all of which push toward reporting LESS:
 * - The solids are analytic approximations. A bevel is ignored, a tube is
 *   measured against its control polyline rather than the interpolated curve,
 *   and a `custom` triangle soup has no interior test at all — it contributes
 *   its own vertices as occupancy samples and can only ever be found buried IN
 *   something, never found to have buried something.
 * - Parts in the same subtree are never compared. Relief riding its parent, a
 *   pupil inside an eyeball, a bolt sunk into the plate it fastens — those are
 *   modelled as parent/child precisely because they are meant to interpenetrate.
 *   Declared `attachmentPartIds` are exempt for the same reason.
 * - A merely-joined pair (a peg in its socket, a limb seated in a shoulder)
 *   overlaps by construction, so a small overlap fraction is reported as
 *   UNDECIDED contact rather than as a defect, and a transparent container can
 *   only ever produce an undecided note — a part inside a glass dome is the
 *   reference being followed, not a mistake.
 */

import { listSpecNames, resolveThreejsAttachments } from './threejsModel.js';
import {
  applyLinear,
  applyTransform,
  composeTransform,
  degreesToRadians,
  IDENTITY_TRANSFORM,
} from './threejsTransform.js';

// Sampling resolution over a part's local bounding box. 8³ is enough to
// estimate a containment fraction to a couple of percent, which is all the
// thresholds below need; a shape too thin to catch any cell centre gets ONE
// retry at double the resolution before it is written off as unmeasurable.
const SAMPLE_GRID = 8;
const RETRY_GRID = 16;

// Pairwise work is quadratic in part count (the schema caps a spec at 160
// parts), so the interior sample set each part carries into the pair loop is
// strided down to a bound that keeps the whole gate well under a second.
const MAX_PAIR_SAMPLES = 96;

// A part whose every interior sample lands inside another part is not partly
// sunk into it, it is GONE — nothing of it can ever be seen. The threshold is
// just short of 1 because the sample set is a grid, not the solid itself.
const CONTAINED_FRACTION = 0.98;

// Half of a part's volume inside an unrelated sibling is well past any joint,
// seam, or seat: at that point the two parts are modelling the same space.
const HEAVY_OVERLAP_FRACTION = 0.5;

// Below this, an overlap is ordinary assembly — a tenon in its mortise, a limb
// seated in its socket — and reporting it would drown the real findings.
const CONTACT_FRACTION = 0.15;

const EPSILON = 1e-9;

/**
 * Affine inverse, or `null` when the linear part is singular. A stored spec
 * predates the positive-scale bound, so a zero or mirrored component is
 * reachable here — `null` makes it an unmeasurable part rather than a NaN that
 * would quietly read as "no overlap".
 */
const invertTransform = ({ linear, translation }) => {
  const [a, b, c, d, e, f, g, h, i] = linear;
  const determinant = (a * ((e * i) - (f * h))) - (b * ((d * i) - (f * g))) + (c * ((d * h) - (e * g)));
  if (!Number.isFinite(determinant) || Math.abs(determinant) < EPSILON) return null;
  const inverseLinear = [
    ((e * i) - (f * h)) / determinant, ((c * h) - (b * i)) / determinant, ((b * f) - (c * e)) / determinant,
    ((f * g) - (d * i)) / determinant, ((a * i) - (c * g)) / determinant, ((c * d) - (a * f)) / determinant,
    ((d * h) - (e * g)) / determinant, ((b * g) - (a * h)) / determinant, ((a * e) - (b * d)) / determinant,
  ];
  const shifted = applyLinear(inverseLinear, translation);
  return {
    linear: inverseLinear,
    translation: [-shifted[0], -shifted[1], -shifted[2]],
  };
};

const ringMinMax = (points, axis) => points.reduce(
  ([min, max], point) => [Math.min(min, point[axis]), Math.max(max, point[axis])],
  [Infinity, -Infinity],
);

// Even-odd ray cast in the profile plane. Shared shape with the extrude-hole
// check in `threejsModel.js`, but this one answers "is this sample inside the
// swept solid", so it is kept local rather than exported across modules.
const pointInPolygon = (ring, px, py) => {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    const straddles = (yi > py) !== (yj > py);
    if (straddles && px < (((xj - xi) * (py - yi)) / (yj - yi)) + xi) inside = !inside;
  }
  return inside;
};

/**
 * One tube segment with its direction and a bounding box already padded by the
 * tube radius. Both are precomputed per segment rather than per sample: a
 * 96-point path is tested against every interior sample of every part it might
 * touch, and the padded box rejects almost all of those segments on six
 * comparisons instead of a projection.
 */
const prepareSegment = ([ax, ay, az], [bx, by, bz], radius) => {
  const [dx, dy, dz] = [bx - ax, by - ay, bz - az];
  return {
    ax,
    ay,
    az,
    dx,
    dy,
    dz,
    lengthSquared: (dx * dx) + (dy * dy) + (dz * dz),
    min: [Math.min(ax, bx) - radius, Math.min(ay, by) - radius, Math.min(az, bz) - radius],
    max: [Math.max(ax, bx) + radius, Math.max(ay, by) + radius, Math.max(az, bz) + radius],
  };
};

const withinSegment = (segment, [px, py, pz], radiusSquared) => {
  if (px < segment.min[0] || px > segment.max[0]) return false;
  if (py < segment.min[1] || py > segment.max[1]) return false;
  if (pz < segment.min[2] || pz > segment.max[2]) return false;
  const t = segment.lengthSquared < EPSILON
    ? 0
    : Math.max(0, Math.min(1, (((px - segment.ax) * segment.dx)
      + ((py - segment.ay) * segment.dy)
      + ((pz - segment.az) * segment.dz)) / segment.lengthSquared));
  const qx = px - (segment.ax + (segment.dx * t));
  const qy = py - (segment.ay + (segment.dy * t));
  const qz = pz - (segment.az + (segment.dz * t));
  return (qx * qx) + (qy * qy) + (qz * qz) <= radiusSquared;
};

/**
 * The local-space solid for one geometry: an axis-aligned bounding box plus an
 * interior predicate. `contains: null` marks a geometry PortOS cannot test from
 * the inside (`custom` triangle soup), which the caller degrades rather than
 * guesses at.
 */
function describeSolid(geometry) {
  switch (geometry.type) {
    case 'box': {
      const [x, y, z] = [geometry.width / 2, geometry.height / 2, geometry.depth / 2];
      return {
        bounds: [[-x, -y, -z], [x, y, z]],
        contains: ([px, py, pz]) => Math.abs(px) <= x && Math.abs(py) <= y && Math.abs(pz) <= z,
      };
    }
    case 'sphere': {
      const r = geometry.radius;
      return {
        bounds: [[-r, -r, -r], [r, r, r]],
        contains: ([px, py, pz]) => (px * px) + (py * py) + (pz * pz) <= r * r,
      };
    }
    case 'cylinder':
    case 'cone': {
      const top = geometry.type === 'cone' ? 0 : geometry.radiusTop;
      const bottom = geometry.type === 'cone' ? geometry.radius : geometry.radiusBottom;
      const half = geometry.height / 2;
      const widest = Math.max(top, bottom);
      return {
        bounds: [[-widest, -half, -widest], [widest, half, widest]],
        contains: ([px, py, pz]) => {
          if (Math.abs(py) > half) return false;
          // Three.js interpolates the radius linearly from bottom to top.
          const radius = bottom + ((top - bottom) * ((py + half) / geometry.height));
          return (px * px) + (pz * pz) <= radius * radius;
        },
      };
    }
    case 'capsule': {
      const { radius } = geometry;
      const half = geometry.length / 2;
      return {
        bounds: [[-radius, -(half + radius), -radius], [radius, half + radius, radius]],
        contains: ([px, py, pz]) => {
          const radial = (px * px) + (pz * pz);
          if (Math.abs(py) <= half) return radial <= radius * radius;
          const capOffset = Math.abs(py) - half;
          return radial + (capOffset * capOffset) <= radius * radius;
        },
      };
    }
    case 'torus': {
      const { radius, tube } = geometry;
      const outer = radius + tube;
      // The arc is deliberately absent from the bounds: over-reporting the
      // extent of a partial ring only ever costs an extra pair comparison,
      // while under-reporting it would silently drop real overlaps.
      const arc = degreesToRadians(geometry.arcDegrees ?? 360);
      return {
        bounds: [[-outer, -outer, -tube], [outer, outer, tube]],
        contains: ([px, py, pz]) => {
          const planar = Math.hypot(px, py) - radius;
          if ((planar * planar) + (pz * pz) > tube * tube) return false;
          if (arc >= (2 * Math.PI) - EPSILON) return true;
          const angle = Math.atan2(py, px);
          return (angle < 0 ? angle + (2 * Math.PI) : angle) <= arc;
        },
      };
    }
    case 'lathe': {
      // The profile is revolved about Y, so a sample is inside when its
      // (radius, height) lands in the profile polygon. Three.js sweeps an open
      // POLYLINE, which does not name a solid on its own — there are two ways to
      // close it, and which one is right depends on the profile:
      //
      // - Closing it back to its first point is the cross-section reading, and
      //   the correct one for a wall drawn as a loop (a cup, a rim, a tyre).
      // - Closing it through the axis is the silhouette reading, correct for a
      //   profile drawn once from bottom to top (a vase, a spun cone).
      //
      // A loop encloses area, and a silhouette closed on itself encloses none —
      // which is what tells the two apart. Without the fallback the whole
      // silhouette case (including every two-point profile, the smallest one the
      // schema allows) degenerates to a zero-area polygon that nothing is ever
      // inside, and the part would drop out of the gate unmeasured.
      const closed = geometry.points;
      const doubledArea = closed.reduce((total, [x1, y1], index) => {
        const [x2, y2] = closed[(index + 1) % closed.length];
        return total + ((x1 * y2) - (x2 * y1));
      }, 0);
      const profile = Math.abs(doubledArea) / 2 > EPSILON
        ? closed
        : [...closed, [0, closed[closed.length - 1][1]], [0, closed[0][1]]];
      const [minRadius, maxRadius] = ringMinMax(profile, 0);
      const [minHeight, maxHeight] = ringMinMax(profile, 1);
      const widest = Math.max(Math.abs(minRadius), Math.abs(maxRadius));
      return {
        bounds: [[-widest, minHeight, -widest], [widest, maxHeight, widest]],
        contains: ([px, py, pz]) => pointInPolygon(profile, Math.hypot(px, pz), py),
      };
    }
    case 'extrude': {
      // ExtrudeGeometry sweeps the shape from z=0 to z=depth. The bevel is
      // ignored, which only ever shrinks the real solid near its caps.
      const [minX, maxX] = ringMinMax(geometry.outline, 0);
      const [minY, maxY] = ringMinMax(geometry.outline, 1);
      const holes = geometry.holes || [];
      return {
        bounds: [[minX, minY, 0], [maxX, maxY, geometry.depth]],
        contains: ([px, py, pz]) => {
          if (pz < 0 || pz > geometry.depth) return false;
          if (!pointInPolygon(geometry.outline, px, py)) return false;
          return !holes.some((hole) => pointInPolygon(hole, px, py));
        },
      };
    }
    case 'tube': {
      // Measured against the control polyline rather than the interpolated
      // Catmull-Rom curve: the curve bulges outside the polyline between
      // control points, so this reads slightly thin, never fat.
      const { path, radius } = geometry;
      const axisBounds = [0, 1, 2].map((axis) => ringMinMax(path, axis));
      const segmentCount = geometry.closed ? path.length : path.length - 1;
      const segments = [];
      for (let index = 0; index < segmentCount; index += 1) {
        segments.push(prepareSegment(path[index], path[(index + 1) % path.length], radius));
      }
      const radiusSquared = radius * radius;
      return {
        bounds: [
          axisBounds.map(([min]) => min - radius),
          axisBounds.map(([, max]) => max + radius),
        ],
        contains: (point) => segments.some((segment) => withinSegment(segment, point, radiusSquared)),
      };
    }
    case 'custom': {
      const { vertices } = geometry;
      const bounds = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
      for (let index = 0; index < vertices.length; index += 1) {
        const axis = index % 3;
        bounds[0][axis] = Math.min(bounds[0][axis], vertices[index]);
        bounds[1][axis] = Math.max(bounds[1][axis], vertices[index]);
      }
      return { bounds, contains: null };
    }
    default:
      return null;
  }
}

/** Cell centres of a uniform grid over `bounds`, kept when `contains` accepts. */
function sampleSolid(bounds, contains, divisions) {
  const [min, max] = bounds;
  const step = [0, 1, 2].map((axis) => (max[axis] - min[axis]) / divisions);
  const kept = [];
  for (let i = 0; i < divisions; i += 1) {
    const x = min[0] + (step[0] * (i + 0.5));
    for (let j = 0; j < divisions; j += 1) {
      const y = min[1] + (step[1] * (j + 0.5));
      for (let k = 0; k < divisions; k += 1) {
        const point = [x, y, min[2] + (step[2] * (k + 0.5))];
        if (contains(point)) kept.push(point);
      }
    }
  }
  return kept;
}

/** Deterministic stride down to at most `limit` entries, endpoints included. */
const strideDown = (values, limit) => {
  if (values.length <= limit) return values;
  const step = values.length / limit;
  const out = [];
  for (let index = 0; index < limit; index += 1) out.push(values[Math.floor(index * step)]);
  return out;
};

const customVertexPoints = (geometry) => {
  const points = [];
  for (let index = 0; index + 2 < geometry.vertices.length; index += 3) {
    points.push([geometry.vertices[index], geometry.vertices[index + 1], geometry.vertices[index + 2]]);
  }
  return points;
};

/**
 * Flatten the part tree into world-placed volumes. Parts with no geometry are
 * groups: they carry their transform down to their children and are never
 * compared themselves.
 */
function collectVolumes(spec) {
  const volumes = [];
  const walk = (part, parentTransform, ancestorIds) => {
    const transform = composeTransform(parentTransform, part);
    if (part.geometry) {
      const solid = describeSolid(part.geometry);
      const inverse = solid ? invertTransform(transform) : null;
      if (solid && inverse) {
        const sampled = solid.contains
          ? sampleSolid(solid.bounds, solid.contains, SAMPLE_GRID)
          : customVertexPoints(part.geometry);
        // A shape too thin to catch a cell centre gets one finer pass before it
        // is written off — a narrow torus or a shallow extrude is a real solid,
        // not an unmeasurable one.
        const refined = solid.contains && sampled.length === 0
          ? sampleSolid(solid.bounds, solid.contains, RETRY_GRID)
          : sampled;
        if (refined.length > 0) {
          const worldSamples = strideDown(refined, MAX_PAIR_SAMPLES)
            .map((point) => applyTransform(transform, point));
          const corners = [];
          for (const x of [solid.bounds[0][0], solid.bounds[1][0]]) {
            for (const y of [solid.bounds[0][1], solid.bounds[1][1]]) {
              for (const z of [solid.bounds[0][2], solid.bounds[1][2]]) {
                corners.push(applyTransform(transform, [x, y, z]));
              }
            }
          }
          volumes.push({
            id: part.id,
            name: part.name || part.id,
            ancestorIds,
            materialId: part.material || null,
            samples: worldSamples,
            // `null` for a `custom` mesh: it can be found buried inside another
            // part, but nothing can be tested against ITS interior.
            contains: solid.contains
              ? (worldPoint) => solid.contains(applyTransform(inverse, worldPoint))
              : null,
            worldBounds: [0, 1, 2].map((axis) => [
              Math.min(...corners.map((corner) => corner[axis])),
              Math.max(...corners.map((corner) => corner[axis])),
            ]),
          });
        }
      }
    }
    for (const child of part.children || []) walk(child, transform, [...ancestorIds, part.id]);
  };
  for (const part of spec?.parts || []) walk(part, IDENTITY_TRANSFORM, []);
  return volumes;
}

const boundsDisjoint = (a, b) => [0, 1, 2].some((axis) => (
  a.worldBounds[axis][0] > b.worldBounds[axis][1] || b.worldBounds[axis][0] > a.worldBounds[axis][1]
));

/**
 * The share of `subject`'s interior samples that land inside `container`, or
 * `null` when the container has no interior test.
 *
 * Bails as soon as every remaining sample landing inside could no longer reach
 * `CONTACT_FRACTION` — the caller drops anything under that floor, and the
 * abandoned tally is by construction below it too, so the early exit cannot
 * change a verdict. It is what keeps the common case (parts that merely brush
 * each other's bounding boxes) from paying for a full sample sweep.
 */
const containedFraction = (subject, container) => {
  if (!container.contains) return null;
  const total = subject.samples.length;
  let inside = 0;
  for (let index = 0; index < total; index += 1) {
    if (container.contains(subject.samples[index])) inside += 1;
    else if ((inside + (total - index - 1)) / total < CONTACT_FRACTION) return inside / total;
  }
  return inside / total;
};

const isTransparent = (material) => Boolean(material)
  && ((material.transparent === true && (material.opacity ?? 1) < 1) || (material.transmission ?? 0) > 0);

const describePair = (a, b) => `"${a.name}" and "${b.name}"`;

/**
 * @param {object|null} spec a spec that has already passed a sculpt-spec schema
 * @returns {{findings: Array, errorCount: number, warningCount: number, noteCount: number,
 *   evaluatedPartCount: number, comparedPairCount: number, undecidedPairCount: number}}
 */
export function evaluateThreejsPenetration(spec) {
  const volumes = collectVolumes(spec);
  const materials = spec?.materials && typeof spec.materials === 'object' ? spec.materials : {};
  // A declared attachment says outright that this part rides another one, so a
  // pack sunk into the back it is strapped to is the spec working as declared.
  const attachments = new Set(resolveThreejsAttachments(spec?.articulation).map((attachment) => attachment.partId));

  const buried = [];
  const overlapping = [];
  const undecided = [];
  let comparedPairCount = 0;

  for (let i = 0; i < volumes.length; i += 1) {
    for (let j = i + 1; j < volumes.length; j += 1) {
      const [a, b] = [volumes[i], volumes[j]];
      // Same subtree: interpenetration is what a parent/child relationship is
      // FOR, so the pair carries no information.
      if (a.ancestorIds.includes(b.id) || b.ancestorIds.includes(a.id)) continue;
      if (attachments.has(a.id) || attachments.has(b.id)) continue;
      if (boundsDisjoint(a, b)) continue;
      comparedPairCount += 1;

      const aInB = containedFraction(a, b);
      const bInA = containedFraction(b, a);
      if (aInB === null && bInA === null) continue;
      // Whichever direction is measurable and deeper: a small part swallowed by
      // a large one reports ~1 in its own direction and a sliver in the other.
      const [subject, container, fraction] = (aInB ?? -1) >= (bInA ?? -1)
        ? [a, b, aInB]
        : [b, a, bInA];
      if (fraction < CONTACT_FRACTION) continue;

      // A part inside glass is the reference being followed, not a mistake, so
      // a transparent container can only ever raise an undecided note.
      const seeThrough = isTransparent(materials[container.materialId]);
      const entry = { subject, container, fraction };
      if (fraction >= CONTAINED_FRACTION && !seeThrough) buried.push(entry);
      else if (fraction >= HEAVY_OVERLAP_FRACTION && !seeThrough) overlapping.push(entry);
      else undecided.push({ ...entry, seeThrough });
    }
  }

  const deepestFirst = (entries) => [...entries]
    .sort((left, right) => (right.fraction - left.fraction)
      || left.subject.id.localeCompare(right.subject.id)
      || left.container.id.localeCompare(right.container.id));
  const partIdsOf = (entries) => [...new Set(entries.flatMap(({ subject, container }) => [subject.id, container.id]))];
  const findings = [];

  if (buried.length > 0) {
    const ranked = deepestFirst(buried);
    // `listSpecNames` caps the printed list and appends "(+N more)" — a spec
    // that buried forty parts produces one readable instruction, and `pairs`
    // below still carries every one of them for the UI.
    const names = ranked.map(({ subject, container }) => `"${subject.name}" inside "${container.name}"`);
    // Distinct buried parts, not pairs: one part swallowed by two overlapping
    // containers is one invisible part reported twice, and counting the pairs
    // would tell the user they have two.
    const buriedCount = new Set(ranked.map(({ subject }) => subject.id)).size;
    findings.push({
      code: 'buried-part',
      severity: 'error',
      partIds: partIdsOf(ranked),
      pairs: ranked.map(({ subject, container, fraction }) => ({
        partId: subject.id,
        containerPartId: container.id,
        fraction: Number(fraction.toFixed(3)),
      })),
      message: `${buriedCount} part(s) are entirely inside another part they are not attached to or parented under (${listSpecNames(names)}). Nothing of them can ever be seen from any angle — move each one out to the surface it belongs on, scale it to the part it sits against, or delete it and drop the detail it claims.`,
    });
  }

  if (overlapping.length > 0) {
    const ranked = deepestFirst(overlapping);
    const names = ranked.map(({ subject, container, fraction }) => `${describePair(subject, container)} (${Math.round(fraction * 100)}%)`);
    findings.push({
      code: 'part-interpenetration',
      severity: 'warning',
      partIds: partIdsOf(ranked),
      pairs: ranked.map(({ subject, container, fraction }) => ({
        partId: subject.id,
        containerPartId: container.id,
        fraction: Number(fraction.toFixed(3)),
      })),
      message: `${ranked.length} unrelated part pair(s) occupy substantially the same space (${listSpecNames(names)}, by volume of the smaller part). That is far past a seated joint or a seam — reposition or resize them so each part reads as its own piece when the model is orbited or taken apart.`,
    });
  }

  if (undecided.length > 0) {
    const ranked = deepestFirst(undecided);
    const names = ranked.map(({ subject, container, fraction }) => `${describePair(subject, container)} (${Math.round(fraction * 100)}%)`);
    findings.push({
      code: 'undecided-contact',
      severity: 'note',
      partIds: partIdsOf(ranked),
      pairs: ranked.map(({ subject, container, fraction }) => ({
        partId: subject.id,
        containerPartId: container.id,
        fraction: Number(fraction.toFixed(3)),
      })),
      message: `${ranked.length} unrelated part pair(s) overlap partially (${listSpecNames(names)}). This gate cannot tell a seated joint from a modelling error at this depth, so it is reported undecided rather than as a defect — check these against the reference if the assembly looks wrong when orbited.`,
    });
  }

  const countBy = (severity) => findings.filter((finding) => finding.severity === severity).length;
  return {
    findings,
    errorCount: countBy('error'),
    warningCount: countBy('warning'),
    noteCount: countBy('note'),
    // How many parts had a measurable solid at all — a spec built entirely from
    // `custom` triangle soup is not a clean result, it is an unmeasured one.
    evaluatedPartCount: volumes.length,
    comparedPairCount,
    undecidedPairCount: undecided.length,
  };
}

/**
 * Default refinement feedback derived from a stored penetration result. Only
 * errors and warnings are worth another provider run — the undecided notes exist
 * for a human reading the record, and asking a model to "fix" a contact this
 * gate could not classify would break assemblies that were correct. Returns ''
 * when nothing is interpenetrating, so the caller falls through to whatever
 * other feedback it has.
 */
export function buildThreejsPenetrationFeedback(penetration) {
  const actionable = (penetration?.findings || []).filter((finding) => (
    finding.severity === 'error' || finding.severity === 'warning'
  ));
  if (actionable.length === 0) return '';
  return [
    'The previous pass failed the cross-part penetration check — unrelated parts are modelled in the same space:',
    ...actionable.map((finding, index) => `${index + 1}. ${finding.message}`),
    'Give every part its own volume: place each one against the surface it belongs on rather than inside it, and parent anything that is genuinely meant to be embedded to the part it rides.',
  ].join('\n');
}
