/**
 * Character rigging — auto-skin orchestration and the publication contract.
 *
 * Phase 1 (`runtime.js` / `readiness.js`) answers whether this host can run Blender at
 * all. This module is what actually rigs a generated mesh, and — more to the point —
 * what refuses to publish one that did not measure up. The gate itself is a pure
 * reducer in `autoSkinReport.js`; everything here is the plumbing around it.
 *
 * ## The publication contract
 *
 * A rig produces two files that are only meaningful as a PAIR: the GLB, and the JSON
 * report carrying the GLB's SHA-256. Both are written into a staging directory inside
 * the record's own render dir and then moved into place, and the ORDER and the MOVE
 * are both load-bearing:
 *
 *  - **GLB first, report last.** The report is the commit marker. A consumer treats
 *    the pair as usable only when the report exists AND its digest matches the GLB on
 *    disk, so a run interrupted between the two moves is *detectable* rather than
 *    silently loaded as a finished rig.
 *  - **No-replace moves.** `moveWithoutReplace` (`server/lib/noReplaceMove.js`) uses
 *    `link(2)`, which fails atomically on an existing destination. A name collision is
 *    an error, never an overwrite — and on a filesystem that cannot express that, the
 *    publish fails cleanly instead of degrading to a racy `rename`.
 *  - **Nothing published is mutated afterward.** Each run gets its own `rig/<rigId>/`
 *    directory, so a re-rig is a new directory rather than a rewrite of the last one.
 *    The single exception is the rollback below, which unlinks a GLB whose report never
 *    landed — that pair was never publishable in the first place.
 *  - **The source `model.glb` is never touched**, the same rule `sourceKeying.js`
 *    follows for the shared gallery file. The worker opens it read-only and exports to
 *    the staging dir.
 *
 * Child-process boundary outside the request lifecycle, so the worker's outcomes flow
 * through a resolved promise and a thrown `ServerError` at the orchestration layer —
 * never a throw from inside a spawn callback (AGENTS.md).
 */

import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ServerError } from '../../lib/errorHandler.js';
import { atomicWrite, ensureDir, PATHS, readJSONFile, sha256File } from '../../lib/fileUtils.js';
import { moveWithoutReplace } from '../../lib/noReplaceMove.js';
import {
  AUTO_SKIN_REPORT_VERSION,
  describeAutoSkinFailure,
  reduceAutoSkinGate,
  resolveAutoSkinThresholds,
  summarizeAutoSkin,
  thresholdsForWorker,
} from './autoSkinReport.js';
import { requireRiggingInterpreter } from './readiness.js';
import { buildHumanoidArmatureSpec } from './skeletonMapping.js';
import { runRiggingWorker } from './workerProcess.js';
import { getModel, mutateModel } from '../imageTo3d/db.js';

/** Per-record directory holding every rig run's published pair. */
export const RIG_DIR_NAME = 'rig';
/** Scratch root inside `rig/`. Excluded from backups — see `services/backup.js`. */
export const RIG_STAGING_DIR_NAME = '.staging';
export const RIGGED_GLB_NAME = 'character.rigged.glb';
export const RIG_REPORT_NAME = 'character.rig.json';

const WORKER_SCRIPT = fileURLToPath(new URL('./autoSkinWorker.py', import.meta.url));

/**
 * Every path one rig run touches, derived from the record id and the run id alone —
 * pure, so the publication tests can point it at a real temp dir.
 *
 * @param {{recordDir: string, rigId: string}} opts
 */
export function rigRunPaths({ recordDir, rigId }) {
  const rigRoot = join(recordDir, RIG_DIR_NAME);
  const publishDir = join(rigRoot, rigId);
  const stageDir = join(rigRoot, RIG_STAGING_DIR_NAME, rigId);
  return {
    rigRoot,
    publishDir,
    stageDir,
    inputGlb: join(recordDir, 'model.glb'),
    stagedGlb: join(stageDir, RIGGED_GLB_NAME),
    stagedReport: join(stageDir, RIG_REPORT_NAME),
    workerReport: join(stageDir, 'worker-report.json'),
    jobFile: join(stageDir, 'job.json'),
    publishedGlb: join(publishDir, RIGGED_GLB_NAME),
    publishedReport: join(publishDir, RIG_REPORT_NAME),
  };
}

/** The served URL for a published rig (static-mounted under `/data`). */
export const riggedAssetUrl = (modelId, rigId) => `/data/image-to-3d/${modelId}/${RIG_DIR_NAME}/${rigId}/${RIGGED_GLB_NAME}`;

