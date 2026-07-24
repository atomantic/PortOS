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
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, resolveGalleryImage, ensureDir } from '../../lib/fileUtils.js';
import { detectHostCapabilities, resolveTarget, DEFAULT_IMAGE_TO_3D_TARGET } from './targets.js';
import { isTrellis2Installed, runTrellis2Generate } from './trellis2.js';
import * as store from './db.js';

const MAX_RUNS = 30;
const activeOperations = new Set();

/**
 * Per-target install-probe + runner. One dispatch point so registering a new
 * image→3D backend is an entry here, not new branches through create/generate.
 * A runner takes `{ imagePath, outputPath, onProgress }` and resolves
 * `{ assetPath }` (see `runTrellis2Generate`).
 */
const TARGET_RUNNERS = {
  trellis2: { isInstalled: isTrellis2Installed, run: runTrellis2Generate },
};

const trimRuns = (runs) => runs.slice(-MAX_RUNS);
const cleanError = (error) => String(error?.message || error || 'Render failed').slice(0, 2_000);

const slugify = (name) => String(name || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The served URL for a record's exported GLB (static-mounted under /data). */
const assetUrl = (id) => `/data/image-to-3d/${id}/model.glb`;
/** The on-disk destination the runner writes the GLB to. */
const assetDiskPath = (id) => join(PATHS.imageTo3d, id, 'model.glb');

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
  await store.mutateModel(id, (current) => {
    if (current.generationOperationId !== operationId) return null;
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
  }).catch((persistError) => {
    console.error(`❌ Image-to-3D model ${id} failure could not be persisted: ${persistError.message}`);
  });
}

async function executeRender({ id, operationId, runner, sourcePath }) {
  const outputPath = assetDiskPath(id);
  let lastPersistedPercent = -1;
  try {
    await ensureDir(join(PATHS.imageTo3d, id));
    await runner.run({
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

    const completedAt = new Date().toISOString();
    await store.mutateModel(id, (current) => {
      if (current.generationOperationId !== operationId) return null;
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
    });
    console.log(`🧊 Image-to-3D mesh ready: ${id}`);
  } catch (error) {
    console.error(`❌ Image-to-3D render failed for ${id}: ${cleanError(error)}`);
    await failGeneration(id, operationId, error);
  } finally {
    activeOperations.delete(operationId);
  }
}

export const listModels = store.listModels;
export const getModel = store.getModel;
export const deleteModel = store.deleteModel;

export async function createModel(input, { caps = detectHostCapabilities() } = {}) {
  const sourcePath = resolveGalleryImage(input.filename);
  if (!sourcePath) {
    throw new ServerError('Gallery image not found', { status: 400, code: 'GALLERY_IMAGE_NOT_FOUND' });
  }
  const targetId = input.target || DEFAULT_IMAGE_TO_3D_TARGET;
  // Validate the target is runnable BEFORE persisting a record so we never leave
  // a dangling draft when the host can't render / the model isn't installed.
  assertTargetReady(targetId, caps);
  const created = await store.createModel({ ...input, target: targetId });
  return startGeneration(created.id, { caps });
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
  return { path: assetDiskPath(id), filename: `${slugify(model.name) || 'model'}.glb` };
}

export async function recoverInterruptedModels() {
  const result = await store.recoverInterruptedModels();
  if (result.recovered > 0) {
    console.log(`🧊 Recovered ${result.recovered} interrupted image-to-3D render(s)`);
  }
  return result;
}
