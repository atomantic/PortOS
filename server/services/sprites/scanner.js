/**
 * The first named, non-walk animation track: a short directional scanner action.
 *
 * The render is deliberately reachable only through `startScannerGeneration`.
 * Everything after Grok writes the requested MP4 is deterministic local packing,
 * review, approval, and atlas input; no boot path or read endpoint calls a
 * provider.
 */

import { join } from 'path';
import { readdir, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { atomicWrite, ensureDir, pathExists, readJSONFile, sha256File } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { executeTuiRun } from '../../lib/tuiPromptRunner.js';
import { GROK_TUI_ID } from '../../lib/grok.js';
import { getSettings } from '../settings.js';
import { getRecord } from './records.js';
import { requireTrack, loadManifest } from './reference.js';
import { SPRITE_DIRECTIONS, anchorIdForDirection, buildScannerPrompt } from './prompts.js';
import { SCANNER_TRACK, clampTrackFrameCount, clampTrackFps, getAnimationTrack } from './animationTracks.js';
import { spriteDir, resolveSpriteAssetPath, SOURCE_CLIP_NAME } from './paths.js';
import { prepareWalkAnchorChromaInput, runWalkPostprocess } from './walkPostprocess.js';
import { verifyPackagedFrames } from './walkFrames.js';
import { resolveChromaKey, withAnimationWriteTail } from './animationWorkflow.js';
import { resolveGrokDuration } from '../../lib/grokVideoClip.js';

const RUN_RECORD_NAME = 'animation-run.json';
const selectionRelPath = (id) => `scanner/${id}-scanner-selection-v1.json`;
export const scannerSetRelPath = (id) => `scanner/${id}-scanner-set-v1.json`;
const runRelPath = (runId) => `runs/${runId}`;
const TUI_IDLE_MS = 90_000;
const TUI_TIMEOUT_MS = 30 * 60_000;

const scannerSetFinalError = () => new ServerError(
  'Scanner set is finalized — reopen it before generating or approving another scanner action',
  { status: 409, code: 'SCANNER_SET_FINAL' },
);

async function loadSelection(recordId) {
  return readJSONFile(join(spriteDir(recordId), selectionRelPath(recordId)), null);
}

async function loadSet(recordId) {
  return readJSONFile(join(spriteDir(recordId), scannerSetRelPath(recordId)), null);
}

const seedSelection = (recordId) => ({
  schemaVersion: 1,
  kind: 'reviewed-directional-scanner-selection',
  track: SCANNER_TRACK,
  characterId: recordId,
  status: 'in-progress',
  directions: {},
});

async function saveRun(recordId, run) {
  const dir = join(spriteDir(recordId), runRelPath(run.id));
  await ensureDir(dir);
  await atomicWrite(join(dir, RUN_RECORD_NAME), run);
}

async function loadRun(recordId, runId) {
  return readJSONFile(join(spriteDir(recordId), runRelPath(runId), RUN_RECORD_NAME), null);
}

async function scannerRuns(recordId) {
  const runsDir = join(spriteDir(recordId), 'runs');
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => (
    readJSONFile(join(runsDir, entry.name, RUN_RECORD_NAME), null)
  )));
  return runs.filter((run) => run?.track === SCANNER_TRACK)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

export async function getScannerState(recordId) {
  const [selection, scannerSet, runs] = await Promise.all([
    loadSelection(recordId), loadSet(recordId), scannerRuns(recordId),
  ]);
  return {
    track: SCANNER_TRACK,
    bounds: getAnimationTrack(SCANNER_TRACK),
    selection,
    scannerSet,
    runs,
  };
}

const lockedAnchorFor = (manifest, direction) => {
  const anchor = manifest?.anchors?.find((item) => item.direction === direction);
  return anchor?.status === 'locked' && anchor.path ? anchor : null;
};

function scannerTask({ prompt, inputAbs, videoAbs, duration }) {
  return `${prompt}\n\nUse your built-in image_to_video tool to animate this exact image for ${duration} seconds:\n${inputAbs}\n\n`
    + `Save the resulting animation as an MP4 file at exactly this path:\n${videoAbs}\n\n`
    + 'Do not create or modify any other files, and do not run any tools beyond what is needed to render and save that MP4.';
}

