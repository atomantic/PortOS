/**
 * Texture baking of a Blender model build (issue #17879). A full build whose
 * describe() asks for a bake saves model.blend and stops; this module then
 * bakes each set in its own Blender process, one at a time, and a final
 * process swaps each baked set's materials for plain glTF ones and exports the
 * GLB (build.js runs the sequence). A bake is a job of kind `bake` per set,
 * cancelable on its own, and runs inside the build's tracked slot, so it joins
 * the build's limits: one Blender process per model at a time and the build's
 * wall-clock, memory and disk caps.
 *
 * builds/<buildId>/bake/<setId>/ holds base_color.png, normal.png, orm.png
 * (R occlusion, G roughness, B metal) and bake.json (what the set was baked
 * from). A set is rendered beside its final folder and renamed in whole, so
 * a canceled or failed bake never leaves a partial set. A set whose hash,
 * size and samples match one of the model's earlier builds is copied from it.
 */
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../lib/fileCore.js';
import { assertInsideWithoutSymlinks } from '../blenderWorkspace/containment.js';
import { runBlenderModelDriver } from './driver.js';
import { BLENDER_MODEL_BAKE_IMAGES, BLENDER_MODEL_BAKE_UV_OVERLAP_MAX } from './bakePlan.js';
import { cancelJob, ownerOf, registry } from './jobs.js';
import { blenderModelBuildDir, blenderModelWorkspaceDir } from './workspace.js';

const IMAGE_NAMES = Object.keys(BLENDER_MODEL_BAKE_IMAGES);
const MANIFEST = 'bake.json';
// Cycles uses a GPU when it finds one; PORTOS_BLENDER_BAKE_DEVICE=cpu keeps bakes on the CPU (a first GPU bake compiles kernels for minutes).
const BAKE_DEVICE = process.env.PORTOS_BLENDER_BAKE_DEVICE === 'cpu' ? 'cpu' : 'auto';

export const blenderModelBakeDir = (id, buildId) => join(blenderModelBuildDir(id, buildId), 'bake');
const setDir = (id, buildId, setId) => join(blenderModelBakeDir(id, buildId), setId);

const readJson = async (path) => {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
};

/** The three images of a set folder with their size on disk (null: missing) and brightest byte (from bake.json). */
async function inspectImages(dir, manifest) {
  return Promise.all(IMAGE_NAMES.map(async (name) => {
    const file = BLENDER_MODEL_BAKE_IMAGES[name];
    const info = await lstat(join(dir, file)).catch(() => null);
    const recorded = (manifest?.images ?? []).find((image) => image?.name === name);
    return { name, file, bytes: info?.isFile() ? info.size : null, max: Number.isInteger(recorded?.max) ? recorded.max : null };
  }));
}

const complete = (images) => images.every((image) => image.bytes !== null && image.bytes > 0);

/** The newest earlier build's set folder baked from the same hash, size and samples, or null. */
async function findReusable({ id, builds, buildId, spec, hash, size, samples }) {
  for (const build of [...builds].reverse()) {
    if (build.id === buildId || build.status !== 'complete') continue;
    const dir = setDir(id, build.id, spec.id);
    const manifest = await readJson(join(dir, MANIFEST));
    if (manifest?.hash !== hash || manifest.size !== size || manifest.samples !== samples) continue;
    const images = await inspectImages(dir, manifest);
    if (complete(images) && images.every((image) => image.max !== 0)) return { buildId: build.id, dir, manifest };
  }
  return null;
}

async function copySet({ from, to, manifest, reusedFrom }) {
  await mkdir(to, { recursive: true });
  for (const file of Object.values(BLENDER_MODEL_BAKE_IMAGES)) await copyFile(join(from, file), join(to, file));
  await atomicWrite(join(to, MANIFEST), `${JSON.stringify({ ...manifest, reusedFrom }, null, 2)}\n`);
}

