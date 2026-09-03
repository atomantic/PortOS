/**
 * Character rigging — retarget orchestration, and the motion proof.
 *
 * Phase 2 (`autoSkin.js`) publishes a rigged character only when its weights measured
 * up. This module is the next step: it applies a user-supplied animation clip to that
 * published rig and refuses to publish the result unless the exported file demonstrably
 * MOVES. "The exporter returned" is not evidence — a GLB with no animation, or with one
 * that holds a single pose, is exactly what a silently-failed retarget produces, and it
 * looks identical to a working one until somebody plays it.
 *
 * ## The two-pass worker, and why the mapping is not in Python
 *
 * The skeleton compatibility contract lives in `skeletonMapping.js` (`reduceBoneMapping`,
 * shipped by #5892) and is deliberately ALL-OR-NOTHING: every animated source bone must
 * be understood and present on the target, or the retarget is refused. Enforcing that
 * inside the Blender worker would mean a second copy of the bone tables in Python, free
 * to drift from the one the rest of the app uses. So the worker runs twice:
 *
 *  1. **`probe`** — read-only. Opens the clip and the rigged GLB, reports the animated
 *     bone names, the clip roster, the target bone names, and the mesh's vertex count.
 *     Exports nothing.
 *  2. **`apply`** — receives the EXPLICIT source→target bone mapping this module derived
 *     from the probe, does the head-zone cleanup, retargets, exports, and re-imports.
 *
 * The cost is one extra Blender startup. What it buys is that "unsupported or partial
 * skeleton" fails before an exporter is ever opened, rather than after a partial
 * retarget has already been written somewhere.
 *
 * ## Publication
 *
 * Identical to Phase 2 and reusing its helpers: GLB first, report last, no-replace
 * moves, and a read-back through the same reader every consumer uses. The report is the
 * Phase 2 report EXTENDED (`retargetReport.js`), not a second format. The source rig is
 * opened read-only and never rewritten — a retarget is a new `retarget/<retargetId>/`
 * directory, so re-running one never mutates a published pair.
 *
 * Child-process boundary outside the request lifecycle, so the worker's outcomes flow
 * through a resolved promise and a thrown `ServerError` here — never a throw from inside
 * a spawn callback (AGENTS.md).
 */

import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ServerError } from '../../lib/errorHandler.js';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../../lib/fileUtils.js';
import {
  publishRigArtifacts,
  readRiggedArtifact,
  rigRunPaths,
  RIG_REPORT_NAME,
  RIG_STAGING_DIR_NAME,
} from './autoSkin.js';
import { resolveClipSource } from './clipLibrary.js';
import { requireRiggingInterpreter } from './readiness.js';
import {
  DEFAULT_RETARGET_MODE,
  describeRetargetFailure,
  reduceRetargetGate,
  resolveRetargetThresholds,
  RETARGET_REPORT_KIND,
  summarizeRetarget,
  thresholdsForRetargetWorker,
} from './retargetReport.js';
import { reduceBoneMapping, SKELETON_BONE_MAPPINGS } from './skeletonMapping.js';
import { runRiggingWorker } from './workerProcess.js';
import { getModel, mutateModel } from '../imageTo3d/db.js';

/** Per-record directory holding every retarget run's published pair. */
export const RETARGET_DIR_NAME = 'retarget';
export const RETARGETED_GLB_NAME = 'character.animated.glb';

const WORKER_SCRIPT = fileURLToPath(new URL('./retargetWorker.py', import.meta.url));

/**
 * The joints the head-zone cleanup is allowed to re-bind TO. Everything above the neck
 * belongs to the head/neck chain; the cleanup never invents a third destination.
 */
const HEAD_ZONE_JOINTS = Object.freeze(['neck', 'head']);

/**
 * Every path one retarget run touches, derived from the record id and the run id alone —
 * pure, so the publication tests can point it at a real temp dir.
 *
 * @param {{recordDir: string, retargetId: string}} opts
 */
export function retargetRunPaths({ recordDir, retargetId }) {
  const retargetRoot = join(recordDir, RETARGET_DIR_NAME);
  const publishDir = join(retargetRoot, retargetId);
  const stageDir = join(retargetRoot, RIG_STAGING_DIR_NAME, retargetId);
  return {
    retargetRoot,
    publishDir,
    stageDir,
    stagedGlb: join(stageDir, RETARGETED_GLB_NAME),
    stagedReport: join(stageDir, RIG_REPORT_NAME),
    probeJobFile: join(stageDir, 'probe-job.json'),
    probeReport: join(stageDir, 'probe-report.json'),
    jobFile: join(stageDir, 'job.json'),
    workerReport: join(stageDir, 'worker-report.json'),
    publishedGlb: join(publishDir, RETARGETED_GLB_NAME),
    publishedReport: join(publishDir, RIG_REPORT_NAME),
  };
}

