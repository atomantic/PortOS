/**
 * A Blender model build: an empty factory scene, the model's describe() and
 * build(), the checks, model.blend and model.glb, then the GLB re-imported into
 * a fresh scene and measured again. The driver streams facts; report.js turns
 * them into report.json beside the outputs in builds/<buildId>/.
 *
 * One build runs per model. A build never changes `publishedBuildId`: a
 * canceled, crashed or flagged build is recorded and kept, and the published
 * build stays what it was. Builds are pruned to the published one, any running
 * one and the newest five. Explicit actions only; nothing here runs at boot
 * except marking a build the restart interrupted as failed.
 *
 * Backup admission: the driver writes the build's bytes in place while its row
 * says `running`, so only the commit that names the finished build takes the
 * lease. Pruning drops builds from the row before it removes their folders.
 */
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { atomicWrite } from '../../lib/fileCore.js';
import { trackedRenderMap } from '../renderActivity.js';
import { blenderRefusal } from '../blenderWorkspace/containment.js';
import { createBlenderJobRegistry } from '../blenderWorkspace/jobRegistry.js';
import { openBlenderJobLogFile } from '../blenderWorkspace/jobLog.js';
import { walkSourceTree } from '../blenderWorkspace/sourceTree.js';
import { hashSourceEntries } from '../blenderWorkspace/treeHash.js';
import { requireBlenderModelTool, runBlenderModelDriver } from './driver.js';
import { buildBlenderModelReport, collectBlenderModelFacts } from './report.js';
import * as store from './store.js';
import {
  BLENDER_MODEL_BUILD_ID, assertBlenderModelId, blenderModelBuildDir, blenderModelBuildsDir, blenderModelSrcDir, blenderModelWorkspaceDir, newBlenderModelBuildId,
} from './workspace.js';

const BUILDS_KEPT = 5;

const registry = createBlenderJobRegistry({ keyOf: (owner) => owner.id, label: 'Blender model', keptPerOwner: 10 });
// Reserved synchronously before a start awaits, so two requests cannot both start a build.
const starting = new Set();
// model id → the promise of its running build, so a delete can wait for it to settle.
const settling = new Map();
// Counts toward system activity, so the unattended updater does not restart through a build.
const inFlight = trackedRenderMap('blender-model', { noun: 'Blender model build' });

const ownerOf = (id) => ({ id, emit: () => store.announceBlenderModel(id) });

export const listBlenderModelJobs = (id) => registry.list(ownerOf(id));
const activeBuild = (id) => registry.active(ownerOf(id))[0] ?? null;

/** Build ids that survive pruning: published, running, and the newest BUILDS_KEPT. */
function keptBlenderModelBuildIds(model) {
  // Builds are appended as they start, so the row's order breaks a same-millisecond tie.
  const builds = (model.builds || []).map((build, index) => ({ build, index }))
    .sort((a, b) => String(b.build.startedAt).localeCompare(String(a.build.startedAt)) || b.index - a.index)
    .map(({ build }) => build);
  const kept = new Set(builds.slice(0, BUILDS_KEPT).map((build) => build.id));
  for (const build of builds) if (build.status === 'running') kept.add(build.id);
  if (model.publishedBuildId) kept.add(model.publishedBuildId);
  return kept;
}

/**
 * Drop the builds pruning does not keep from the record, then remove their
 * folders, and any build folder no record names (one a crash left behind).
 */
export async function pruneBlenderModelBuilds(id) {
  await store.mutateModel(id, (current) => {
    const kept = keptBlenderModelBuildIds(current);
    if ((current.builds || []).every((build) => kept.has(build.id))) return null;
    return { ...current, builds: current.builds.filter((build) => kept.has(build.id)) };
  }, { includeDeleted: true });
  const names = await readdir(blenderModelBuildsDir(id)).catch(() => []);
  if (!names.length) return;
  // Read after the listing: a build's row entry is committed before its folder exists.
  const named = new Set(((await store.getModel(id, { includeDeleted: true }))?.builds || []).map((build) => build.id));
  for (const name of names) {
    if (!BLENDER_MODEL_BUILD_ID.test(name) || named.has(name)) continue;
    await rm(blenderModelBuildDir(id, name), { recursive: true, force: true });
  }
}

const replaceBuild = (model, buildId, change) => ({
  ...model,
  builds: (model.builds || []).map((build) => (build.id === buildId ? { ...build, ...change } : build)),
});

