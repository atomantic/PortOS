/**
 * Sprites — walk-animation workflow orchestration (issue #2897, phase 3).
 *
 * Per-direction lifecycle on top of the locked reference set (#2896):
 * generate ONE grok image_to_video walk clip per direction (user-triggered,
 * cloud lane), then the completion hook runs the fully deterministic Node
 * postprocess (walkPostprocess.js) into a candidate run. The user reviews,
 * optionally loop-trims, and approves per direction; when all 8 directions
 * are approved the finalized walk-set manifest freezes the set.
 *
 * Disk layout mirrors the source pipeline (and phase 1's importer contract):
 *   grok/walk-<direction>-<runId8>/animation-run.json + generated/…
 *   walk/<id>-walk-selection-v1.json, walk/<id>-walk-set-v1.json
 *   walk/trims/<slug>-vNNN-{strip.png,.gif,.json}
 *
 * Immutability: a finalized walk set 409s generation/approval/postprocess —
 * revisions require a new character version, matching the reference contract.
 */

import { join } from 'path';
import { copyFile, readdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  PATHS, ensureDir, atomicWrite, readJSONFile, pathExists, sha256File,
} from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';
import { getSettings } from '../settings.js';
import { updateRecord } from './records.js';
import { spriteDir, resolveSpriteAssetPath, toRecordRelativeAssetPath } from './paths.js';
import { requireCharacter, loadManifest } from './reference.js';
import { SPRITE_DIRECTIONS, anchorIdForDirection, buildWalkVideoPrompt } from './prompts.js';
import {
  prepareWalkAnchorInput, runWalkPostprocess, WALK_FPS, WALK_FRAME_COUNT, WALK_CELL_SIZE,
} from './walkPostprocess.js';
import { GROK_VIDEO_DURATIONS } from '../videoGen/grok.js';

const selectionRelPath = (id) => `walk/${id}-walk-selection-v1.json`;
// Exported: atlas.js (phase 4) reads the finalized walk set as compile input.
export const walkSetRelPath = (id) => `walk/${id}-walk-set-v1.json`;
const runRelPath = (runId) => `grok/${runId}`;
const RUN_RECORD_NAME = 'animation-run.json';

// Serialize walk-state read-modify-writes per record (run records, the
// selection file, the walk set, and trim versioning share one lifecycle) —
// same convention as reference.js's manifestWriteTail. Exported for
// walkTrims.js so its scan-then-write version claim can't race an attach or
// a concurrent trim.
const walkWriteTail = createKeyCachedQueue();

export const withWalkWriteTail = (recordId, fn) => walkWriteTail(recordId, fn);

async function loadWalkSet(recordId) {
  return readJSONFile(join(spriteDir(recordId), walkSetRelPath(recordId)), null);
}

async function loadSelection(recordId) {
  return readJSONFile(join(spriteDir(recordId), selectionRelPath(recordId)), null);
}

function seedSelection(recordId) {
  return {
    schemaVersion: 1,
    kind: 'reviewed-directional-walk-selection',
    characterId: recordId,
    status: 'in-progress',
    directions: {},
  };
}

async function loadRunRecord(recordId, runId) {
  return readJSONFile(join(spriteDir(recordId), runRelPath(runId), RUN_RECORD_NAME), null);
}

async function saveRunRecord(recordId, run) {
  const dir = join(spriteDir(recordId), runRelPath(run.id));
  await ensureDir(dir);
  await atomicWrite(join(dir, RUN_RECORD_NAME), run);
}

async function requireUnfinalized(recordId) {
  if (await loadWalkSet(recordId)) {
    throw new ServerError('Walk set is finalized — revisions require a new character version', { status: 409, code: 'WALK_SET_FINAL' });
  }
}

// PortOS stamps createdAt as an ISO string (Date.parse handles it); imported
// source-pipeline run records (issue #2895 importer) stamp it as a Python
// time.time() epoch-seconds float instead — .localeCompare on that throws
// and 500s the whole detail endpoint. Normalize both to comparable ms.
function runCreatedAtMs(createdAt) {
  if (typeof createdAt === 'number') return createdAt * 1000;
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? 0 : ms;
}