export function startScannerGeneration(recordId, body) {
  return withAnimationWriteTail(recordId, () => startScannerGenerationImpl(recordId, body));
}

async function startScannerGenerationImpl(recordId, body) {
  const [record, reference, scannerSet, existingRuns] = await Promise.all([
    requireTrack(recordId, SCANNER_TRACK), loadManifest(recordId), loadSet(recordId), scannerRuns(recordId),
  ]);
  if (scannerSet) throw scannerSetFinalError();
  const { direction } = body;
  const anchor = lockedAnchorFor(reference, direction);
  if (!anchor) throw new ServerError(`Lock the ${anchorIdForDirection(direction)} anchor before generating its scanner action`, { status: 409, code: 'ANCHOR_NOT_LOCKED' });
  const chromaKey = resolveChromaKey({ manifest: reference, record });
  if (!chromaKey) throw new ServerError('No frozen chroma key is available for this character', { status: 409, code: 'CHROMA_KEY_REQUIRED' });
  if (existingRuns.some((run) => run.direction === direction && ['rendering', 'postprocessing'].includes(run.status))) {
    throw new ServerError(`A scanner render for ${direction} is already in progress`, { status: 409, code: 'SCANNER_RENDER_IN_PROGRESS' });
  }

  const frameCount = clampTrackFrameCount(body.frameCount, SCANNER_TRACK);
  const fps = clampTrackFps(body.fps, SCANNER_TRACK);
  // Optional re-roll note (#3134) — blank leaves the prompt and the run record
  // exactly as a blind regenerate would.
  const correctionPrompt = typeof body.correctionPrompt === 'string' ? body.correctionPrompt.trim() : '';
  const runId = `${SCANNER_TRACK}-${direction}-${randomUUID().slice(0, 8)}`;
  const runRel = runRelPath(runId);
  const generatedAbs = join(spriteDir(recordId), runRel, 'generated');
  await ensureDir(generatedAbs);
  const anchorAbs = resolveSpriteAssetPath(recordId, anchor.path);
  if (!await pathExists(anchorAbs)) throw new ServerError('Locked anchor file is missing on disk', { status: 500, code: 'ANCHOR_MISSING' });
  const inputAbs = join(generatedAbs, 'input-anchor-chroma.png');
  const [{ preparation, sha256: inputSha256 }, settings] = await Promise.all([
    prepareWalkAnchorChromaInput(anchorAbs, inputAbs, chromaKey), getSettings(),
  ]);
  const duration = resolveGrokDuration(body.duration);
  const videoAbs = join(generatedAbs, SOURCE_CLIP_NAME);
  const run = {
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    track: SCANNER_TRACK,
    provider: GROK_TUI_ID,
    status: 'rendering',
    id: runId,
    shellSession: runId,
    characterId: recordId,
    direction,
    chromaKey,
    duration,
    frameCount,
    fps,
    anchorPath: anchor.path,
    anchorSha256: anchor.sha256 || await sha256File(anchorAbs),
    animationInputPath: `${runRel}/generated/input-anchor-chroma.png`,
    animationInputSha256: inputSha256,
    animationInputPreparation: preparation,
    ...(correctionPrompt ? { correctionPrompt } : {}),
    createdAt: new Date().toISOString(),
  };
  await saveRun(recordId, run);
  runScannerTuiRender(recordId, {
    runId,
    direction,
    generatedAbs,
    videoAbs,
    grokPath: settings.imageGen?.grok?.grokPath,
    task: scannerTask({
      prompt: buildScannerPrompt({ name: record.name, direction, chromaKey, correctionPrompt }),
      inputAbs,
      videoAbs,
      duration,
    }),
  }).catch((err) => console.error(`❌ sprite scanner grok-tui render crashed ${recordId}/${runId}: ${err?.message || err}`));
  console.log(`📡 sprite scanner grok-tui render started ${recordId}/${runId}`);
  return { runId, direction, duration, shellSession: runId };
}

