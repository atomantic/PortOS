/**
 * Audits cross-sections and intentional membranes in an already-validated Three.js scene spec.
 */

import { listSpecNames } from './threejsModelSpecNames.js';
import { applyLinear, IDENTITY_LINEAR, multiplyLinear, rotationMatrix, scaleLinear, vectorLength } from './threejsTransform.js';

// Cross-section gate. A spec can match its reference head-on — silhouette,
// colour zones, part count — and still be a diorama of cardboard cut-outs:
// every load-bearing part a planar extrusion on its own depth plane, correct
// from the generated camera and hollow the moment the user orbits. Neither the
// schema nor the assembly-coverage gate sees it, because a slab is well-formed
// geometry that implements exactly the detail it claims.
//
// Evidence of form is PLANE count, not triangle count: a fan of four hundred
// triangles sharing one Z value has no profile at all. So a `custom` mesh is
// slab-like when its thinnest axis carries fewer distinct coordinates than a
// curved surface needs to read as curved (or when the cloud has no volume in
// any orientation), and an `extrude` with no bevel thickness is one by
// construction — its sweep has exactly two depth planes no matter how many
// `steps` subdivide the side walls.
//
// Honest limit: a genuinely three-dimensional but very coarse custom mesh (an
// eight-vertex box) also lands under the plane threshold. That shape is already
// against the prompt's guidance — `box` exists — so the false positive only
// fires on geometry that should not have been custom triangles in the first
// place.
const SLAB_PLANE_THRESHOLD = 11;

// Planes are quantized relative to the mesh's own size rather than in absolute
// units: a fixed 1e-3 grid would report a 0.005-unit detail mesh as having five
// planes on every axis no matter how round it is, so the gate would punish
// small parts for being small. A thousandth of the largest extent asks the
// scale-free question the gate actually means — does this axis carry structure
// at the scale of the part itself.
const RELATIVE_PLANE_QUANTUM = 1e-3;

// Plane counting is axis-aligned, which a cut-out whose ROTATION was baked into
// its vertices (rather than carried by the part's `rotationDegrees`) slips past
// — turned 45°, a single flat fan samples a distinct value on all three axes. A
// point cloud with no volume is flat in every orientation, so the covariance
// determinant, normalized by the mean variance so it is scale-free, catches
// that case however the mesh is turned. The bound is deliberately strict: only
// an essentially zero-thickness cloud qualifies, leaving thin-but-real parts to
// the plane count above rather than double-jeopardy here.
const COPLANAR_DETERMINANT = 1e-6;

// An extrude can represent a membrane only when its sweep is negligible at the
// scale of its outline. Keep this relative so the declaration works for both a
// small fin and a large cape, while a positive-depth plate remains a solid slab.
const OPEN_SHELL_DEPTH_RATIO = 1e-3;

// Aggregate, never per-part: `extrude` is the RIGHT answer for a plate, a badge,
// or a sign, so a flat part is only evidence when the model's identity rides on
// it. The finding is "the load-bearing parts are predominantly flat", reported
// once the majority of buildable identity features are backed by nothing else.
const FLAT_IDENTITY_RATIO_THRESHOLD = 0.6;

const axisBounds = (vertices, axis) => {
  let min = Infinity;
  let max = -Infinity;
  for (let index = axis; index < vertices.length; index += 3) {
    if (vertices[index] < min) min = vertices[index];
    if (vertices[index] > max) max = vertices[index];
  }
  return [min, max];
};

const countAxisPlanes = (vertices) => {
  const bounds = [0, 1, 2].map((axis) => axisBounds(vertices, axis));
  const quantum = Math.max(...bounds.map(([min, max]) => max - min)) * RELATIVE_PLANE_QUANTUM;
  // Every vertex sits on one point, so there is exactly one plane per axis.
  if (!(quantum > 0)) return [1, 1, 1];
  const axes = [new Set(), new Set(), new Set()];
  // Bucketed from each axis's own minimum rather than the absolute coordinate,
  // so the count is a property of the shape and not of where it was authored:
  // a mesh built far from the origin divides a large offset by a small quantum
  // and loses distinct planes to float resolution.
  vertices.forEach((value, index) => {
    const axis = index % 3;
    axes[axis].add(Math.round((value - bounds[axis][0]) / quantum));
  });
  return axes.map((axis) => axis.size);
};

