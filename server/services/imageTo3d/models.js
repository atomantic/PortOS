/**
 * Image-to-3D model orchestration (issue #2952) — gallery-image lineage, target
 * dispatch, guarded local render, persistence, and GLB export.
 *
 * This is the record/create/generate layer that sits on top of the pluggable
 * target registry (`targets.js`) and the TRELLIS.2 runner (`trellis2.js`). It
 * mirrors the role `threejsModels/index.js` plays for procedural models, but the
 * inference is a LOCAL on-device render (no AI provider) landing a real `.glb`
 * mesh on disk rather than an LLM-authored scene spec.
 *
 * The render NEVER auto-runs: it is only reached from an explicit user create /
 * generate request, and it is gated on the target being installed + runnable on
 * this host (CLAUDE.md no-cold-bootstrap AI policy + the host's sensitivity to
 * sustained GPU load). Adding a second target is a registration in `TARGET_RUNNERS`,
 * not a rewrite here.
 */

import { randomUUID } from 'crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, resolveGalleryImage, ensureDir } from '../../lib/fileUtils.js';
import { slugifyForFilename } from '../../lib/civitai.js';
import { detectHostCapabilities, resolveTarget, DEFAULT_IMAGE_TO_3D_TARGET } from './targets.js';
import { isTrellis2Installed, runTrellis2Generate } from './trellis2.js';
import * as store from './db.js';

const MAX_RUNS = 30;
const activeOperations = new Set();
// operationId → the runner's SIGTERM handle for an in-flight render, so deleting a
// record mid-render can terminate its subprocess promptly. Populated when the render
// spawns (executeRender) and drained in its `finally`.
const activeRenders = new Map();

/**
 * Per-target install-probe + runner. One dispatch point so registering a new
 * image→3D backend is an entry here, not new branches through create/generate.
 * A runner takes `{ imagePath, outputPath, onProgress }` and returns a
 * `{ promise, kill }` pair — `promise` resolves `{ assetPath }`; `kill` SIGTERMs the
 * render so a mid-flight delete can terminate it (see `runTrellis2Generate`).
 */
const TARGET_RUNNERS = {
  trellis2: { isInstalled: isTrellis2Installed, run: runTrellis2Generate },
};

const trimRuns = (runs) => runs.slice(-MAX_RUNS);
const cleanError = (error) => String(error?.message || error || 'Render failed').slice(0, 2_000);

/** The served URL for a record's exported GLB (static-mounted under /data). */
const assetUrl = (id) => `/data/image-to-3d/${id}/model.glb`;
/** The on-disk destination the runner writes the GLB to. */
const assetDiskPath = (id) => join(PATHS.imageTo3d, id, 'model.glb');

/**
 * Remove a record's render directory (the exported GLB + its folder). Used to
 * clean the orphaned mesh a killed/deleted render may have left on disk. `force`
 * makes an absent path a no-op ("if written"), so this is safe to call whether or
 * not the render got far enough to emit a file.
 */
async function cleanupRenderDir(id) {
  await rm(join(PATHS.imageTo3d, id), { recursive: true, force: true })
    .catch((err) => console.error(`❌ Image-to-3D cleanup failed for ${id}: ${err.message}`));
}

/**
 * Verify a target can actually run on this host right now — unknown target →
 * 400, hardware-unsupported → 409 (reason surfaced), not-installed → 409 so the
 * UI can open the install flow. Returns the resolved runner entry. Pure w.r.t.
 * the DB; `caps` is injected so the check is deterministic.
 */
function assertTargetReady(targetId, caps) {
  const { target, available, reason } = resolveTarget(targetId, caps);
  if (!target) {
    throw new ServerError(`Unknown image-to-3D target: ${targetId}`, { status: 400, code: 'UNKNOWN_TARGET' });
  }
  if (!available) {
    throw new ServerError(
      `This host cannot run ${target.label} (${reason}).`,
      { status: 409, code: 'TARGET_UNAVAILABLE', context: { reason } },
    );
  }
  const runner = TARGET_RUNNERS[targetId];
  if (!runner) {
    throw new ServerError(`Target ${target.label} has no runner wired`, { status: 501, code: 'TARGET_NO_RUNNER' });
  }
  if (!runner.isInstalled()) {
    throw new ServerError(
      `${target.label} is not installed. Install it before generating.`,
      { status: 409, code: 'TARGET_NOT_INSTALLED' },
    );
  }
  return runner;
}