// PortOS's own postprocess stamps `stripPreview.stripPath` record-relative
// (walkPostprocess.js). The imported source pipeline stamps the same field
// as `stripPreview.path`, anchored at ITS repo root — the importer copies
// manifests byte-for-byte (hashes are pinned and verified against the
// source, so importer.js never rewrites them), so the mismatch is fixed up
// here, in memory, at read time instead. Never written back to disk.
function normalizeStripPreview(recordId, run) {
  if (!run?.stripPreview) return run;
  const raw = run.stripPreview.stripPath ?? run.stripPreview.path;
  const stripPath = toRecordRelativeAssetPath(recordId, raw);
  if (!stripPath) return run;
  return { ...run, stripPreview: { ...run.stripPreview, stripPath } };
}

// Strip candidates on an imported redraw manifest, in preference order. The
// clean straight-alpha derivative comes first so the preview matches native
// runs (which are always transparent); the keyed matte is the last resort
// because it renders with the chroma background baked in.
const REDRAW_STRIP_FIELDS = ['stripAlpha', 'stripAlphaOriginal', 'stripKeyed'];

/**
 * Synthesize a preview-only run object for a direction approved from an
 * imagegen **redraw** manifest (issue #2924) rather than a grok walk run.
 *
 * The source pipeline's video-first redraw path (e.g. pioneer's east, packaged
 * as `imagegen/vN/…-manifest.json` with a 12-frame cycle) predates PortOS's own
 * grok-direct walk workflow, so the selection's `runPath` points at an
 * `imagegen/` directory with no matching `grok/` run record — `getWalkState`
 * surfaced nothing and the direction rendered its "approved" badge with no
 * loop preview. Rather than model a second full run-record type, read the
 * redraw manifest's `cycle` block and shape the minimum the UI needs. Returns
 * null when the manifest isn't a redraw cycle or its strip is missing on disk,
 * so a genuinely absent run stays absent instead of rendering a broken image.
 */
async function loadRedrawRun(recordId, direction, entry) {
  const manifestRel = toRecordRelativeAssetPath(recordId, entry.runManifest);
  if (!manifestRel) return null;
  const manifest = await readJSONFile(join(spriteDir(recordId), manifestRel), null);
  const cycle = manifest?.cycle;
  const frameCount = Number(cycle?.frameCount);
  if (!Number.isInteger(frameCount) || frameCount < 2) return null;

  let stripPath = null;
  for (const field of REDRAW_STRIP_FIELDS) {
    const rel = toRecordRelativeAssetPath(recordId, cycle[field]);
    // eslint-disable-next-line no-await-in-loop -- ordered preference: stop at the first strip that exists
    if (rel && await pathExists(join(spriteDir(recordId), rel))) {
      stripPath = rel;
      break;
    }
  }
  if (!stripPath) return null;

  const cellSize = Number(manifest.cellSize) > 0 ? Number(manifest.cellSize) : WALK_CELL_SIZE;
  const fps = Number(cycle.referenceFps) > 0 ? Number(cycle.referenceFps) : WALK_FPS;
  return {
    schemaVersion: 1,
    kind: 'imported-redraw-walk-cycle',
    status: 'approved',
    id: entry.runId,
    characterId: recordId,
    direction,
    createdAt: entry.approvedAt,
    postprocessManifest: manifestRel,
    stripPreview: {
      stripPath,
      frameCount,
      fps,
      cellWidth: cellSize,
      cellHeight: cellSize,
      row: 0,
      startColumn: 0,
    },
  };
}

/**
 * Walk-workflow view for the detail endpoint: every animation run (newest
 * first), the per-direction selection, and the finalized set when present.
 */
