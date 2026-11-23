/**
 * A Blender model build's report: the checks that turn the driver's facts
 * (protocol.js events) into numbers and findings. Pure; build.js writes the
 * result to builds/<buildId>/report.json.
 *
 * Each finding is `{ severity, code, message, subjects?, values? }` with
 * severity `error`, `warning` or `note`; one finding per code, its `subjects`
 * naming the parts, meshes or axes it is about. A build with any error is kept
 * and marked; only a build without errors can be published.
 */
import { reviewFrameMeters } from './reviewCameras.js';

export const BLENDER_MODEL_SEVERITIES = Object.freeze(['error', 'warning', 'note']);

// Declared size vs built bounds, per axis, as a fraction of the declared size.
const BOUNDS_ERROR = 0.1;
const BOUNDS_WARNING = 0.02;
// Export and re-import should agree to well under a millimetre on a metre-scale model.
const REIMPORT_BOUNDS_TOLERANCE = 1e-3;
const SCALE_EPSILON = 1e-4;
const SUBJECTS_LISTED = 50;
const PART_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AXES = ['x', 'y', 'z'];

/** Collects the events of one driver run; `facts()` is what `buildBlenderModelReport` reads. */
export function collectBlenderModelFacts() {
  const facts = { start: null, parts: [], described: null, meshes: [], scene: null, saved: null, reimport: null, done: null };
  return {
    add(event) {
      if (event.event === 'part') facts.parts.push({ id: event.id, label: event.label, parent: event.parent });
      else if (event.event === 'mesh') facts.meshes.push(event);
      else if (event.event in facts) facts[event.event] = event;
    },
    facts: () => facts,
  };
}

const round = (value, digits = 6) => (value == null ? null : Number(value.toFixed(digits)));
const extent = ({ min, max }) => (min && max ? { x: round(max[0] - min[0]), y: round(max[1] - min[1]), z: round(max[2] - min[2]) } : null);
const listed = (items) => ({ subjects: items.slice(0, SUBJECTS_LISTED), ...(items.length > SUBJECTS_LISTED ? { more: items.length - SUBJECTS_LISTED } : {}) });

function partChecks(facts, add) {
  const declared = facts.parts;
  const ids = declared.map((part) => part.id);
  const invalid = declared.filter((part) => typeof part.id !== 'string' || !PART_ID.test(part.id)).map((part) => String(part.id ?? '(none)'));
  if (invalid.length) add('error', 'part-id-invalid', 'Part ids must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit', listed(invalid));
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length) add('error', 'part-duplicate', 'Two declared parts share an id', listed(duplicates));
  const known = new Set(ids);
  const orphans = declared.filter((part) => part.parent != null && !known.has(part.parent)).map((part) => part.id);
  if (orphans.length) add('error', 'part-parent-unknown', 'A declared parent is not a declared part', listed(orphans));
  if (facts.described?.partsTruncated) add('warning', 'parts-truncated', 'describe() declared more parts than a build checks; the rest were not checked');

  const meshes = new Map(facts.meshes.map((mesh) => [mesh.name, mesh]));
  const missing = ids.filter((id) => !meshes.has(id));
  const undeclared = [...meshes.keys()].filter((name) => !known.has(name));
  if (missing.length) add('error', 'part-missing', 'A declared part has no mesh object named by its id', listed(missing));
  if (undeclared.length) add('warning', 'mesh-undeclared', 'A mesh object is not a declared part', listed(undeclared));
  const reparented = declared.filter((part) => meshes.has(part.id) && (meshes.get(part.id).parent ?? null) !== (part.parent ?? null)).map((part) => part.id);
  if (reparented.length) add('warning', 'part-parent-mismatch', 'A part\'s Blender parent is not the parent it declares', listed(reparented));
  // Where a saved camera aims when it names a part.
  const centers = Object.fromEntries(ids.filter((id) => meshes.get(id)?.min && meshes.get(id)?.max)
    .map((id) => [id, AXES.map((_, axis) => round((meshes.get(id).min[axis] + meshes.get(id).max[axis]) / 2))]));
  return { declared: declared.length, built: facts.meshes.length, missing, undeclared, reparented, centers };
}

function boundsCheck(facts, add) {
  const declared = facts.described?.sizeMeters ?? null;
  const actual = facts.scene ? extent(facts.scene) : null;
  if (!declared || !actual) return { declared, actual, error: null };
  const error = Object.fromEntries(AXES.map((axis) => [axis, round((actual[axis] - declared[axis]) / declared[axis], 4)]));
  const over = AXES.filter((axis) => error[axis] > BOUNDS_ERROR);
  const under = AXES.filter((axis) => error[axis] < -BOUNDS_ERROR);
  const drift = AXES.filter((axis) => Math.abs(error[axis]) > BOUNDS_WARNING && Math.abs(error[axis]) <= BOUNDS_ERROR);
  const values = { declared, actual, error };
  if (over.length) add('error', 'bounds-oversized', `The model is more than ${BOUNDS_ERROR * 100}% larger than its declared size`, { subjects: over, values });
  if (under.length) add('error', 'bounds-undersized', `The model is more than ${BOUNDS_ERROR * 100}% smaller than its declared size`, { subjects: under, values });
  if (drift.length) add('warning', 'bounds-drift', `The model is ${BOUNDS_WARNING * 100}-${BOUNDS_ERROR * 100}% off its declared size`, { subjects: drift, values });
  // Review cameras frame the declared box standing on Z = 0 around X = Y = 0, not the mesh.
  const half = reviewFrameMeters(declared) / 2;
  const center = { x: 0, y: 0, z: declared.z / 2 };
  const outside = AXES.filter((axis, index) => facts.scene.min[index] < center[axis] - half || facts.scene.max[index] > center[axis] + half);
  if (outside.length) add('warning', 'review-out-of-frame', 'Part of the model falls outside its review views; stand it on Z = 0, centered on X = Y = 0', { subjects: outside });
  return values;
}