/**
 * Publish the staged pair. GLB first, report last, neither replacing anything.
 *
 * The report is finalized HERE rather than by the worker, because the digest can only
 * be taken once the bytes the worker will actually publish are final — a worker-written
 * digest would describe a file the worker could still have rewritten.
 *
 * If the report move fails after the GLB landed, the GLB is unlinked: that pair was
 * never publishable, and leaving a half-pair behind would block the retry with a
 * permanent collision on a file no reader will ever accept.
 *
 * @param {{paths: object, report: object}} opts
 * @returns {Promise<{glbPath: string, reportPath: string, sha256: string, bytes: number}>}
 */
export async function publishRigArtifacts({ paths, report }) {
  const [sha256, info] = await Promise.all([sha256File(paths.stagedGlb), stat(paths.stagedGlb)]);
  await atomicWrite(paths.stagedReport, JSON.stringify({
    ...report,
    report_version: AUTO_SKIN_REPORT_VERSION,
    // Named from the path actually being published, not from a constant: the retarget
    // lane publishes a differently-named GLB through this same helper, and the reader
    // below resolves the artifact from this key rather than guessing a filename.
    output_file: basename(paths.publishedGlb),
    output_bytes: info.size,
    output_sha256: sha256,
  }, null, 2));

  await ensureDir(paths.publishDir);
  await moveWithoutReplace(paths.stagedGlb, paths.publishedGlb);
  await moveWithoutReplace(paths.stagedReport, paths.publishedReport).catch(async (error) => {
    await rm(paths.publishedGlb, { force: true }).catch(() => {});
    throw error;
  });
  return { glbPath: paths.publishedGlb, reportPath: paths.publishedReport, sha256, bytes: info.size };
}

/**
 * Read a published rig, refusing anything that is not a matched pair.
 *
 * This is the consumer half of the contract: a report without its GLB, a GLB without
 * its report, or a digest that disagrees are all `{ ok: false }` with a named reason —
 * never a partially-loaded rig. Callers must not fall back to "well, the GLB is there".
 *
 * @param {{publishDir: string}} opts
 * @returns {Promise<{ok: boolean, reason?: string, report?: object, glbPath?: string}>}
 */
export async function readRiggedArtifact({ publishDir }) {
  const report = await readJSONFile(join(publishDir, RIG_REPORT_NAME), null, { logError: false });
  if (!report || typeof report.output_sha256 !== 'string') return { ok: false, reason: 'missing-report' };
  // The report names its own artifact, so one reader serves both the auto-skin and the
  // retarget lane. `basename` because the report is a file on disk: a report carrying a
  // traversing `output_file` must resolve inside the publish dir or not at all.
  const glbPath = join(publishDir, basename(String(report.output_file || RIGGED_GLB_NAME)));
  const exists = await stat(glbPath).then((info) => info.isFile(), () => false);
  if (!exists) return { ok: false, reason: 'missing-glb' };
  const digest = await sha256File(glbPath);
  if (digest !== report.output_sha256) return { ok: false, reason: 'digest-mismatch' };
  return { ok: true, report, glbPath };
}

const rigError = (message, code, extra = {}) => new ServerError(message, { status: 422, code, ...extra });

/**
 * Rig one mesh: stage, spawn, gate, publish. Every path is injectable so the whole
 * contract is exercisable against a real temp dir and a fake worker.
 *
 * @param {{modelId: string, recordDir: string, skeletonHint?: string, overrides?: object,
 *          readiness?: object, python?: string|null, spawnImpl?: Function, rigId?: string,
 *          timeoutMs?: number, verify?: Function}} opts
 * @returns {Promise<{rigId: string, assetPath: string, reportPath: string, sha256: string,
 *   bytes: number, summary: object, report: object}>}
 */