export async function getWalkState(recordId) {
  const grokDir = join(spriteDir(recordId), 'grok');
  let entries = [];
  try {
    entries = await readdir(grokDir, { withFileTypes: true });
  } catch {
    // no runs yet
  }
  const [runs, selection, walkSet] = await Promise.all([
    Promise.all(
      entries
        .filter((e) => e.isDirectory() && e.name.startsWith('walk-'))
        .map((e) => loadRunRecord(recordId, e.name)),
    ).then((loaded) => loaded
      .filter(Boolean)
      .map((run) => normalizeStripPreview(recordId, run))),
    loadSelection(recordId),
    loadWalkSet(recordId),
  ]);

  // Directions approved from an imported redraw manifest have no grok run
  // record to scan — synthesize their preview from the manifest (#2924).
  const approvedDirections = walkSet?.directions || selection?.directions || {};
  const scannedRunIds = new Set(runs.map((run) => run.id));
  const redrawRuns = (await Promise.all(
    Object.entries(approvedDirections)
      .filter(([, entry]) => entry?.runId && entry?.runManifest && !scannedRunIds.has(entry.runId))
      .map(([direction, entry]) => loadRedrawRun(recordId, direction, entry)),
  )).filter(Boolean);

  const allRuns = [...runs, ...redrawRuns]
    .sort((a, b) => runCreatedAtMs(b.createdAt) - runCreatedAtMs(a.createdAt));
  return { runs: allRuns, selection, walkSet };
}

/**
 * Queue one grok walk video for a direction whose anchor is locked.
 * User-triggered only (route-invoked); exactly one image_to_video call per
 * run — all derivatives are deterministic local work.
 */
export function startWalkGeneration(recordId, body) {
  return walkWriteTail(recordId, () => startWalkGenerationImpl(recordId, body));
}

async function startWalkGenerationImpl(recordId, body) {
  const record = await requireCharacter(recordId);
  await requireUnfinalized(recordId);
  const direction = body.direction;
  const manifest = await loadManifest(recordId);
  const anchor = manifest?.anchors?.find((a) => a.direction === direction);
  if (!anchor || anchor.status !== 'locked' || !anchor.path) {
    throw new ServerError(`Lock the ${anchorIdForDirection(direction)} anchor before animating it`, { status: 409, code: 'ANCHOR_NOT_LOCKED' });
  }
  const chromaKey = manifest.chromaKey;
  if (!chromaKey) {
    throw new ServerError('Reference set has no frozen chroma key', { status: 409, code: 'MAIN_NOT_LOCKED' });
  }
  const anchorAbs = resolveSpriteAssetPath(recordId, anchor.path);
  if (!await pathExists(anchorAbs)) {
    throw new ServerError('Locked anchor file is missing on disk', { status: 500, code: 'ANCHOR_MISSING' });
  }

  const runId = `walk-${direction}-${randomUUID().slice(0, 8)}`;
  const runRel = runRelPath(runId);
  const runAbs = join(spriteDir(recordId), runRel);
  const generatedAbs = join(runAbs, 'generated');
  await ensureDir(generatedAbs);

  // Transparent i2v motion input derived from the locked anchor without
  // mutating it (measured-key alpha recovery + despill).
  const inputAbs = join(generatedAbs, 'input-anchor-transparent.png');
  const { preparation, sha256: inputSha256 } = await prepareWalkAnchorInput(anchorAbs, inputAbs, chromaKey);

  const settings = await getSettings();
  const duration = GROK_VIDEO_DURATIONS.includes(Number(body.duration)) ? Number(body.duration) : GROK_VIDEO_DURATIONS[0];
  const prompt = buildWalkVideoPrompt({ name: record.name, direction, chromaKey });

  // Run record BEFORE enqueue: a crash between the two leaves an inert
  // 'queued' run (harmless, regenerable) rather than a completed job the
  // hook can't file.
  const now = new Date().toISOString();
  const run = {
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    status: 'queued',
    id: runId,
    jobId: null,
    characterId: recordId,
    direction,
    chromaKey,
    anchorPath: anchor.path,
    anchorSha256: anchor.sha256 || await sha256File(anchorAbs),
    animationInputPath: `${runRel}/generated/input-anchor-transparent.png`,
    animationInputSha256: inputSha256,
    animationInputPreparation: preparation,
    createdAt: now,
  };
  await saveRunRecord(recordId, run);

  const { jobId } = enqueueJob({
    kind: 'video',
    params: {
      mode: IMAGE_GEN_MODE.GROK,
      videoMode: 'image',
      grokPath: settings.imageGen?.grok?.grokPath,
      prompt,
      sourceImagePath: inputAbs,
      duration,
      // Destination tag the completion hook files the video by.
      spriteWalk: { recordId, direction, runId, chromaKey },
    },
    owner: 'sprites',
  });
  run.jobId = jobId;
  await saveRunRecord(recordId, run);
  console.log(`🚶 sprite walk video queued ${recordId}/${runId} jobId=${jobId.slice(0, 8)}`);
  return { jobId, runId, direction, duration };
}