function updateRun(runs, operationId, patch) {
  return trimRuns((Array.isArray(runs) ? runs : []).map((run) => (
    run.operationId === operationId ? { ...run, ...patch } : run
  )));
}

async function failGeneration(id, operationId, error) {
  const message = cleanError(error);
  // includeDeleted so a record the user deleted mid-render resolves (rather than
  // throwing NOT_FOUND → a spurious "failure could not be persisted" log); the
  // `deleted` guard then no-ops the write — the delete already recorded the intent.
  await store.mutateModel(id, (current) => {
    if (current.deleted || current.generationOperationId !== operationId) return null;
    return {
      ...current,
      status: 'failed',
      error: message,
      generationOperationId: null,
      runs: updateRun(current.runs, operationId, {
        status: 'failed',
        error: message,
        completedAt: new Date().toISOString(),
      }),
    };
  }, { includeDeleted: true }).catch((persistError) => {
    console.error(`❌ Image-to-3D model ${id} failure could not be persisted: ${persistError.message}`);
  });
}

async function executeRender({ id, operationId, runner, sourcePath }) {
  const outputPath = assetDiskPath(id);
  let lastPersistedPercent = -1;
  try {
    await ensureDir(join(PATHS.imageTo3d, id));
    // The runner returns a { promise, kill } pair (see runTrellis2Generate) — retain
    // the kill handle so deleteModel can SIGTERM this render if the record is deleted
    // mid-flight.
    const { promise, kill } = runner.run({
      imagePath: sourcePath,
      outputPath,
      onProgress: (frame) => {
        // Sparse, low-frequency render progress — persist only when the whole
        // percent actually advances so a chatty parser can't hot-write the row.
        const percent = Number.isFinite(frame?.percent) ? Math.round(frame.percent) : null;
        if (percent === null || percent <= lastPersistedPercent) return;
        lastPersistedPercent = percent;
        void store.mutateModel(id, (current) => {
          if (current.generationOperationId !== operationId) return null;
          return { ...current, runs: updateRun(current.runs, operationId, { percent }) };
        }).catch(() => {}); // progress is best-effort; a lost frame is not fatal
      },
    });
    activeRenders.set(operationId, kill);
    // Close the pre-registration window: if the record was deleted between
    // beginRender flipping it to `generating` and this point (deleteModel's kill
    // lookup found no handle yet and took its dir-cleanup branch), terminate the
    // render we just spawned so it doesn't run to completion on a deleted record.
    const preDeleted = await store.getModel(id, { includeDeleted: true }).catch(() => null);
    if (preDeleted?.deleted) kill();
    await promise;

    const completedAt = new Date().toISOString();
    // includeDeleted + `deleted` guard: if the user deleted the record while the
    // render ran, complete quietly as a no-op (the GLB on disk is orphaned — full
    // kill-on-delete is tracked as a follow-up) instead of throwing NOT_FOUND.
    await store.mutateModel(id, (current) => {
      if (current.deleted || current.generationOperationId !== operationId) return null;
      return {
        ...current,
        status: 'ready',
        assetPath: assetUrl(id),
        error: null,
        generationOperationId: null,
        generatedAt: completedAt,
        runs: updateRun(current.runs, operationId, {
          status: 'completed',
          percent: 100,
          completedAt,
        }),
      };
    }, { includeDeleted: true });
    console.log(`🧊 Image-to-3D mesh ready: ${id}`);
  } catch (error) {
    console.error(`❌ Image-to-3D render failed for ${id}: ${cleanError(error)}`);
    await failGeneration(id, operationId, error);
  } finally {
    activeRenders.delete(operationId);
    activeOperations.delete(operationId);
    // If the record was deleted while the render ran, the completion/failure writes
    // no-op'd on the `deleted` guard and any GLB the render produced is orphaned —
    // remove it now that the child has fully settled (no further writes can race us).
    const record = await store.getModel(id, { includeDeleted: true }).catch(() => null);
    if (record?.deleted) await cleanupRenderDir(id);
  }
}

export const listModels = store.listModels;
export const getModel = store.getModel;

/**
 * Delete a record and, if a render is in flight, kill its subprocess so it stops
 * burning GPU the moment the user walks away. The soft-delete write itself stays a
 * clean no-op on the record. When a live render exists we SIGTERM it and let
 * executeRender's `finally` remove the orphaned GLB once the child settles (avoids a
 * delete-then-rewrite race). With no live render — a stale `generating` row that
 * survived a restart, OR a render still in the pre-registration window (spawned
 * momentarily later) — we clean any orphaned mesh directly; in the latter case
 * executeRender's own post-registration `deleted` re-check terminates the child.
 */