async function runScannerTuiRender(recordId, { runId, direction, generatedAbs, videoAbs, grokPath, task }) {
  await executeTuiRun({
    runId,
    provider: { id: GROK_TUI_ID, type: 'tui', command: grokPath || 'grok', args: [] },
    prompt: task,
    workspacePath: generatedAbs,
    idleMs: TUI_IDLE_MS,
    timeout: TUI_TIMEOUT_MS,
    label: `sprite scanner ${recordId}/${direction}`,
  }).catch((err) => console.error(`❌ sprite scanner grok-tui run failed ${recordId}/${runId}: ${err?.message || err}`));
  await withAnimationWriteTail(recordId, () => attachScannerTuiResult(recordId, runId, videoAbs));
}

export async function attachScannerTuiResult(recordId, runId, videoAbs) {
  const run = await loadRun(recordId, runId);
  if (!run || run.track !== SCANNER_TRACK || await loadSet(recordId)) return;
  const selection = await loadSelection(recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) return;
  if (!await pathExists(videoAbs)) {
    run.status = 'error';
    run.postprocessError = 'Grok finished without writing the scanner video — check the shell session output';
    run.completedAt = new Date().toISOString();
    await saveRun(recordId, run);
    return;
  }
  run.status = 'postprocessing';
  run.sourceVideoPath = `${runRelPath(run.id)}/generated/${SOURCE_CLIP_NAME}`;
  await saveRun(recordId, run);
  await packageScannerRun(recordId, run);
  await saveRun(recordId, run);
}

async function packageScannerRun(recordId, run) {
  try {
    const [reference, record] = await Promise.all([loadManifest(recordId), getRecord(recordId)]);
    const anchor = lockedAnchorFor(reference, run.direction);
    if (!anchor) throw new Error(`No locked ${run.direction} anchor in the reference manifest`);
    const chromaKey = resolveChromaKey({ manifest: reference, record, run });
    if (!chromaKey) throw new Error('No chroma key is available for the scanner matte');
    const runRel = runRelPath(run.id);
    const result = await runWalkPostprocess({
      recordId,
      track: SCANNER_TRACK,
      direction: run.direction,
      chromaKey,
      runAbs: join(spriteDir(recordId), runRel),
      runRel,
      anchorRel: anchor.path,
      anchorAbs: resolveSpriteAssetPath(recordId, anchor.path),
      videoAbs: resolveSpriteAssetPath(recordId, run.sourceVideoPath),
      frameCount: clampTrackFrameCount(run.frameCount, SCANNER_TRACK),
      fps: clampTrackFps(run.fps, SCANNER_TRACK),
    });
    run.frameCount = result.manifest.frameCount;
    run.fps = result.manifest.frameRate;
    run.status = 'candidate';
    run.postprocessManifest = result.manifestPath;
    run.stripPreview = result.stripPreview;
    delete run.postprocessError;
  } catch (err) {
    run.status = 'error';
    run.postprocessError = err.message;
    console.error(`❌ sprite scanner postprocess failed ${recordId}/${run.id}: ${err.message}`);
  }
  run.completedAt = new Date().toISOString();
}

export function approveScannerDirection(recordId, args) {
  return withAnimationWriteTail(recordId, () => approveScannerDirectionImpl(recordId, args));
}

