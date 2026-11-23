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
 * A full build whose describe() asks for a texture bake continues after the
 * driver saves model.blend: bake.js bakes each set (a job of its own, a child of
 * the build's slot) and a last driver run exports the GLB from the baked
 * images. A draft build skips baking and its report says so.
 *
 * Backup admission: the driver writes the build's bytes in place while its row
 * says `running`, so only the commit that names the finished build takes the
 * lease. Pruning drops builds from the row before it removes their folders.
 */
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { atomicWrite } from '../../lib/fileCore.js';
import { blenderRefusal } from '../blenderWorkspace/containment.js';
import { openBlenderJobLogFile } from '../blenderWorkspace/jobLog.js';
import { walkSourceTree } from '../blenderWorkspace/sourceTree.js';
import { hashSourceEntries } from '../blenderWorkspace/treeHash.js';
import { planBlenderModelBake } from './bakePlan.js';
import { bakeBlenderModelSets, blenderModelBakeSetDir, exportableSets } from './bake.js';
import { requireBlenderModelTool, runBlenderModelDriver } from './driver.js';
import { activeJobs, cancelJob, ownerOf, registry, trackJob, __resetBlenderModelJobsForTests } from './jobs.js';
import { buildBlenderModelReport, collectBlenderModelFacts } from './report.js';
import { pruneBlenderModelReviews, startBlenderModelReview } from './review.js';
import * as store from './store.js';
import {
  BLENDER_MODEL_BUILD_ID, assertBlenderModelId, blenderModelBuildDir, blenderModelBuildsDir, blenderModelSrcDir, blenderModelWorkspaceDir, newBlenderModelBuildId,
} from './workspace.js';

const BUILDS_KEPT = 5;
// How long a build may look for parts passing through each other; poses past it are reported as unmeasured.
const SWEEP_SECONDS = Object.freeze({ draft: 120, full: 600 });

// Reserved synchronously before a start awaits, so two requests cannot both start a build.
const starting = new Set();

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
  // Read after the listing: a build's row entry is committed before its folder exists.
  const named = new Set(((await store.getModel(id, { includeDeleted: true }))?.builds || []).map((build) => build.id));
  for (const name of names) {
    if (!BLENDER_MODEL_BUILD_ID.test(name) || named.has(name)) continue;
    await rm(blenderModelBuildDir(id, name), { recursive: true, force: true });
  }
  await pruneBlenderModelReviews(id, named);
}

const replaceBuild = (model, buildId, change) => ({
  ...model,
  builds: (model.builds || []).map((build) => (build.id === buildId ? { ...build, ...change } : build)),
});

async function settleUnfinishedBuild({ id, buildId, entry, finishedAt, result, facts }) {
  await store.mutateModel(id, (current) => replaceBuild(current, buildId, {
    status: result.canceled ? 'canceled' : 'failed', finishedAt, error: result.error, blenderVersion: facts.start?.blender ?? null,
  }), { includeDeleted: true });
  registry.update(entry, { status: result.canceled ? 'canceled' : 'error', error: result.error });
  console.log(`🧊 Blender model ${id.slice(0, 15)} build ${buildId} ${result.canceled ? 'canceled' : `failed: ${result.error}`}`);
}

// What the Builds tab shows of a build's bake; null when describe() asked for none.
const bakeSummary = (bake) => (bake ? {
  size: bake.size, samples: bake.samples, skipped: bake.skipped,
  sets: bake.sets.length, reused: bake.sets.filter((set) => set.reused).length,
} : null);