const isCoplanarCloud = (vertices) => {
  const count = vertices.length / 3;
  const mean = [0, 0, 0];
  vertices.forEach((value, index) => { mean[index % 3] += value / count; });
  let xx = 0; let yy = 0; let zz = 0; let xy = 0; let xz = 0; let yz = 0;
  for (let index = 0; index < count; index += 1) {
    const x = vertices[index * 3] - mean[0];
    const y = vertices[(index * 3) + 1] - mean[1];
    const z = vertices[(index * 3) + 2] - mean[2];
    xx += (x * x) / count; yy += (y * y) / count; zz += (z * z) / count;
    xy += (x * y) / count; xz += (x * z) / count; yz += (y * z) / count;
  }
  const determinant = (xx * ((yy * zz) - (yz * yz)))
    - (xy * ((xy * zz) - (yz * xz)))
    + (xz * ((xy * yz) - (yy * xz)));
  const meanVariance = (xx + yy + zz) / 3;
  if (!(meanVariance > 0)) return true;
  return Math.abs(determinant) / (meanVariance ** 3) < COPLANAR_DETERMINANT;
};

// Three.js composes a part's local transform as rotation * scale, then applies
// each ancestor's transform from the outside. Keeping the linear part here is
// enough for the relative thickness check and avoids making the server-side gate
// depend on Three.js just to answer a geometry question.
const partLinear = (part) => multiplyLinear(
  rotationMatrix(part.rotationDegrees),
  scaleLinear(part.scale),
);

const transformVertices = (vertices, matrix) => {
  const transformed = [];
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    transformed.push(...applyLinear(matrix, vertices.slice(index, index + 3)));
  }
  return transformed;
};