function triangleCheck(facts, add) {
  const total = facts.scene?.triangles ?? null;
  const budget = facts.described?.triangleBudget ?? null;
  if (total != null && budget != null && total > budget) {
    add('error', 'triangles-over-budget', `The model has ${total} triangles; its budget is ${budget}`, { values: { total, budget } });
  }
  return { total, budget, ratio: total != null && budget ? round(total / budget, 4) : null };
}

function transformChecks(facts, add) {
  const unapplied = facts.meshes.filter((mesh) => mesh.scale && mesh.scale.some((n) => Math.abs(Math.abs(n) - 1) > SCALE_EPSILON)).map((mesh) => mesh.name);
  const negative = facts.meshes.filter((mesh) => mesh.negative).map((mesh) => mesh.name);
  if (unapplied.length) add('warning', 'scale-unapplied', 'A mesh object carries an unapplied scale; apply it so the GLB carries plain sizes', listed(unapplied));
  if (negative.length) add('error', 'scale-negative', 'A mesh object is mirrored by a negative scale, which flips its faces in the GLB', listed(negative));
  return { unapplied, negative };
}

function reimportChecks(facts, add) {
  const before = facts.scene;
  const after = facts.reimport;
  if (!after) return null;
  const compare = (key, severity, code, message) => {
    if (before?.[key] != null && after[key] != null && before[key] !== after[key]) add(severity, code, message, { values: { built: before[key], reimported: after[key] } });
  };
  compare('meshes', 'error', 'reimport-mesh-count', 'The re-imported GLB has a different number of meshes');
  compare('triangles', 'error', 'reimport-triangles', 'The re-imported GLB has a different number of triangles');
  compare('materials', 'warning', 'reimport-materials', 'The re-imported GLB has a different number of materials');
  compare('actions', 'warning', 'reimport-actions', 'The re-imported GLB has a different number of animation actions');
  const built = before ? extent(before) : null;
  const reimported = extent(after);
  if (built && reimported) {
    const off = AXES.filter((axis) => Math.abs(built[axis] - reimported[axis]) > REIMPORT_BOUNDS_TOLERANCE);
    if (off.length) add('error', 'reimport-bounds', 'The re-imported GLB is a different size than the built model', { subjects: off, values: { built, reimported } });
  }
  return {
    objects: after.objects, meshes: after.meshes, triangles: after.triangles, materials: after.materials,
    images: after.images, actions: after.actions, size: reimported, min: after.min, max: after.max,
  };
}

/**
 * The report for one finished driver run. `glbBytes` is the GLB's size on disk
 * as the server found it (null: missing), which overrides what the driver said.
 */
export function buildBlenderModelReport(facts, { modelId, buildId, quality, startedAt, finishedAt, srcHash, glbBytes }) {
  const findings = [];
  const add = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra });

  const described = facts.described;
  if (!described) add('error', 'describe-missing', 'describe(ctx) returned nothing the build could read');
  else {
    if (!described.sizeMeters) add('error', 'describe-size-invalid', 'describe(ctx) must return sizeMeters {x, y, z}, each a positive number of meters');
    if (described.triangleBudget == null) add('error', 'describe-budget-invalid', 'describe(ctx) must return triangleBudget, a whole number of triangles');
    if (!facts.parts.length) add('error', 'parts-none', 'describe(ctx) declared no parts');
    if (!described.controlsValid) add('warning', 'controls-invalid', 'controls must be a list of objects (at most 16 KiB); it was not stored');
  }
  const parts = partChecks(facts, add);
  if (facts.scene && facts.scene.meshes === 0) add('error', 'meshes-none', 'build(ctx) created no mesh objects');
  if (facts.scene?.truncated) add('warning', 'meshes-truncated', 'The scene has more meshes than a build lists; the rest were counted but not checked by name');
  const bounds = boundsCheck(facts, add);
  const triangles = triangleCheck(facts, add);
  const transforms = transformChecks(facts, add);
  if (facts.scene) {
    add('note', 'materials', `${facts.scene.materials ?? 0} material(s) and ${facts.scene.images ?? 0} image(s)`, {
      values: { materials: facts.scene.materials, images: facts.scene.images },
    });
  }
  if (glbBytes == null) add('error', 'export-missing', 'The build wrote no model.glb');
  const reimport = glbBytes == null ? null : reimportChecks(facts, add);
  if (glbBytes != null && !reimport) add('error', 'reimport-missing', 'The GLB was not re-imported, so it was not verified');

  const counts = Object.fromEntries(BLENDER_MODEL_SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]));
  const order = (finding) => BLENDER_MODEL_SEVERITIES.indexOf(finding.severity);
  return {
    schemaVersion: 1,
    modelId, buildId, quality, srcHash, startedAt, finishedAt,
    blenderVersion: facts.start?.blender ?? null,
    describe: described ? {
      title: described.title, sizeMeters: described.sizeMeters, triangleBudget: described.triangleBudget,
      parts: facts.parts, controls: described.controls,
    } : null,
    checks: {
      parts, bounds, triangles, transforms,
      materials: facts.scene?.materials ?? null, images: facts.scene?.images ?? null, actions: facts.scene?.actions ?? null,
      glbBytes, reimport,
    },
    findings: findings.sort((a, b) => order(a) - order(b)),
    counts,
    publishable: counts.error === 0,
  };
}