async function settleCompletedBuild({ id, buildId, quality, entry, startedAt, finishedAt, srcHash, facts, bake }) {
  const out = blenderModelBuildDir(id, buildId);
  const glb = await lstat(join(out, 'model.glb')).catch(() => null);
  const report = buildBlenderModelReport(facts, {
    modelId: id, buildId, quality, startedAt, finishedAt, srcHash, glbBytes: glb?.isFile() ? glb.size : null, bake,
  });
  await atomicWrite(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await withBackupAssetPublication(() => store.mutateModel(id, (current) => ({
    ...replaceBuild(current, buildId, {
      status: 'complete', finishedAt, error: null, blenderVersion: report.blenderVersion,
      counts: report.counts, publishable: report.publishable, title: report.describe?.title ?? null, bake: bakeSummary(report.checks.bake),
    }),
    describe: report.describe,
  }), { includeDeleted: true }));
  registry.update(entry, { status: 'done', counts: report.counts });
  console.log(`🧊 Blender model ${id.slice(0, 15)} build ${buildId}: ${report.counts.error} error(s), ${report.counts.warning} warning(s)`);
}

// The build is done whatever happens here; a review that cannot start is requested again from Compare.
async function reviewCompletedBuild(id, buildId, signal) {
  // An older build's review still rendering gives way to this one.
  for (const entry of activeJobs(id, 'review')) {
    entry.abort.abort();
    await entry.done;
  }
  await startBlenderModelReview(id, buildId, { signal })
    .catch((error) => console.log(`🧊 Blender model ${id.slice(0, 15)} build ${buildId} was not rendered for review: ${error.message}`));
}

/**
 * The stages after a full build saved model.blend and left the GLB to them: bake each set of a valid plan, then
 * export from the baked images. Resolves `{ bake, failure }`; a failure is `{ canceled, error }` and ends the build.
 */
async function bakeAndExport({ id, buildId, tool, entry, log, collector, out }) {
  const { signal } = entry.abort;
  const facts = collector.facts();
  const plan = planBlenderModelBake(facts.described?.bake ?? null, facts.parts.map((part) => part.id));
  let sets = [];
  if (!plan.problems.length) {
    const model = await store.getModel(id, { includeDeleted: true });
    const outcome = await bakeBlenderModelSets({
      id, buildId, tool, signal, log, plan, builds: model?.builds ?? [], facts: new Map(facts.bakeSets.map((fact) => [fact.id, fact])),
    });
    if (outcome.canceled) return { failure: { canceled: true, error: outcome.byBake ? `The bake of set ${outcome.setId} was canceled` : 'Canceled' } };
    if (outcome.error) return { failure: { canceled: false, error: outcome.error } };
    ({ sets } = outcome);
  }
  const result = await runBlenderModelDriver({
    tool,
    job: {
      mode: 'bake-export', blend: join(out, 'model.blend'), glb: join(out, 'model.glb'), out,
      sets: exportableSets(sets).map((set) => ({ id: set.id, partIds: set.partIds, dir: blenderModelBakeSetDir(id, buildId, set.id) })),
    },
    signal,
    onEvent: (event) => collector.add(event),
    onLog: log.write,
  });
  if (result.traceback) for (const line of result.traceback.split('\n')) log.write(line);
  return { bake: { sets }, failure: result.ok ? null : { canceled: result.canceled, error: result.error } };
}

// Every outcome ends in a prune, so failed and canceled builds age out like completed ones.
async function runBuild({ id, buildId, quality, tool, entry, startedAt, srcHash }) {
  const out = blenderModelBuildDir(id, buildId);
  const collector = collectBlenderModelFacts();
  let log = null;
  try {
    await mkdir(out, { recursive: true });
    log = await openBlenderJobLogFile({ directory: out, name: 'build.log', label: `Blender model build ${buildId}` });
    registry.update(entry, { status: 'running' });
    const result = await runBlenderModelDriver({
      tool,
      job: { mode: 'build', workspace: blenderModelWorkspaceDir(id), src: blenderModelSrcDir(id), out, quality, sweepSeconds: SWEEP_SECONDS[quality] },
      signal: entry.abort.signal,
      onEvent: (event) => collector.add(event),
      onLog: log.write,
    });
    if (result.traceback) for (const line of result.traceback.split('\n')) log.write(line);
    let outcome = result;
    let bake = null;
    // The driver left the GLB to the bake stages (full quality, describe().bake).
    if (result.ok && collector.facts().saved?.deferred) {
      const stages = await bakeAndExport({ id, buildId, tool, entry, log, collector, out });
      bake = stages.bake ?? null;
      if (stages.failure) outcome = { ...stages.failure, ok: false };
    }
    await log.close();
    log = null;
    const finishedAt = new Date().toISOString();
    const facts = collector.facts();
    if (outcome.ok) {
      await settleCompletedBuild({ id, buildId, quality, entry, startedAt, finishedAt, srcHash, facts, bake });
      await reviewCompletedBuild(id, buildId, entry.abort.signal);
    }
    else await settleUnfinishedBuild({ id, buildId, entry, finishedAt, result: outcome, facts });
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
  if (starting.has(id) || activeJobs(id, 'build').length) throw blenderRefusal('This model is already building. Cancel it or wait for it to finish.', 'BLENDER_MODEL_BUILD_RUNNING', 409);
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
    trackJob(id, buildId, runBuild({ id, buildId, quality, tool, entry, startedAt, srcHash })
      .catch((error) => console.error(`❌ Blender model build ${buildId} did not settle: ${error.message}`)));
    return { job: { ...entry.job }, build };
  } finally {
    starting.delete(id);
  }
}

/** Cancel a running build; false when it is not running. */
export const cancelBlenderModelBuild = (id, buildId) => cancelJob(id, 'build', buildId);

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
  __resetBlenderModelJobsForTests();
  starting.clear();
}