async function approveScannerDirectionImpl(recordId, { direction, runId }) {
  await requireTrack(recordId, SCANNER_TRACK);
  if (await loadSet(recordId)) throw scannerSetFinalError();
  const run = await loadRun(recordId, runId);
  if (!run || run.track !== SCANNER_TRACK) throw new ServerError(`Unknown scanner run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  if (run.direction !== direction) throw new ServerError(`Run ${runId} animates '${run.direction}', not '${direction}'`, { status: 400, code: 'RUN_DIRECTION_MISMATCH' });
  if (run.status !== 'candidate' || !run.postprocessManifest) throw new ServerError('Run has no packaged candidate to approve', { status: 409, code: 'RUN_NOT_CANDIDATE' });
  const [reference, packaged] = await Promise.all([
    loadManifest(recordId), readJSONFile(resolveSpriteAssetPath(recordId, run.postprocessManifest), null),
  ]);
  const anchor = lockedAnchorFor(reference, direction);
  if (!anchor) throw new ServerError(`Lock the ${anchorIdForDirection(direction)} anchor before approving its scanner action`, { status: 409, code: 'ANCHOR_NOT_LOCKED' });
  if (run.anchorSha256) {
    const currentAnchorSha256 = anchor.sha256 || await sha256File(resolveSpriteAssetPath(recordId, anchor.path));
    if (run.anchorSha256 !== currentAnchorSha256) {
      throw new ServerError('This scanner action was rendered from an older directional anchor — generate it again from the current anchor', { status: 409, code: 'RUN_ANCHOR_STALE' });
    }
  }
  if (!packaged || packaged.track !== SCANNER_TRACK || packaged.direction !== direction || packaged.characterId !== recordId
    || packaged.frameCount !== run.frameCount || packaged.frameRate !== run.fps) {
    throw new ServerError('Packaged scanner manifest is missing or inconsistent', { status: 409, code: 'RUN_MANIFEST_INVALID' });
  }
  const frameCheck = await verifyPackagedFrames(recordId, packaged, { track: SCANNER_TRACK });
  if (frameCheck.missing) throw new ServerError(
    `${frameCheck.missing} of this scanner run's ${frameCheck.total} packaged frames are missing on disk`,
    { status: 409, code: 'RUN_FRAMES_MISSING' },
  );
  const selection = (await loadSelection(recordId)) || seedSelection(recordId);
  selection.directions[direction] = {
    status: 'approved',
    runId,
    runPath: runRelPath(runId),
    runManifest: run.postprocessManifest,
    runManifestSha256: await sha256File(resolveSpriteAssetPath(recordId, run.postprocessManifest)),
    approvedAt: new Date().toISOString(),
  };
  const allApproved = SPRITE_DIRECTIONS.every((item) => selection.directions[item]?.status === 'approved');
  selection.status = allApproved ? 'complete' : 'in-progress';
  const selectionAbs = join(spriteDir(recordId), selectionRelPath(recordId));
  await ensureDir(join(spriteDir(recordId), SCANNER_TRACK));
  await atomicWrite(selectionAbs, selection);
  if (allApproved) {
    await atomicWrite(join(spriteDir(recordId), scannerSetRelPath(recordId)), {
      schemaVersion: 1,
      kind: 'finalized-eight-direction-scanner-set',
      track: SCANNER_TRACK,
      characterId: recordId,
      status: 'final',
      directionOrder: SPRITE_DIRECTIONS,
      selectionPath: selectionRelPath(recordId),
      selectionSha256: await sha256File(selectionAbs),
      directions: selection.directions,
      finalizedAt: new Date().toISOString(),
    });
    console.log(`🏁 sprite scanner set finalized for ${recordId}`);
  }
  return getScannerState(recordId);
}

export function invalidateScannerDirectionForAnchorRevision(recordId, { direction }) {
  return withAnimationWriteTail(recordId, () => invalidateScannerDirectionForAnchorRevisionImpl(recordId, direction));
}

export function invalidateScannerForTurnaroundRevision(recordId) {
  return withAnimationWriteTail(recordId, async () => {
    const invalidated = [];
    for (const direction of SPRITE_DIRECTIONS) {
      if (await invalidateScannerDirectionForAnchorRevisionImpl(recordId, direction)) invalidated.push(direction);
    }
    return invalidated;
  });
}

async function invalidateScannerDirectionForAnchorRevisionImpl(recordId, direction) {
  const [scannerSet, loaded] = await Promise.all([loadSet(recordId), loadSelection(recordId)]);
  const approved = loaded?.directions?.[direction] || scannerSet?.directions?.[direction];
  if (approved?.status !== 'approved') return false;
  const selection = loaded || { ...seedSelection(recordId), directions: { ...(scannerSet?.directions || {}) } };
  if (scannerSet) await rm(join(spriteDir(recordId), scannerSetRelPath(recordId)), { force: true });
  delete selection.directions[direction];
  selection.status = 'in-progress';
  await ensureDir(join(spriteDir(recordId), SCANNER_TRACK));
  await atomicWrite(join(spriteDir(recordId), selectionRelPath(recordId)), selection);
  const run = approved.runId ? await loadRun(recordId, approved.runId) : null;
  if (run?.track === SCANNER_TRACK) {
    await saveRun(recordId, {
      ...run,
      status: 'superseded-anchor',
      supersededAt: new Date().toISOString(),
      supersededReason: 'directional-anchor-revised',
    });
  }
  console.log(`♻️ sprite scanner direction ${recordId}/${direction} invalidated after anchor revision`);
  return true;
}
