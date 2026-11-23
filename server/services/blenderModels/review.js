/**
 * Review renders of one build (issue #17877): the fixed views and every saved
 * orbit camera, each textured and clay, under flat light, from the build's saved
 * model.blend. They start after each completed build and on request, never at
 * boot, and only ever add to a build: a failed review leaves the build as it was.
 *
 * Output is regenerable, so it lives in renders/reviews/<buildId>/ (excluded
 * from backups) and its manifest, review.json, is the only record of it. A set
 * is rendered beside the last one and swapped in whole; its log is
 * renders/reviews/<buildId>.log.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../lib/fileCore.js';
import { assertInsideWithoutSymlinks, blenderRefusal } from '../blenderWorkspace/containment.js';
import { openBlenderJobLogFile } from '../blenderWorkspace/jobLog.js';
import { requireBlenderModelTool, runBlenderModelDriver } from './driver.js';
import { activeJobs, cancelJob, ownerOf, registry, trackJob } from './jobs.js';
import { BLENDER_MODEL_REVIEW_LOOKS, cameraViewId, reviewViews } from './reviewCameras.js';
import * as store from './store.js';
import {
  BLENDER_MODEL_BUILD_ID, assertBlenderModelBuildId, assertBlenderModelId, blenderModelBuildDir, blenderModelRendersDir, blenderModelWorkspaceDir,
} from './workspace.js';

const IMAGE_SIZE = 1024;
const SHEET_COLUMNS = 4;
const IMAGE_NAME = /^[a-z0-9-]{1,64}-(textured|clay)\.png$/;
const SHEET_NAME = /^sheet-(textured|clay)\.jpg$/;
// Reserved synchronously before a start awaits, so two requests cannot both start a review.
const starting = new Set();

const reviewsDir = (id) => join(blenderModelRendersDir(id), 'reviews');
const reviewDir = (id, buildId) => join(reviewsDir(id), assertBlenderModelBuildId(buildId));
const logName = (buildId) => `${assertBlenderModelBuildId(buildId)}.log`;

const readJson = async (path) => {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
};

/** A build's report.json, or null when it cannot be read. */
export const readBuildReport = (id, buildId) => readJson(join(blenderModelBuildDir(id, buildId), 'report.json'));

/** The newest build that completed, or null. */
export const newestCompleteBuild = (model) => [...(model.builds || [])].reverse().find((build) => build.status === 'complete') ?? null;

/** Saved cameras whose image is missing from `review` or was rendered before the camera last moved. */
const outdatedCameras = (review, cameras) => {
  const rendered = new Map(review.views.map((view) => [view.id, JSON.stringify(view)]));
  const wanted = new Map(reviewViews(review.sizeMeters, cameras).map((view) => [view.id, JSON.stringify(view)]));
  return cameras.filter((camera) => rendered.get(cameraViewId(camera)) !== wanted.get(cameraViewId(camera))).map((camera) => camera.id);
};

/** The reviews on this machine, newest build first, each saying whether a newer build has made it out of date. */
export async function presentBlenderModelReviews(model) {
  const newest = newestCompleteBuild(model);
  const complete = [...(model.builds || [])].reverse().filter((build) => build.status === 'complete');
  const reviews = await Promise.all(complete.map(async (build) => {
    const review = await readJson(join(reviewDir(model.id, build.id), 'review.json'));
    if (!review?.sizeMeters || !Array.isArray(review.views)) return null;
    return {
      buildId: build.id, renderedAt: review.renderedAt, sizeMeters: review.sizeMeters, views: review.views.map((view) => view.id), sheets: review.sheets ?? [],
      outOfDate: build.id !== newest.id, outdatedCameraIds: outdatedCameras(review, model.cameras ?? []),
    };
  }));
  return reviews.filter(Boolean);
}

/** One file of a build's review (an image, a sheet, review.json or review.log): `{ absolute, type }`, 404 otherwise. */
export async function resolveBlenderModelReviewFile(id, buildId, name) {
  assertBlenderModelId(id);
  const missing = () => blenderRefusal('That review file is not on this machine', 'NOT_FOUND', 404);
  if (!await store.getModel(id)) throw blenderRefusal('Blender model not found', 'NOT_FOUND', 404);
  const type = name === 'review.json' ? 'application/json; charset=utf-8' : name === 'review.log' ? 'text/plain; charset=utf-8'
    : IMAGE_NAME.test(name) ? 'image/png' : SHEET_NAME.test(name) ? 'image/jpeg' : null;
  if (!type) throw missing();
  const absolute = name === 'review.log' ? join(reviewsDir(id), logName(buildId)) : join(reviewDir(id, buildId), name);
  await assertInsideWithoutSymlinks(blenderModelWorkspaceDir(id), absolute);
  if (!(await lstat(absolute).catch(() => null))?.isFile()) throw missing();
  return { absolute, type };
}

// One contact sheet per look, in view order. ffmpeg is optional here: without it the single images still show.
async function tileSheets({ dir, views, signal, log }) {
  const sheets = [];
  const { encodeBlenderSheet } = await import('../film/encode.js');
  for (const look of BLENDER_MODEL_REVIEW_LOOKS) {
    const output = `sheet-${look}.jpg`;
    const listFile = join(dir, `sheet-${look}.txt`);
    try {
      await encodeBlenderSheet({ frames: views.map((view) => join(dir, `${view.id}-${look}.png`)), columns: SHEET_COLUMNS, listFile, output: join(dir, output), signal });
      sheets.push(output);
    } catch (error) {
      signal.throwIfAborted();
      log.write(`The ${look} contact sheet was not made: ${error.message}`);
    } finally {
      await rm(listFile, { force: true });
    }
  }
  return sheets;
}