/** The served URL for a published retarget (static-mounted under `/data`). */
export const retargetedAssetUrl = (modelId, retargetId) => `/data/image-to-3d/${modelId}/${RETARGET_DIR_NAME}/${retargetId}/${RETARGETED_GLB_NAME}`;

const retargetError = (message, code, extra = {}) => new ServerError(message, { status: 422, code, ...extra });

/**
 * The bone names the head-zone cleanup treats as the zone, for the convention the rig
 * was actually built with. Names stay owned by `skeletonMapping.js` — the worker is
 * told which bones to look at, never asked to recognize them.
 */
const headZoneBones = (skeletonHint) => HEAD_ZONE_JOINTS
  .map((joint) => SKELETON_BONE_MAPPINGS[skeletonHint]?.[joint])
  .filter(Boolean);

/**
 * Pick the clip to apply out of the probe's roster.
 *
 * An explicit request wins; otherwise the first clip in the file is used, because a
 * single-clip GLB (what a clip library drop almost always is) should not require the
 * user to type its internal name. A requested clip the file does not contain is an
 * error, never a silent fall back to a different animation.
 *
 * @param {Array<{name: string}>} clips
 * @param {string|null} requested
 * @returns {{ok: true, clip: object}|{ok: false, available: string[]}}
 */
export function selectClip(clips, requested) {
  const roster = (Array.isArray(clips) ? clips : []).filter((clip) => typeof clip?.name === 'string' && clip.name);
  const available = roster.map((clip) => clip.name);
  if (!requested) return roster.length ? { ok: true, clip: roster[0] } : { ok: false, available };
  const match = roster.find((clip) => clip.name === requested);
  return match ? { ok: true, clip: match } : { ok: false, available };
}

/**
 * Run the probe pass and derive the strict bone mapping from it. Throws a named 422
 * rather than returning a partial mapping — a caller must not be able to proceed with
 * "most of" a skeleton.
 */
async function probeAndMap({ interpreter, paths, clipPath, rigGlb, skeletonHint, clipName, spawnImpl, timeoutMs }) {
  await atomicWrite(paths.probeJobFile, JSON.stringify({
    pass: 'probe',
    clip_glb: clipPath,
    rig_glb: rigGlb,
    report_path: paths.probeReport,
  }, null, 2));

  const { code, tail } = await runRiggingWorker({
    python: interpreter, script: WORKER_SCRIPT, jobFile: paths.probeJobFile, spawnImpl, timeoutMs,
  });
  const probe = await readJSONFile(paths.probeReport, null, { logError: false });
  if (code !== 0 || !probe) {
    throw retargetError(
      `The retarget worker could not read the clip and the rig (exit ${code}).${tail ? ` Last output: ${tail.slice(-400)}` : ''}`,
      'RIGGING_CLIP_UNREADABLE',
    );
  }

  const selected = selectClip(probe.clips, clipName);
  if (!selected.ok) {
    throw retargetError(
      clipName
        ? `That clip file has no animation named "${clipName}"${selected.available.length ? ` (it has: ${selected.available.join(', ')})` : ' — it has no animations at all'}.`
        : 'That clip file carries no animation to retarget.',
      'RIGGING_CLIP_NOT_FOUND',
      { context: { available: selected.available } },
    );
  }

  const mapping = reduceBoneMapping({
    sourceBones: probe.clip_bones,
    targetBones: probe.rig_bones,
    skeletonHint,
  });
  if (!mapping.ok) {
    // Refused BEFORE the apply pass exists — no exporter has been opened, so there is no
    // partial retarget anywhere on disk to clean up or to mistake for a finished one.
    throw retargetError(
      mapping.reason === 'unrecognized-skeleton'
        ? `This character is rigged to an unrecognized convention, so no clip bone could be matched.`
        : `The clip and this character do not share a complete skeleton: ${mapping.unmappedBones.length} `
          + `bone${mapping.unmappedBones.length === 1 ? '' : 's'} could not be matched `
          + `(${mapping.unmappedBones.slice(0, 5).join(', ')}${mapping.unmappedBones.length > 5 ? ', …' : ''}).`,
      'RIGGING_SKELETON_INCOMPATIBLE',
      { context: { reason: mapping.reason, unmappedBones: mapping.unmappedBones } },
    );
  }
  return { mapping, clip: selected.clip };
}