/**
 * Run the deterministic postprocess for a run and apply the outcome to the
 * run record (candidate on success, captured error otherwise) — shared by
 * the completion-hook attach and the manual rerun so the two can't drift.
 * The caller persists the mutated record.
 */
async function packageRun(recordId, run) {
  const runRel = runRelPath(run.id);
  const runAbs = join(spriteDir(recordId), runRel);
  try {
    const manifest = await loadManifest(recordId);
    const anchor = manifest?.anchors?.find((a) => a.direction === run.direction);
    if (!anchor?.path) throw new Error(`No locked ${run.direction} anchor in the reference manifest`);
    const result = await runWalkPostprocess({
      recordId,
      direction: run.direction,
      chromaKey: run.chromaKey || manifest.chromaKey,
      runAbs,
      runRel,
      anchorRel: anchor.path,
      anchorAbs: resolveSpriteAssetPath(recordId, anchor.path),
      videoAbs: join(runAbs, 'generated', 'source-video.mp4'),
    });
    run.status = 'candidate';
    run.postprocessManifest = result.manifestPath;
    run.stripPreview = result.stripPreview;
    delete run.postprocessError;
  } catch (err) {
    // May run outside the request lifecycle (hook) — capture, don't crash.
    run.status = 'error';
    run.postprocessError = err.message;
    console.error(`❌ sprite walk postprocess failed ${recordId}/${run.id}: ${err.message}`);
  }
  run.completedAt = new Date().toISOString();
}

/**
 * Completion-hook attach: copy the finished grok video into the run root and
 * run the deterministic postprocess. Errors are captured onto the run record
 * (status 'error') so the UI can surface them — the hook context has no
 * request to bubble to.
 */
export function attachWalkVideo(ctx) {
  return walkWriteTail(ctx.recordId, () => attachWalkVideoImpl(ctx));
}

async function attachWalkVideoImpl({ recordId, runId, filename, jobId }) {
  const run = await loadRunRecord(recordId, runId);
  if (!run) {
    console.error(`❌ sprite walk run record missing for ${recordId}/${runId} — skipping attach`);
    return null;
  }
  // Immutability guard, mirroring the rerun path: a Render Queue retry of a
  // terminal job re-carries the spriteWalk tag, so a clip can land AFTER the
  // run was approved (or the set finalized) — attaching would silently
  // replace frozen evidence and break the selection's recorded sha256s.
  if (await loadWalkSet(recordId)) {
    console.error(`❌ sprite walk attach skipped for ${recordId}/${runId} — walk set is finalized`);
    return null;
  }
  const selection = await loadSelection(recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) {
    console.error(`❌ sprite walk attach skipped for ${recordId}/${runId} — run is approved (immutable)`);
    return null;
  }
  const src = join(PATHS.videos, filename);
  if (!await pathExists(src)) {
    console.error(`❌ sprite walk video missing for ${recordId}/${runId} (${filename}) — skipping attach`);
    return null;
  }
  const runAbs = join(spriteDir(recordId), runRelPath(runId));
  const videoAbs = join(runAbs, 'generated', 'source-video.mp4');
  await ensureDir(join(runAbs, 'generated'));
  await copyFile(src, videoAbs);
  run.jobId = run.jobId || jobId || null;
  run.sourceVideoSha256 = await sha256File(videoAbs);
  run.status = 'postprocessing';
  await saveRunRecord(recordId, run);

  await packageRun(recordId, run);
  await saveRunRecord(recordId, run);
  return { runId, status: run.status };
}

/**
 * Re-run the deterministic postprocess for a run whose source video already
 * landed (crash recovery, or determinism verification). Approved/finalized
 * runs are immutable.
 */
export function rerunWalkPostprocess(recordId, { runId }) {
  return walkWriteTail(recordId, () => rerunWalkPostprocessImpl(recordId, runId));
}