// Swap the finished set in; a reader between the two steps sees a missing review, which only says "not rendered".
async function publishSet({ id, buildId, staged }) {
  await store.mutateModel(id, (current) => {
    if (!(current.builds || []).some((build) => build.id === buildId)) throw new Error('The build was removed while its review rendered');
    return null;
  });
  const dir = reviewDir(id, buildId);
  await assertInsideWithoutSymlinks(blenderModelWorkspaceDir(id), dir);
  await rm(dir, { recursive: true, force: true });
  await rename(staged, dir);
}

async function runReview({ id, buildId, tool, entry, sizeMeters, views }) {
  const { signal } = entry.abort;
  const staged = join(reviewsDir(id), `.staged-${randomUUID()}`);
  let log = null;
  try {
    await assertInsideWithoutSymlinks(blenderModelWorkspaceDir(id), staged);
    await mkdir(staged, { recursive: true });
    await rm(join(reviewsDir(id), logName(buildId)), { force: true });
    log = await openBlenderJobLogFile({ directory: reviewsDir(id), name: logName(buildId), label: `Blender model review ${buildId}` });
    registry.update(entry, { status: 'running' });
    let index = 0;
    let finished = false;
    const result = await runBlenderModelDriver({
      tool,
      job: { mode: 'review', blend: join(blenderModelBuildDir(id, buildId), 'model.blend'), out: staged, size: IMAGE_SIZE, views, looks: BLENDER_MODEL_REVIEW_LOOKS },
      signal,
      onEvent: (event) => {
        if (event.event === 'done') finished = true;
        if (event.event === 'view') registry.update(entry, { index: index += 1 });
      },
      onLog: log.write,
    });
    if (result.traceback) for (const line of result.traceback.split('\n')) log.write(line);
    if (!result.ok) {
      registry.update(entry, { status: result.canceled ? 'canceled' : 'error', error: result.canceled ? null : result.error });
      return;
    }
    if (!finished) throw new Error('Blender stopped before every view was rendered');
    const sheets = await tileSheets({ dir: staged, views, signal, log });
    const review = { schemaVersion: 1, modelId: id, buildId, renderedAt: new Date().toISOString(), imageSize: IMAGE_SIZE, sizeMeters, looks: BLENDER_MODEL_REVIEW_LOOKS, views, sheets };
    await atomicWrite(join(staged, 'review.json'), `${JSON.stringify(review, null, 2)}\n`);
    signal.throwIfAborted();
    await publishSet({ id, buildId, staged });
    registry.update(entry, { status: 'done' });
    console.log(`🧊 Blender model ${id.slice(0, 15)} build ${buildId}: ${views.length} review view(s)`);
  } catch (error) {
    const canceled = signal.aborted;
    if (!canceled) console.error(`❌ Blender model ${id.slice(0, 15)} review of ${buildId} failed: ${error.message}`);
    registry.update(entry, { status: canceled ? 'canceled' : 'error', error: canceled ? null : error.message });
  } finally {
    await log?.close();
    await rm(staged, { recursive: true, force: true }).catch((error) => console.error(`❌ Blender model review files could not be removed: ${error.message}`));
  }
}

/**
 * Render the review of a completed build. Answers at once with `{ job }`; the
 * renders run in the background and announce each change.
 */
export async function startBlenderModelReview(id, buildId, { signal = null } = {}) {
  assertBlenderModelId(id);
  assertBlenderModelBuildId(buildId);
  if (starting.has(id) || activeJobs(id, 'review').length) throw blenderRefusal('This model is already rendering a review. Cancel it or wait for it to finish.', 'BLENDER_MODEL_REVIEW_RUNNING', 409);
  starting.add(id);
  try {
    const tool = await requireBlenderModelTool();
    const model = await store.getModel(id);
    const build = model?.builds?.find((entry) => entry.id === buildId);
    if (!build) throw blenderRefusal('Build not found', 'NOT_FOUND', 404);
    const sizeMeters = build.status === 'complete' ? (await readBuildReport(id, buildId))?.describe?.sizeMeters : null;
    if (!sizeMeters) throw blenderRefusal('Only a completed build with a declared sizeMeters can be rendered for review.', 'BLENDER_MODEL_REVIEW_NOT_READY', 409);
    // The build that started this was canceled (a delete) while the checks above ran.
    if (signal?.aborted) return { job: null };
    const views = reviewViews(sizeMeters, model.cameras ?? []);
    const entry = registry.create(ownerOf(id), { kind: 'review', buildId, index: 0, total: views.length * BLENDER_MODEL_REVIEW_LOOKS.length });
    entry.done = trackJob(id, entry.job.id, runReview({ id, buildId, tool, entry, sizeMeters, views }));
    return { job: { ...entry.job } };
  } finally {
    starting.delete(id);
  }
}

export const cancelBlenderModelReview = (id, buildId) => cancelJob(id, 'review', buildId);

/** Remove the review folders, logs and leftovers of builds no longer named in `kept`. */
export async function pruneBlenderModelReviews(id, kept) {
  const rendering = activeJobs(id, 'review').length > 0 || starting.has(id);
  for (const name of await readdir(reviewsDir(id)).catch(() => [])) {
    const buildId = name.replace(/\.log$/, '');
    const leftover = BLENDER_MODEL_BUILD_ID.test(buildId) ? !kept.has(buildId) : !rendering && name.startsWith('.staged-');
    if (leftover) await rm(join(reviewsDir(id), name), { recursive: true, force: true });
  }
}