export async function runAutoSkin({
  modelId,
  recordDir,
  skeletonHint = 'mixamo',
  overrides = {},
  readiness,
  python,
  spawnImpl,
  rigId = `rig-${randomUUID()}`,
  timeoutMs,
  verify = readRiggedArtifact,
}) {
  const interpreter = await requireRiggingInterpreter({ readiness, python });

  const thresholds = resolveAutoSkinThresholds(overrides);
  const paths = rigRunPaths({ recordDir, rigId });
  const sourceExists = await stat(paths.inputGlb).then((info) => info.isFile(), () => false);
  if (!sourceExists) throw rigError('This model has no rendered mesh to rig yet.', 'RIGGING_NO_SOURCE_MESH');

  await ensureDir(paths.stageDir);
  try {
    await atomicWrite(paths.jobFile, JSON.stringify({
      input_glb: paths.inputGlb,
      output_glb: paths.stagedGlb,
      report_path: paths.workerReport,
      thresholds: thresholdsForWorker(thresholds),
      armature: buildHumanoidArmatureSpec({ skeletonHint }),
    }, null, 2));

    const { code, tail } = await runRiggingWorker({
      python: interpreter, script: WORKER_SCRIPT, jobFile: paths.jobFile, spawnImpl, timeoutMs,
    });
    const report = await readJSONFile(paths.workerReport, null, { logError: false });

    // A non-zero exit with a readable report is the EXPECTED gate failure: the worker
    // measured, refused, and said why. Prefer that measured answer over the exit code.
    const gate = report ? reduceAutoSkinGate(report, thresholds) : null;
    if (gate && !gate.ok) {
      throw rigError(describeAutoSkinFailure(gate.reason, gate.metrics), 'RIGGING_GATE_FAILED', {
        context: { reason: gate.reason, metrics: gate.metrics },
      });
    }
    if (code !== 0 || !report) {
      throw rigError(
        `The rigging worker exited ${code} without a usable report.${tail ? ` Last output: ${tail.slice(-400)}` : ''}`,
        'RIGGING_WORKER_FAILED',
      );
    }
    const staged = await stat(paths.stagedGlb).then((info) => info.isFile(), () => false);
    if (!staged) throw rigError('The rigging worker reported success but exported no mesh.', 'RIGGING_NO_OUTPUT');

    const published = await publishRigArtifacts({ paths, report });
    // Read the pair back through the same reader every consumer uses, before recording
    // the rig as ready. A publish that does not verify is exactly the interrupted state
    // this contract exists to make detectable — it must not be reported as a finished
    // rig just because both moves returned.
    const verified = await verify({ publishDir: paths.publishDir });
    if (!verified.ok) {
      throw rigError(`The rig published but did not verify (${verified.reason}).`, 'RIGGING_PUBLISH_UNVERIFIED');
    }
    console.log(`🦴 Rigged ${modelId} as ${rigId}: ${gate.metrics.boneCount} bones, `
      + `${gate.metrics.verticesAfterWeld} vertices, ${gate.metrics.nearestBoneCompleted} filled by nearest bone`);
    return {
      rigId,
      assetPath: riggedAssetUrl(modelId, rigId),
      reportPath: published.reportPath,
      sha256: published.sha256,
      bytes: published.bytes,
      summary: summarizeAutoSkin(gate.metrics),
      report,
    };
  } finally {
    // Scratch only — the published pair lives in a sibling directory, so a failed run
    // leaves nothing behind and a successful one leaves only what it published.
    await rm(paths.stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

// One rig per record at a time. A double-click would otherwise put two Blender
// processes on the same mesh — a re-entrancy guard, not a multi-actor lock
// (AGENTS.md single-user trust model).
const rigsInFlight = new Set();

/**
 * Rig a stored image-to-3D record and persist the result on it. The record's `rig`
 * field is the user-visible evidence: on success the published pair plus the measured
 * summary, on failure the reason and the sentence naming the number that failed.
 *
 * @param {string} modelId
 * @param {{skeletonHint?: string, weldDistance?: number, unweightedCeiling?: number}} [options]
 * @param {object} [deps] Injectable seams (`run`, `now`) for tests.
 * @returns {Promise<object>} The updated record.
 */
export async function rigImageTo3dModel(modelId, options = {}, { run = runAutoSkin, now = () => new Date().toISOString() } = {}) {
  const model = await getModel(modelId);
  if (!model) throw new ServerError('Image-to-3D model not found', { status: 404, code: 'NOT_FOUND' });
  if (model.status !== 'ready' || !model.assetPath) {
    throw rigError('Render this model before rigging it.', 'RIGGING_NO_SOURCE_MESH');
  }
  if (rigsInFlight.has(modelId)) {
    throw new ServerError('This model is already being rigged.', { status: 409, code: 'RIGGING_IN_FLIGHT' });
  }

  rigsInFlight.add(modelId);
  const startedAt = now();
  await mutateModel(modelId, (current) => ({ ...current, rig: { ...(current.rig || {}), status: 'rigging', startedAt, error: null, reason: null } }));
  try {
    const result = await run({
      modelId,
      recordDir: join(PATHS.imageTo3d, modelId),
      skeletonHint: options.skeletonHint,
      overrides: options,
    });
    return await mutateModel(modelId, (current) => ({
      ...current,
      rig: {
        status: 'ready',
        rigId: result.rigId,
        assetPath: result.assetPath,
        sha256: result.sha256,
        bytes: result.bytes,
        summary: result.summary,
        skeletonHint: options.skeletonHint || 'mixamo',
        error: null,
        reason: null,
        startedAt,
        completedAt: now(),
      },
    }));
  } catch (error) {
    await mutateModel(modelId, (current) => ({
      ...current,
      rig: {
        ...(current.rig || {}),
        status: 'failed',
        error: String(error?.message || error).slice(0, 2_000),
        reason: error?.context?.reason || error?.code || null,
        metrics: error?.context?.metrics || null,
        startedAt,
        completedAt: now(),
      },
    })).catch(() => {});
    throw error;
  } finally {
    rigsInFlight.delete(modelId);
  }
}
