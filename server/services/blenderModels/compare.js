/**
 * What a model's builds are compared against (issue #17877): saved cameras, one
 * per panel of a reference image, and the differences a person or an agent
 * recorded. There is no similarity score: a reference has no measured scale.
 *
 * Record fields (additive): `cameras`, each `{ id, label, referenceId, crop,
 * view | orbit }` (a fixed direction, or an orbit with its aim resolved to a
 * point so a rebuilt part cannot move the frame; `crop` is the matching panel as
 * 0-1 fractions of the reference), and `differences`, each `{ id, text, partId,
 * referenceId, status: open | fixed | accepted, reason, closedBuildId, closedAt,
 * createdAt }`. Neither belongs to a build, so both survive rebuilds.
 */
import { randomUUID } from 'node:crypto';
import { blenderRefusal } from '../blenderWorkspace/containment.js';
import { newestCompleteBuild, readBuildReport } from './review.js';
import * as store from './store.js';
import { assertBlenderModelId } from './workspace.js';

const MAX_CAMERAS = 32;
const MAX_DIFFERENCES = 200;

const notFound = (message) => blenderRefusal(message, 'NOT_FOUND', 404);

async function requireModel(id) {
  assertBlenderModelId(id);
  const model = await store.getModel(id);
  if (!model) throw notFound('Blender model not found');
  return model;
}

function requireReference(model, referenceId) {
  // The overall sheet's slot exists on every model, stored or not.
  if (referenceId !== 'overall' && !(model.references || []).some((slot) => slot.id === referenceId)) throw notFound('That reference is not on this model');
}

// The point an orbit looks at, fixed when the camera is saved.
async function aim(model, orbit) {
  if (!orbit.partId) return { ...orbit, partId: null, target: orbit.target ?? null };
  if (orbit.target) return orbit;
  const build = newestCompleteBuild(model);
  const center = build ? (await readBuildReport(model.id, build.id))?.checks?.parts?.centers?.[orbit.partId] : null;
  if (!center) throw blenderRefusal(`The newest completed build has no measured part "${orbit.partId}". Build the model again, or aim at the whole model.`, 'BLENDER_MODEL_PART_NOT_MEASURED', 409);
  return { ...orbit, target: center };
}

// A camera is a fixed direction or an orbit: setting one clears the other.
const framing = async (model, { view, orbit }) => (orbit ? { view: null, orbit: await aim(model, orbit) } : { view, orbit: null });

export async function addBlenderModelCamera(id, { label, referenceId, crop = null, view, orbit }) {
  const model = await requireModel(id);
  requireReference(model, referenceId);
  const camera = { id: `camera-${randomUUID().slice(0, 8)}`, label, referenceId, crop, ...await framing(model, { view, orbit }) };
  await store.mutateModel(id, (current) => {
    requireReference(current, referenceId);
    if ((current.cameras || []).length >= MAX_CAMERAS) throw blenderRefusal(`A model takes at most ${MAX_CAMERAS} cameras.`, 'BLENDER_MODEL_TOO_MANY_CAMERAS', 409);
    return { ...current, cameras: [...(current.cameras || []), camera] };
  });
}

/** Change a camera; an absent key stays as it is. */
export async function updateBlenderModelCamera(id, cameraId, { view, orbit, ...patch }) {
  const model = await requireModel(id);
  const change = { ...patch, ...(view || orbit ? await framing(model, { view, orbit }) : {}) };
  await store.mutateModel(id, (current) => {
    if (!(current.cameras || []).some((camera) => camera.id === cameraId)) throw notFound('That camera is not on this model');
    if (change.referenceId) requireReference(current, change.referenceId);
    return { ...current, cameras: current.cameras.map((camera) => (camera.id === cameraId ? { ...camera, ...change } : camera)) };
  });
}

export async function removeBlenderModelCamera(id, cameraId) {
  await requireModel(id);
  await store.mutateModel(id, (current) => {
    const cameras = (current.cameras || []).filter((camera) => camera.id !== cameraId);
    if (cameras.length === (current.cameras || []).length) throw notFound('That camera is not on this model');
    return { ...current, cameras };
  });
}

export async function addBlenderModelDifference(id, { text, partId = null, referenceId = null }) {
  await requireModel(id);
  await store.mutateModel(id, (current) => {
    if (referenceId) requireReference(current, referenceId);
    if ((current.differences || []).length >= MAX_DIFFERENCES) throw blenderRefusal(`A model keeps at most ${MAX_DIFFERENCES} differences. Delete closed ones first.`, 'BLENDER_MODEL_TOO_MANY_DIFFERENCES', 409);
    const difference = {
      id: `difference-${randomUUID().slice(0, 8)}`, text, partId, referenceId, status: 'open', reason: '', closedBuildId: null, closedAt: null, createdAt: new Date().toISOString(),
    };
    return { ...current, differences: [...(current.differences || []), difference] };
  });
}

// Closing needs the build it was judged on: the one named, else the newest completed one.
function closing(model, buildId) {
  if (buildId) {
    if (!(model.builds || []).some((build) => build.id === buildId && build.status === 'complete')) throw notFound('That completed build is not on this model');
    return buildId;
  }
  const newest = newestCompleteBuild(model);
  if (!newest) throw blenderRefusal('Build the model before closing a difference: closing records the build it was judged on.', 'BLENDER_MODEL_NO_BUILD', 409);
  return newest.id;
}

/** Change a difference; an absent key stays as it is. Closing records the build; reopening clears it. */
export async function updateBlenderModelDifference(id, differenceId, { buildId, ...patch }) {
  await requireModel(id);
  await store.mutateModel(id, (current) => {
    const difference = (current.differences || []).find((entry) => entry.id === differenceId);
    if (!difference) throw notFound('That difference is not on this model');
    if (patch.referenceId && patch.referenceId !== difference.referenceId) requireReference(current, patch.referenceId);
    const next = { ...difference, ...patch };
    if (next.status === 'accepted' && !next.reason) throw blenderRefusal('Say why this difference is intended before accepting it.', 'VALIDATION_ERROR');
    if (next.status !== 'accepted') next.reason = '';
    if (patch.status && patch.status !== difference.status) {
      const closed = patch.status !== 'open';
      Object.assign(next, { closedBuildId: closed ? closing(current, buildId) : null, closedAt: closed ? new Date().toISOString() : null });
    }
    return { ...current, differences: current.differences.map((entry) => (entry.id === differenceId ? next : entry)) };
  });
}

export async function removeBlenderModelDifference(id, differenceId) {
  await requireModel(id);
  await store.mutateModel(id, (current) => {
    const differences = (current.differences || []).filter((entry) => entry.id !== differenceId);
    if (differences.length === (current.differences || []).length) throw notFound('That difference is not on this model');
    return { ...current, differences };
  });
}
