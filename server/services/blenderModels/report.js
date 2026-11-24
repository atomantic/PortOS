/**
 * A Blender model build's report: the checks that turn the driver's facts
 * (protocol.js events) into numbers and findings. Pure; build.js writes the
 * result to builds/<buildId>/report.json.
 *
 * Each finding is `{ severity, code, message, subjects?, values? }` with
 * severity `error`, `warning` or `note`; one finding per code, its `subjects`
 * naming the parts, meshes or axes it is about (motion.js adds one
 * `sweep-overlap` per pair of parts, with the `pose` that shows it). A build
 * with any error is kept and marked; only a build without errors can be
 * published.
 */
import { BLENDER_MODEL_BAKE_UV_OVERLAP_MAX, planBlenderModelBake } from './bakePlan.js';
import { motionChecks } from './motion.js';
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

// Reported once per control, action or scope; read by motion.js.
const MOTION_EVENTS = new Set(['control', 'control-skipped', 'action', 'sweep-scope', 'sweep-rest', 'sweep-overlap', 'reimport-control']);

/** Collects the events of one driver run; `facts()` is what `buildBlenderModelReport` reads. */
export function collectBlenderModelFacts() {
  const facts = { start: null, parts: [], described: null, meshes: [], bakeSets: [], scene: null, saved: null, reimport: null, done: null, sweep: null, motion: [] };
  return {
    add(event) {
      if (event.event === 'part') facts.parts.push({ id: event.id, label: event.label, parent: event.parent });
      else if (event.event === 'mesh') facts.meshes.push(event);
      else if (event.event === 'bakeSet') facts.bakeSets.push(event);
      else if (MOTION_EVENTS.has(event.event)) facts.motion.push(event);
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

const GLB_IMAGES_PER_SET = 3;

// A baked set the report shows: what it was baked from, how, and each image's size and brightest byte.
const bakedSetSummary = (set) => ({
  id: set.id, partIds: set.partIds, hash: set.hash, size: set.size, samples: set.samples, reused: set.reused, reusedFrom: set.reusedFrom,
  device: set.device, uvOverlap: set.uvOverlap, unwrapped: set.unwrapped, skipped: set.skipped, images: set.images,
});

/**
 * describe().bake against what the bake stages did (`bake.sets`, see bake.js). A draft build skips baking and says so.
 * An image that is missing, a set that is all black and a UV overlap over the limit are errors; the build is kept.
 */
function bakeChecks(facts, { quality, bake }, add) {
  const asked = facts.described?.bake ?? null;
  if (asked == null) return null;
  const plan = planBlenderModelBake(asked, facts.parts.map((part) => part.id));
  const summary = { size: plan.size, samples: plan.samples, skipped: null, sets: [] };
  if (quality !== 'full') {
    add('note', 'bake-skipped-draft', 'A draft build skips baking, so this GLB has no baked textures. Build full to bake them.');
    return { ...summary, skipped: 'draft' };
  }
  for (const problem of plan.problems) add('error', problem.code, problem.message, problem.subjects ? { subjects: problem.subjects } : {});
  if (plan.problems.length) return { ...summary, skipped: 'invalid' };
  const sets = bake?.sets ?? [];
  summary.sets = sets.map(bakedSetSummary);
  if (!sets.length) {
    add('error', 'bake-not-run', 'The build asked for a bake but no set was baked');
    return summary;
  }
  const unprepared = sets.filter((set) => set.skipped === 'not-prepared').map((set) => set.id);
  if (unprepared.length) add('error', 'bake-set-unprepared', 'A bake set could not be prepared: a part in it is not a mesh object', listed(unprepared));
  const overlapping = sets.filter((set) => set.uvOverlap != null && set.uvOverlap > BLENDER_MODEL_BAKE_UV_OVERLAP_MAX);
  if (overlapping.length) {
    add('error', 'bake-uv-overlap', `More than ${BLENDER_MODEL_BAKE_UV_OVERLAP_MAX * 100}% of a set's UV area is covered twice, so it was not baked; give its parts separate UV islands`, {
      ...listed(overlapping.map((set) => set.id)), values: Object.fromEntries(overlapping.map((set) => [set.id, round(set.uvOverlap, 4)])),
    });
  }
  const baked = sets.filter((set) => set.skipped === null);
  const images = baked.flatMap((set) => set.images.map((image) => ({ ...image, label: `${set.id}/${image.file}` })));
  const missing = images.filter((image) => image.bytes == null).map((image) => image.label);
  if (missing.length) add('error', 'bake-image-missing', 'A baked set wrote no image file', listed(missing));
  const black = images.filter((image) => image.bytes != null && image.max === 0).map((image) => image.label);
  if (black.length) add('error', 'bake-all-black', 'A baked image has no pixel above black, so its set did not bake', listed(black));
  const reused = baked.filter((set) => set.reused).length;
  add('note', 'bake-sets', `${baked.length} baked set(s) at ${plan.size} px, ${plan.samples} samples; ${reused} reused from an earlier build`, {
    values: { size: plan.size, samples: plan.samples, sets: baked.length, reused },
  });
  const expected = baked.filter((set) => set.images.every((image) => image.bytes != null)).length * GLB_IMAGES_PER_SET;
  if (facts.reimport?.images != null && facts.reimport.images < expected) {
    add('warning', 'bake-glb-images', 'The re-imported GLB has fewer images than the baked sets', { values: { expected, reimported: facts.reimport.images } });
  }
  return summary;
}

/**
 * The report for one finished driver run. `glbBytes` is the GLB's size on disk
 * as the server found it (null: missing), which overrides what the driver said.
 * `bake` is `{ sets }` from the bake stage, absent when none ran.
 */
export function buildBlenderModelReport(facts, { modelId, buildId, quality, startedAt, finishedAt, srcHash, glbBytes, bake = null }) {
  const findings = [];
  const add = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra });

  const described = facts.described;
  if (!described) add('error', 'describe-missing', 'describe(ctx) returned nothing the build could read');
  else {
    if (!described.sizeMeters) add('error', 'describe-size-invalid', 'describe(ctx) must return sizeMeters {x, y, z}, each a positive number of meters');
    if (described.triangleBudget == null) add('error', 'describe-budget-invalid', 'describe(ctx) must return triangleBudget, a whole number of triangles');
    if (!facts.parts.length) add('error', 'parts-none', 'describe(ctx) declared no parts');
  }
  const parts = partChecks(facts, add);
  if (facts.scene && facts.scene.meshes === 0) add('error', 'meshes-none', 'build(ctx) created no mesh objects');
  if (facts.scene?.truncated) add('warning', 'meshes-truncated', 'The scene has more meshes than a build lists; the rest were counted but not checked by name');
  const bounds = boundsCheck(facts, add);
  const triangles = triangleCheck(facts, add);
  const transforms = transformChecks(facts, add);
  const motion = motionChecks(facts, add);
  if (facts.scene) {
    add('note', 'materials', `${facts.scene.materials ?? 0} material(s) and ${facts.scene.images ?? 0} image(s)`, {
      values: { materials: facts.scene.materials, images: facts.scene.images },
    });
  }
  if (glbBytes == null) add('error', 'export-missing', 'The build wrote no model.glb');
  const reimport = glbBytes == null ? null : reimportChecks(facts, add);
  if (glbBytes != null && !reimport) add('error', 'reimport-missing', 'The GLB was not re-imported, so it was not verified');
  const bakeCheck = bakeChecks(facts, { quality, bake }, add);

  const counts = Object.fromEntries(BLENDER_MODEL_SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]));
  const order = (finding) => BLENDER_MODEL_SEVERITIES.indexOf(finding.severity);
  return {
    schemaVersion: 1,
    modelId, buildId, quality, srcHash, startedAt, finishedAt,
    blenderVersion: facts.start?.blender ?? null,
    describe: described ? {
      title: described.title, sizeMeters: described.sizeMeters, triangleBudget: described.triangleBudget,
      parts: facts.parts, controls: described.controls ?? null, actions: described.actions ?? null,
    } : null,
    checks: {
      parts, bounds, triangles, transforms,
      materials: facts.scene?.materials ?? null, images: facts.scene?.images ?? null, actions: facts.scene?.actions ?? null,
      glbBytes, reimport, motion, bake: bakeCheck,
    },
    findings: findings.sort((a, b) => order(a) - order(b)),
    counts,
    publishable: counts.error === 0,
  };
}