async function bakeOne({ id, buildId, tool, signal, log, spec, size, samples, hash, fact }) {
  const bakes = blenderModelBakeDir(id, buildId);
  const final = setDir(id, buildId, spec.id);
  const staged = join(bakes, `.staging-${randomUUID()}`);
  const entry = registry.create(ownerOf(id), { kind: 'bake', buildId, setId: spec.id, size, samples });
  const own = entry.abort.signal;
  try {
    await assertInsideWithoutSymlinks(blenderModelWorkspaceDir(id), staged);
    await mkdir(staged, { recursive: true });
    registry.update(entry, { status: 'running' });
    let baked = null;
    const result = await runBlenderModelDriver({
      tool,
      job: { mode: 'bake', blend: join(blenderModelBuildDir(id, buildId), 'model.blend'), out: staged, set: { id: spec.id, partIds: spec.partIds }, size, samples, device: BAKE_DEVICE },
      signal: AbortSignal.any([signal, own]),
      onEvent: (event) => { if (event.event === 'bakeResult' && event.id === spec.id) baked = event; },
      onLog: log.write,
    });
    if (result.traceback) for (const line of result.traceback.split('\n')) log.write(line);
    if (result.canceled) {
      registry.update(entry, { status: 'canceled' });
      // `own` fired alone: this bake was canceled; otherwise the whole build was.
      return { canceled: true, setId: spec.id, byBake: own.aborted && !signal.aborted };
    }
    if (!result.ok) {
      registry.update(entry, { status: 'error', error: result.error });
      return { error: `Baking set ${spec.id} failed: ${result.error}` };
    }
    const manifest = {
      schemaVersion: 1, setId: spec.id, partIds: spec.partIds, hash, size, samples, device: baked?.device ?? null, unwrapped: fact.unwrapped,
      bakedAt: new Date().toISOString(), images: baked?.images ?? [],
    };
    await atomicWrite(join(staged, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(final, { recursive: true, force: true });
    await rename(staged, final);
    registry.update(entry, { status: 'done' });
    return { manifest };
  } catch (error) {
    registry.update(entry, { status: own.aborted || signal.aborted ? 'canceled' : 'error', error: error.message });
    if (own.aborted || signal.aborted) return { canceled: true, setId: spec.id, byBake: own.aborted && !signal.aborted };
    return { error: `Baking set ${spec.id} failed: ${error.message}` };
  } finally {
    await rm(staged, { recursive: true, force: true }).catch((error) => console.error(`❌ Blender model bake files could not be removed: ${error.message}`));
  }
}

/**
 * Bake (or reuse) every set of a valid plan, one after another. Resolves
 * `{ sets }`, one entry per planned set with what the report shows, or
 * `{ canceled, setId, byBake }` / `{ error }` when the build cannot go on.
 *
 * `facts` is `Map<setId, bakeSet event>` from the build stage; `builds` is the
 * model's build list (for reuse).
 */
export async function bakeBlenderModelSets({ id, buildId, tool, signal, log, plan, facts, builds }) {
  const sets = [];
  for (const spec of plan.sets) {
    if (signal.aborted) return { canceled: true, setId: null, byBake: false };
    const fact = facts.get(spec.id);
    const set = {
      id: spec.id, partIds: spec.partIds, hash: fact?.hash ?? null, uvOverlap: fact?.uvOverlap ?? null, unwrapped: fact?.unwrapped ?? false,
      size: plan.size, samples: plan.samples, reused: false, reusedFrom: null, device: null, skipped: null, images: [],
    };
    sets.push(set);
    if (!fact?.hash) {
      set.skipped = 'not-prepared';
      log.write(`Set ${spec.id} was not prepared for baking, so it was not baked.`);
      continue;
    }
    if (fact.uvOverlap > BLENDER_MODEL_BAKE_UV_OVERLAP_MAX) {
      set.skipped = 'uv-overlap';
      log.write(`Set ${spec.id} has ${(fact.uvOverlap * 100).toFixed(1)}% UV overlap, so it was not baked.`);
      continue;
    }
    const final = setDir(id, buildId, spec.id);
    let manifest;
    const reusable = await findReusable({ id, builds, buildId, spec, hash: fact.hash, size: plan.size, samples: plan.samples });
    if (reusable) {
      await assertInsideWithoutSymlinks(blenderModelWorkspaceDir(id), final);
      await rm(final, { recursive: true, force: true });
      await copySet({ from: reusable.dir, to: final, manifest: reusable.manifest, reusedFrom: reusable.buildId });
      manifest = { ...reusable.manifest, reusedFrom: reusable.buildId };
      set.reused = true;
      set.reusedFrom = reusable.buildId;
      log.write(`Set ${spec.id} is unchanged since build ${reusable.buildId}; its images were reused.`);
    } else {
      const outcome = await bakeOne({ id, buildId, tool, signal, log, spec, size: plan.size, samples: plan.samples, hash: fact.hash, fact });
      if (outcome.canceled || outcome.error) return outcome;
      ({ manifest } = outcome);
    }
    set.device = manifest.device ?? null;
    set.images = await inspectImages(final, manifest);
  }
  return { sets };
}

/** The sets whose three images exist: what the export stage can use. */
export const exportableSets = (sets) => sets.filter((set) => set.images.length && complete(set.images));

/** The folder a set's images were baked into, for the export job. */
export const blenderModelBakeSetDir = setDir;

/** Cancel the bake of `setId` in `buildId`. */
export const cancelBlenderModelBake = (id, buildId, setId) => cancelJob(id, 'bake', buildId, setId);