/**
 * Retarget one clip onto one published rig: probe, map, stage, spawn, gate, publish.
 * Every path is injectable so the whole contract is exercisable against a real temp dir
 * and a fake worker.
 *
 * @param {{modelId: string, recordDir: string, rigId: string, clipPath: string,
 *          clipName?: string|null, skeletonHint?: string, mode?: string, overrides?: object,
 *          readiness?: object, python?: string|null, spawnImpl?: Function,
 *          retargetId?: string, timeoutMs?: number, verify?: Function}} opts
 * @returns {Promise<object>}
 */
export async function runRetarget({
  modelId,
  recordDir,
  rigId,
  clipPath,
  clipName = null,
  skeletonHint = 'mixamo',
  mode = DEFAULT_RETARGET_MODE,
  overrides = {},
  readiness,
  python,
  spawnImpl,
  retargetId = `retarget-${randomUUID()}`,
  timeoutMs,
  verify = readRiggedArtifact,
}) {
  const interpreter = await requireRiggingInterpreter({ readiness, python });

  // The source rig is read through the SAME reader every consumer uses. A half-published
  // or digest-mismatched pair is not a rig, and animating one would launder an
  // interrupted run into a finished-looking character.
  const source = await verify({ publishDir: rigRunPaths({ recordDir, rigId }).publishDir });
  if (!source.ok) {
    throw retargetError(`This character's rig is not readable (${source.reason}). Re-rig it before animating it.`,
      'RIGGING_NO_SOURCE_RIG', { context: { reason: source.reason } });
  }
  const clipExists = await stat(clipPath).then((info) => info.isFile(), () => false);
  if (!clipExists) throw retargetError('That animation clip is no longer in the clip library.', 'RIGGING_CLIP_NOT_FOUND');

  const thresholds = resolveRetargetThresholds(overrides);
  const paths = retargetRunPaths({ recordDir, retargetId });
  await ensureDir(paths.stageDir);
  try {
    const { mapping, clip } = await probeAndMap({
      interpreter, paths, clipPath, rigGlb: source.glbPath, skeletonHint, clipName, spawnImpl, timeoutMs,
    });

    await atomicWrite(paths.jobFile, JSON.stringify({
      pass: 'apply',
      clip_glb: clipPath,
      rig_glb: source.glbPath,
      output_glb: paths.stagedGlb,
      report_path: paths.workerReport,
      clip_name: clip.name,
      mode,
      skeleton_hint: mapping.skeletonHint,
      head_zone_bones: headZoneBones(mapping.skeletonHint),
      bone_mapping: mapping.mappings.map(({ sourceBone, targetBone }) => ({ source: sourceBone, target: targetBone })),
      thresholds: thresholdsForRetargetWorker(thresholds),
    }, null, 2));

    const { code, tail } = await runRiggingWorker({
      python: interpreter, script: WORKER_SCRIPT, jobFile: paths.jobFile, spawnImpl, timeoutMs,
    });
    const report = await readJSONFile(paths.workerReport, null, { logError: false });

    // A non-zero exit with a readable report is the EXPECTED gate failure: the worker
    // measured, refused, and said why. Prefer that measured answer over the exit code.
    const gate = report ? reduceRetargetGate(report, { thresholds, mode }) : null;
    if (gate && !gate.ok) {
      throw retargetError(describeRetargetFailure(gate.reason, gate.metrics), 'RIGGING_RETARGET_GATE_FAILED', {
        context: { reason: gate.reason, metrics: gate.metrics },
      });
    }
    if (code !== 0 || !report) {
      throw retargetError(
        `The retarget worker exited ${code} without a usable report.${tail ? ` Last output: ${tail.slice(-400)}` : ''}`,
        'RIGGING_WORKER_FAILED',
      );
    }
    const staged = await stat(paths.stagedGlb).then((info) => info.isFile(), () => false);
    if (!staged) throw retargetError('The retarget worker reported success but exported no file.', 'RIGGING_NO_OUTPUT');

    const published = await publishRigArtifacts({
      paths,
      report: { ...report, kind: RETARGET_REPORT_KIND, source_rig_id: rigId, source_clip: basename(clipPath) },
    });
    // Read the pair back through the same reader every consumer uses, before recording
    // the retarget as ready. A publish that does not verify is exactly the interrupted
    // state this contract exists to make detectable.
    const verified = await verify({ publishDir: paths.publishDir });
    if (!verified.ok) {
      throw retargetError(`The animation published but did not verify (${verified.reason}).`, 'RIGGING_PUBLISH_UNVERIFIED');
    }
    const summary = summarizeRetarget(gate.metrics);
    console.log(`🎞️ Retargeted ${modelId} as ${retargetId}: clip ${summary.clip}, ${summary.mappedBones} bones mapped, `
      + `${summary.changedCleanupVertices}/${summary.cleanupCapVertices} cleanup vertices in ${mode} mode`);
    return {
      retargetId,
      rigId,
      clip: summary.clip,
      mode,
      assetPath: retargetedAssetUrl(modelId, retargetId),
      reportPath: published.reportPath,
      sha256: published.sha256,
      bytes: published.bytes,
      summary,
      report,
    };
  } finally {
    // Scratch only — the published pair lives in a sibling directory, so a failed run
    // leaves nothing behind and a successful one leaves only what it published.
    await rm(paths.stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

// One retarget per record at a time. A double-click would otherwise put two Blender
// processes on the same rig — a re-entrancy guard, not a multi-actor lock
// (AGENTS.md single-user trust model).
const retargetsInFlight = new Set();

/**
 * Retarget a clip onto a stored image-to-3D record's published rig and persist the
 * result on it. The record's `retarget` field is the user-visible evidence: on success
 * the published pair plus the measured summary, on failure the reason and the sentence
 * naming the number that failed.
 *
 * @param {string} modelId
 * @param {{clip: string, clipName?: string, mode?: string, headCleanupFraction?: number}} options
 * @param {object} [deps] Injectable seams (`run`, `now`, `resolveClip`) for tests.
 * @returns {Promise<object>} The updated record.
 */
export async function retargetImageTo3dModel(modelId, options = {}, {
  run = runRetarget,
  now = () => new Date().toISOString(),
  resolveClip = resolveClipSource,
} = {}) {
  const model = await getModel(modelId);
  if (!model) throw new ServerError('Image-to-3D model not found', { status: 404, code: 'NOT_FOUND' });
  if (model.rig?.status !== 'ready' || !model.rig?.rigId) {
    throw retargetError('Rig this model before animating it.', 'RIGGING_NO_SOURCE_RIG');
  }
  const clipPath = resolveClip(options.clip);
  if (!clipPath) {
    throw retargetError('That animation clip is not in the clip library.', 'RIGGING_CLIP_NOT_FOUND');
  }
  if (retargetsInFlight.has(modelId)) {
    throw new ServerError('This model is already being animated.', { status: 409, code: 'RIGGING_IN_FLIGHT' });
  }

  const mode = options.mode || DEFAULT_RETARGET_MODE;
  retargetsInFlight.add(modelId);
  const startedAt = now();
  await mutateModel(modelId, (current) => ({
    ...current,
    retarget: { ...(current.retarget || {}), status: 'retargeting', startedAt, error: null, reason: null },
  }));
  try {
    const result = await run({
      modelId,
      recordDir: join(PATHS.imageTo3d, modelId),
      rigId: model.rig.rigId,
      clipPath,
      clipName: options.clipName || null,
      skeletonHint: model.rig.skeletonHint || 'mixamo',
      mode,
      overrides: options,
    });
    return await mutateModel(modelId, (current) => ({
      ...current,
      retarget: {
        status: 'ready',
        retargetId: result.retargetId,
        rigId: result.rigId,
        clipFile: basename(clipPath),
        clip: result.clip,
        mode,
        assetPath: result.assetPath,
        sha256: result.sha256,
        bytes: result.bytes,
        summary: result.summary,
        error: null,
        reason: null,
        startedAt,
        completedAt: now(),
      },
    }));
  } catch (error) {
    await mutateModel(modelId, (current) => ({
      ...current,
      retarget: {
        ...(current.retarget || {}),
        status: 'failed',
        clipFile: basename(clipPath),
        mode,
        error: String(error?.message || error).slice(0, 2_000),
        reason: error?.context?.reason || error?.code || null,
        metrics: error?.context?.metrics || null,
        startedAt,
        completedAt: now(),
      },
    })).catch(() => {});
    throw error;
  } finally {
    retargetsInFlight.delete(modelId);
  }
}