export async function deleteModel(id) {
  const current = await store.getModel(id, { includeDeleted: true });
  const result = await store.deleteModel(id);
  if (current?.status === 'generating' && current.generationOperationId) {
    const kill = activeRenders.get(current.generationOperationId);
    if (kill) {
      kill();
    } else {
      await cleanupRenderDir(id);
    }
  }
  return result;
}

export async function createModel(input, { caps = detectHostCapabilities() } = {}) {
  const sourcePath = resolveGalleryImage(input.filename);
  if (!sourcePath) {
    throw new ServerError('Gallery image not found', { status: 400, code: 'GALLERY_IMAGE_NOT_FOUND' });
  }
  const targetId = input.target || DEFAULT_IMAGE_TO_3D_TARGET;
  // Validate the target is runnable BEFORE persisting a record so we never leave
  // a dangling draft when the host can't render / the model isn't installed.
  const runner = assertTargetReady(targetId, caps);
  const created = await store.createModel({ ...input, target: targetId });
  // Thread the already-validated runner + resolved source straight into the
  // render — createModel and startGeneration share `beginRender`, so the create
  // path does NOT re-resolve the gallery image, re-assert readiness, or re-fetch
  // the row it just wrote.
  return beginRender(created, runner, sourcePath);
}

export async function startGeneration(id, { caps = detectHostCapabilities() } = {}) {
  const current = await store.getModel(id);
  if (!current) throw new ServerError('Image-to-3D model not found', { status: 404, code: 'NOT_FOUND' });
  if (current.status === 'generating'
    || (current.generationOperationId && activeOperations.has(current.generationOperationId))) {
    throw new ServerError('This model is already generating', { status: 409, code: 'MODEL_BUSY' });
  }

  const runner = assertTargetReady(current.target, caps);
  const sourcePath = resolveGalleryImage(current.sourceImage?.filename);
  if (!sourcePath) {
    throw new ServerError('The source gallery image is no longer available', { status: 409, code: 'GALLERY_IMAGE_NOT_FOUND' });
  }
  return beginRender(current, runner, sourcePath);
}

/**
 * Flip a validated record to `generating`, append a run, and dispatch the async
 * render. The single write path shared by create + regenerate — callers do the
 * validation (target readiness, gallery-image resolution) and pass the resolved
 * runner + source through. The transactional `status==='generating'` guard here
 * is the authoritative race check (the callers' pre-check is just a fast 409).
 */
async function beginRender(record, runner, sourcePath) {
  const { id } = record;
  const operationId = randomUUID();
  const startedAt = new Date().toISOString();
  const next = await store.mutateModel(id, (fresh) => {
    if (fresh.status === 'generating') {
      throw new ServerError('This model is already generating', { status: 409, code: 'MODEL_BUSY' });
    }
    return {
      ...fresh,
      status: 'generating',
      error: null,
      generationOperationId: operationId,
      runs: trimRuns([
        ...(Array.isArray(fresh.runs) ? fresh.runs : []),
        {
          operationId,
          status: 'running',
          target: fresh.target,
          percent: 0,
          startedAt,
          completedAt: null,
          error: null,
        },
      ]),
    };
  });

  activeOperations.add(operationId);
  setImmediate(() => {
    void executeRender({ id, operationId, runner, sourcePath });
  });
  return next;
}

/**
 * Resolve a ready record's exported GLB for download — 404 when the record is
 * gone, 409 while it has no rendered mesh yet.
 */
export async function getModelAsset(id) {
  const model = await store.getModel(id);
  if (!model) throw new ServerError('Image-to-3D model not found', { status: 404, code: 'NOT_FOUND' });
  if (model.status !== 'ready' || !model.assetPath) {
    throw new ServerError('This model has no generated mesh yet', { status: 409, code: 'MODEL_NOT_READY' });
  }
  return { path: assetDiskPath(id), filename: `${slugifyForFilename(model.name)}.glb` };
}

export async function recoverInterruptedModels() {
  const result = await store.recoverInterruptedModels();
  if (result.recovered > 0) {
    console.log(`🧊 Recovered ${result.recovered} interrupted image-to-3D render(s)`);
  }
  return result;
}