const isZeroThicknessGeometry = (geometry, worldLinear = IDENTITY_LINEAR) => {
  if (!geometry) return false;
  if (geometry.type === 'custom') {
    const vertices = Array.isArray(geometry.vertices) ? geometry.vertices : [];
    return vertices.length >= 9 && isCoplanarCloud(transformVertices(vertices, worldLinear));
  }
  if (geometry.type !== 'extrude') return false;
  const outline = Array.isArray(geometry.outline) ? geometry.outline : [];
  if (outline.length < 3 || !(geometry.depth > 0)) return false;
  const xs = outline.map(([x]) => x);
  const ys = outline.map(([, y]) => y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const xSpan = spanX * vectorLength(applyLinear(worldLinear, [1, 0, 0]));
  const ySpan = spanY * vectorLength(applyLinear(worldLinear, [0, 1, 0]));
  const span = Math.max(xSpan, ySpan);
  const thickness = geometry.depth * vectorLength(applyLinear(worldLinear, [0, 0, 1]));
  return span > 0 && thickness > 0 && thickness / span <= OPEN_SHELL_DEPTH_RATIO;
};

const isSlabGeometry = (geometry) => {
  if (!geometry) return false;
  if (geometry.type === 'extrude') {
    // `bevelEnabled` defaults to false in the schema, so a parsed spec always
    // carries it; `!== true` also reads a stored spec that predates it. The
    // thickness matters as much as the flag: a bevel of zero thickness adds no
    // depth plane, and flipping the boolean alone is the cheapest way for a
    // model to answer this gate without changing the geometry at all.
    return geometry.bevelEnabled !== true || !(geometry.bevelThickness > 0);
  }
  if (geometry.type !== 'custom') return false;
  const vertices = Array.isArray(geometry.vertices) ? geometry.vertices : [];
  if (vertices.length < 9) return false;
  return Math.min(...countAxisPlanes(vertices)) < SLAB_PLANE_THRESHOLD || isCoplanarCloud(vertices);
};

const collectMeshes = (part, out = []) => {
  if (part.geometry) out.push(part);
  for (const child of part.children || []) collectMeshes(child, out);
  return out;
};

/**
 * @param {object} spec a spec that has already passed `threejsSculptSpecSchema`
 * @returns {{findings: Array, errorCount: number, warningCount: number, noteCount: number,
 *   identityDetailCount: number, flatIdentityDetailCount: number, flatRatio: number|null,
 *   slabPartIds: string[]}}
 */
export function evaluateThreejsFlatness(spec) {
  const byId = new Map();
  const worldLinearById = new Map();
  const indexPart = (part, parentLinear = IDENTITY_LINEAR) => {
    byId.set(part.id, part);
    const worldLinear = multiplyLinear(parentLinear, partLinear(part));
    worldLinearById.set(part.id, worldLinear);
    for (const child of part.children || []) indexPart(child, worldLinear);
  };
  for (const part of spec?.parts || []) indexPart(part);

  const details = Array.isArray(spec?.detailInventory) ? spec.detailInventory : [];
  const slabPartIds = new Set();
  const flatDetails = [];
  let evaluated = 0;

  for (const detail of details) {
    if (detail.priority !== 'identity') continue;
    const meshes = new Map();
    for (const id of new Set(detail.implementationPartIds || [])) {
      const part = byId.get(id);
      if (!part) continue;
      // A detail may point at a group whose children carry the geometry, and two
      // of its ids may nest, so meshes are collected by id rather than counted.
      for (const mesh of collectMeshes(part)) meshes.set(mesh.id, mesh);
    }
    // Nothing was built for this feature anywhere — that is the assembly-coverage
    // gate's `unbuilt-detail`, and counting it here would let a spec that built
    // almost nothing read as a flat one.
    if (meshes.size === 0) continue;
    evaluated += 1;
    const implementing = [...meshes.values()];
    if (!implementing.every((mesh) => isSlabGeometry(mesh.geometry))) continue;
    flatDetails.push({
      feature: detail.feature,
      partIds: implementing.map((mesh) => mesh.id),
      isIntentionalMembrane: implementing.every((mesh) => (
        spec?.materials?.[mesh.material]?.side === 'double'
        && isZeroThicknessGeometry(mesh.geometry, worldLinearById.get(mesh.id))
      )),
    });
    for (const mesh of implementing) slabPartIds.add(mesh.id);
  }

  // `null`, not 0: a spec with no buildable identity feature was not measured
  // flat, it was not measured at all, and a 0 would read as a clean result.
  const flatFeatures = flatDetails.map(({ feature }) => feature);
  const intentionalMembraneDetails = flatDetails.filter(({ isIntentionalMembrane }) => isIntentionalMembrane);
  const intentionalMembraneFeatures = intentionalMembraneDetails.map(({ feature }) => feature);
  const unintentionalDetails = flatDetails.filter(({ isIntentionalMembrane }) => !isIntentionalMembrane);
  const unintentionalFeatures = unintentionalDetails.map(({ feature }) => feature);
  const intentionalMembranePartIds = new Set(intentionalMembraneDetails.flatMap(({ partIds }) => partIds));
  const flatRatio = evaluated === 0 ? null : flatFeatures.length / evaluated;
  const findings = [];
  if (flatRatio !== null && flatRatio > FLAT_IDENTITY_RATIO_THRESHOLD) {
    const nonMembraneFeatureCount = evaluated - intentionalMembraneDetails.length;
    const nonMembraneFlatRatio = nonMembraneFeatureCount === 0
      ? 0
      : unintentionalFeatures.length / nonMembraneFeatureCount;
    if (intentionalMembraneFeatures.length > 0) {
      findings.push({
        code: 'flat-identity-parts',
        severity: 'note',
        partIds: [...intentionalMembranePartIds],
        features: intentionalMembraneFeatures,
        message: `${intentionalMembraneFeatures.length} of ${evaluated} identity-defining features are intentional membrane surfaces (zero-thickness open shells: ${listSpecNames(intentionalMembraneFeatures)}). Their materials are double-sided (side "double"), so they remain visible from both sides.`,
      });
    }
    if (nonMembraneFlatRatio > FLAT_IDENTITY_RATIO_THRESHOLD) {
      const offenders = [...new Set(unintentionalDetails.flatMap(({ partIds }) => partIds))];
      findings.push({
        code: 'flat-identity-parts',
        severity: 'warning',
        partIds: offenders,
        features: unintentionalFeatures,
        message: `${unintentionalFeatures.length} of ${nonMembraneFeatureCount} identity-defining features are built only from flat parts (${listSpecNames(offenders.map((id) => byId.get(id)?.name || id))}). The model will read as a projection the moment it is orbited — give the parts the subject's identity rides on a real cross-section instead of stacking unbevelled extrusions and planar triangle fans. If a part is genuinely a zero-thickness membrane, make its material double-sided (side "double") instead; do not use that declaration to avoid giving a solid part real depth.`,
      });
    }
  }

  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
  const noteCount = findings.filter((finding) => finding.severity === 'note').length;

  return {
    findings,
    errorCount: 0,
    warningCount,
    noteCount,
    identityDetailCount: evaluated,
    flatIdentityDetailCount: flatFeatures.length,
    flatRatio,
    slabPartIds: [...slabPartIds],
  };
}

/**
 * Default refinement feedback derived from a stored flatness result. Returns ''
 * when the model has a cross-section, so the caller falls through to whatever
 * other feedback it has.
 */
export function buildThreejsFlatnessFeedback(flatness) {
  const warnings = (flatness?.findings || []).filter((finding) => finding.severity === 'warning');
  if (warnings.length === 0) return '';
  return [
    'The previous pass failed the cross-section check — it reads as a flat projection rather than a solid:',
    ...warnings.map((finding, index) => `${index + 1}. ${finding.message}`),
    'Rebuild those parts with genuine depth: compose them from primitives, or give an extrude a bevel, so the model holds up from any orbit angle. If a part is genuinely a zero-thickness membrane — such as a cape, leaf, fin, or wing — make its material double-sided (side "double") instead, but never use that declaration to avoid giving a solid part real depth.',
  ].join('\n');
}