async function rerunWalkPostprocessImpl(recordId, runId) {
  await requireCharacter(recordId);
  await requireUnfinalized(recordId);
  const run = await loadRunRecord(recordId, runId);
  if (!run) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  const selection = await loadSelection(recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) {
    throw new ServerError('Run is approved — approved runs are immutable', { status: 409, code: 'RUN_APPROVED' });
  }
  const videoAbs = join(spriteDir(recordId), runRelPath(runId), 'generated', 'source-video.mp4');
  if (!await pathExists(videoAbs)) {
    throw new ServerError('Run has no source video yet', { status: 409, code: 'VIDEO_NOT_READY' });
  }
  await packageRun(recordId, run);
  await saveRunRecord(recordId, run);
  if (run.status === 'error') {
    throw new ServerError(`Postprocess failed: ${run.postprocessError}`, { status: 422, code: 'POSTPROCESS_FAILED' });
  }
  return run;
}

/**
 * Approve one direction's candidate run. When all 8 directions are approved
 * the finalized walk-set manifest is written and the record advances to
 * walk-complete — after which the set is immutable.
 */
export function approveWalkDirection(recordId, args) {
  return walkWriteTail(recordId, () => approveWalkDirectionImpl(recordId, args));
}

async function approveWalkDirectionImpl(recordId, { direction, runId }) {
  await requireCharacter(recordId);
  await requireUnfinalized(recordId);
  const run = await loadRunRecord(recordId, runId);
  if (!run) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  if (run.direction !== direction) {
    throw new ServerError(`Run ${runId} animates "${run.direction}", not "${direction}"`, { status: 400, code: 'RUN_DIRECTION_MISMATCH' });
  }
  if (run.status !== 'candidate' || !run.postprocessManifest) {
    throw new ServerError('Run has no packaged candidate to approve', { status: 409, code: 'RUN_NOT_CANDIDATE' });
  }
  // Tamper check: the packaged manifest and strip must still be on disk with
  // the packaged geometry before their approval is frozen into the selection.
  const manifestAbs = resolveSpriteAssetPath(recordId, run.postprocessManifest);
  const packaged = await readJSONFile(manifestAbs, null);
  if (!packaged || packaged.frameCount !== WALK_FRAME_COUNT || packaged.frameRate !== WALK_FPS
    || packaged.direction !== direction || packaged.characterId !== recordId) {
    throw new ServerError('Packaged run manifest is missing or inconsistent', { status: 409, code: 'RUN_MANIFEST_INVALID' });
  }
  const stripAbs = resolveSpriteAssetPath(recordId, packaged.stripPath);
  if (!await pathExists(stripAbs) || await sha256File(stripAbs) !== packaged.stripSha256) {
    throw new ServerError('Packed strip is missing or was modified after packaging', { status: 409, code: 'RUN_STRIP_INVALID' });
  }

  const selection = (await loadSelection(recordId)) || seedSelection(recordId);
  selection.directions[direction] = {
    status: 'approved',
    runId,
    runPath: runRelPath(runId),
    runManifest: run.postprocessManifest,
    runManifestSha256: await sha256File(manifestAbs),
    approvedAt: new Date().toISOString(),
  };
  const allApproved = SPRITE_DIRECTIONS.every((d) => selection.directions[d]?.status === 'approved');
  selection.status = allApproved ? 'complete' : 'in-progress';
  const selectionAbs = join(spriteDir(recordId), selectionRelPath(recordId));
  await ensureDir(join(spriteDir(recordId), 'walk'));
  await atomicWrite(selectionAbs, selection);

  if (allApproved) {
    const walkSet = {
      schemaVersion: 1,
      kind: 'finalized-eight-direction-walk-set',
      characterId: recordId,
      status: 'final',
      directionOrder: SPRITE_DIRECTIONS,
      selectionPath: selectionRelPath(recordId),
      selectionSha256: await sha256File(selectionAbs),
      directions: selection.directions,
      finalizedAt: new Date().toISOString(),
    };
    await atomicWrite(join(spriteDir(recordId), walkSetRelPath(recordId)), walkSet);
    // Walk-set before record: the walk-set file is the canonical "finalized"
    // signal (requireUnfinalized and the UI key off it), so a crash between
    // the two leaves only a cosmetic stale record status — the reverse order
    // would advertise walk-complete with no frozen set behind it.
    await updateRecord(recordId, { status: 'walk-complete' });
    console.log(`🏁 sprite walk set finalized for ${recordId}`);
  }
  console.log(`✅ sprite walk ${recordId}/${direction} approved from ${runId}`);
  return getWalkState(recordId);
}