async function runBuild({ id, buildId, quality, tool, entry, startedAt, srcHash }) {
  const out = blenderModelBuildDir(id, buildId);
  const facts = collectBlenderModelFacts();
  let log = null;
  try {
    await mkdir(out, { recursive: true });
    log = await openBlenderJobLogFile({ directory: out, name: 'build.log', label: `Blender model build ${buildId}` });
    registry.update(entry, { status: 'running' });
    const result = await runBlenderModelDriver({
      tool,
      job: { mode: 'build', workspace: blenderModelWorkspaceDir(id), src: blenderModelSrcDir(id), out, quality },
      signal: entry.abort.signal,
      onEvent: (event) => facts.add(event),
      onLog: log.write,
    });
    if (result.traceback) for (const line of result.traceback.split('\n')) log.write(line);
    await log.close();
    log = null;
    const finishedAt = new Date().toISOString();
    if (!result.ok) {
      await store.mutateModel(id, (current) => replaceBuild(current, buildId, {
        status: result.canceled ? 'canceled' : 'failed', finishedAt, error: result.error,
        blenderVersion: facts.facts().start?.blender ?? null,
      }), { includeDeleted: true });
      registry.update(entry, { status: result.canceled ? 'canceled' : 'error', error: result.error });
      console.log(`🧊 Blender model ${id.slice(0, 15)} build ${buildId} ${result.canceled ? 'canceled' : `failed: ${result.error}`}`);
      return;
    }
    const glb = await lstat(join(out, 'model.glb')).catch(() => null);
    const report = buildBlenderModelReport(facts.facts(), {
      modelId: id, buildId, quality, startedAt, finishedAt, srcHash, glbBytes: glb?.isFile() ? glb.size : null,
    });
    await atomicWrite(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await withBackupAssetPublication(() => store.mutateModel(id, (current) => ({
      ...replaceBuild(current, buildId, {
        status: 'complete', finishedAt, error: null, blenderVersion: report.blenderVersion,
        counts: report.counts, publishable: report.publishable, title: report.describe?.title ?? null,
      }),
      describe: report.describe,
    }), { includeDeleted: true }));
    registry.update(entry, { status: 'done', counts: report.counts });
    console.log(`🧊 Blender model ${id.slice(0, 15)} build ${buildId}: ${report.counts.error} error(s), ${report.counts.warning} warning(s)`);
  } catch (error) {
    console.error(`❌ Blender model ${id.slice(0, 15)} build ${buildId} failed: ${error.message}`);
    await log?.close();
    await store.mutateModel(id, (current) => replaceBuild(current, buildId, {
      status: 'failed', finishedAt: new Date().toISOString(), error: error.message,
    }), { includeDeleted: true }).catch((mutateError) => console.error(`❌ Blender model build ${buildId} could not be marked failed: ${mutateError.message}`));
    registry.update(entry, { status: 'error', error: error.message });
  }
  await pruneBlenderModelBuilds(id).catch((error) => console.error(`❌ Blender model ${id.slice(0, 15)} builds could not be pruned: ${error.message}`));
}

/**
 * Start a build of `id`'s src/model.py. Answers at once with `{ job, build }`;
 * the build runs in the background and announces each change.
 */
export async function startBlenderModelBuild(id, { quality = 'draft' } = {}) {
  assertBlenderModelId(id);
  if (starting.has(id) || activeBuild(id)) throw blenderRefusal('This model is already building. Cancel it or wait for it to finish.', 'BLENDER_MODEL_BUILD_RUNNING', 409);
  starting.add(id);
  try {
    const tool = await requireBlenderModelTool();
    const model = await store.getModel(id);
    if (!model) throw blenderRefusal('Blender model not found', 'NOT_FOUND', 404);
    if (!(await lstat(join(blenderModelSrcDir(id), 'model.py')).catch(() => null))?.isFile()) {
      throw blenderRefusal('This model has no src/model.py yet. Create the workspace from the starter, or write model.py.', 'BLENDER_MODEL_NO_SOURCE', 409);
    }
    const { tree: srcHash } = await hashSourceEntries(await walkSourceTree(blenderModelSrcDir(id)));
    const startedAt = new Date().toISOString();
    const buildId = newBlenderModelBuildId(new Date(startedAt));
    const build = { id: buildId, status: 'running', quality, srcHash, startedAt, finishedAt: null, blenderVersion: tool.version ?? null, counts: null, publishable: false, error: null };
    await store.mutateModel(id, (current) => ({ ...current, builds: [...(current.builds || []), build] }));
    const entry = registry.create(ownerOf(id), { kind: 'build', buildId, quality });
    inFlight.set(buildId, id);
    const done = runBuild({ id, buildId, quality, tool, entry, startedAt, srcHash })
      .catch((error) => console.error(`❌ Blender model build ${buildId} did not settle: ${error.message}`))
      .finally(() => {
        settling.delete(id);
        inFlight.delete(buildId);
      });
    settling.set(id, done);
    return { job: { ...entry.job }, build };
  } finally {
    starting.delete(id);
  }
}

/** Cancel a running build; false when it is not running. */
export function cancelBlenderModelBuild(id, buildId) {
  const entry = registry.active(ownerOf(id)).find(({ job }) => job.buildId === buildId);
  if (!entry) return false;
  entry.abort.abort();
  return true;
}

/** Cancel whatever `id` is building and wait for it to settle (a delete calls this first). */
export async function settleBlenderModelBuilds(id) {
  for (const entry of registry.active(ownerOf(id))) entry.abort.abort();
  await settling.get(id);
}

/** A build `startBlenderModelBuild` left running when PortOS stopped is failed on boot; nothing is restarted. */
export async function recoverInterruptedBlenderModelBuilds() {
  let recovered = 0;
  for (const id of await store.listBuildingModelIds()) {
    await store.mutateModel(id, (current) => {
      const running = (current.builds || []).filter((build) => build.status === 'running');
      if (!running.length) return { ...current };
      recovered += running.length;
      let next = current;
      for (const build of running) {
        next = replaceBuild(next, build.id, { status: 'failed', finishedAt: new Date().toISOString(), error: 'The build was interrupted by a server restart. Build again.' });
      }
      return next;
    });
  }
  return { recovered };
}

/** Test seam: forget every job and reservation. */
export function __resetBlenderModelBuildsForTests() {
  registry.reset();
  starting.clear();
  settling.clear();
  for (const buildId of [...inFlight.keys()]) inFlight.delete(buildId);
}
