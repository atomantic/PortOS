/**
 * The first real non-directional animation track: one ambient loop for a
 * place, object, or imported prop. The only provider call is the explicit
 * generate route; packing, review, approval, and atlas input are local.
 */

import { join } from 'path';
import { readdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { atomicWrite, ensureDir, pathExists, readJSONFile, sha256File } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { executeTuiRun } from '../../lib/tuiPromptRunner.js';
import { GROK_TUI_ID } from '../../lib/grok.js';
import { getSettings } from '../settings.js';
import { getRecord } from './records.js';
import { requireTrack, loadManifest } from './reference.js';
import { AMBIENT_TRACK, clampTrackFrameCount, clampTrackFps, getAnimationTrack } from './animationTracks.js';
import { spriteDir, resolveSpriteAssetPath, SOURCE_CLIP_NAME } from './paths.js';
import { prepareWalkAnchorChromaInput, runWalkPostprocess } from './walkPostprocess.js';
import { verifyPackagedFrames } from './walkFrames.js';
import { resolveChromaKey, withAnimationWriteTail } from './animationWorkflow.js';
import { resolveGrokDuration } from '../../lib/grokVideoClip.js';
import { buildAmbientVideoPrompt } from './prompts.js';

const RUN_RECORD_NAME = 'animation-run.json';
const AMBIENT_DIRECTION = 'south';
const TUI_IDLE_MS = 90_000;
const TUI_TIMEOUT_MS = 30 * 60_000;
const selectionRelPath = (id) => `ambient/${id}-ambient-selection-v1.json`;
export const ambientSetRelPath = (id) => `ambient/${id}-ambient-set-v1.json`;
const runRelPath = (runId) => `runs/${runId}`;

const ambientSetFinalError = () => new ServerError(
  'Ambient loop is finalized and immutable',
  { status: 409, code: 'AMBIENT_SET_FINAL' },
);

const loadSelection = (recordId) => readJSONFile(join(spriteDir(recordId), selectionRelPath(recordId)), null);
const loadSet = (recordId) => readJSONFile(join(spriteDir(recordId), ambientSetRelPath(recordId)), null);
const loadRun = (recordId, runId) => readJSONFile(join(spriteDir(recordId), runRelPath(runId), RUN_RECORD_NAME), null);

const seedSelection = (recordId) => ({
  schemaVersion: 1,
  kind: 'reviewed-single-row-ambient-selection',
  track: AMBIENT_TRACK,
  characterId: recordId,
  status: 'in-progress',
  directions: {},
});

async function saveRun(recordId, run) {
  const dir = join(spriteDir(recordId), runRelPath(run.id));
  await ensureDir(dir);
  await atomicWrite(join(dir, RUN_RECORD_NAME), run);
}

async function ambientRuns(recordId) {
  const runsDir = join(spriteDir(recordId), 'runs');
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => (
    readJSONFile(join(runsDir, entry.name, RUN_RECORD_NAME), null)
  )));
  return runs.filter((run) => run?.track === AMBIENT_TRACK)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

export async function getAmbientState(recordId) {
  const [selection, ambientSet, runs] = await Promise.all([
    loadSelection(recordId), loadSet(recordId), ambientRuns(recordId),
  ]);
  return {
    track: AMBIENT_TRACK,
    bounds: getAnimationTrack(AMBIENT_TRACK),
    selection,
    ambientSet,
    runs,
  };
}

const lockedMain = (manifest) => (
  manifest?.mainReference?.locked && manifest.mainReference.path ? manifest.mainReference : null
);

const ambientTask = ({ prompt, inputAbs, videoAbs, duration }) => (
  `${prompt}\n\nUse your built-in image_to_video tool to animate this exact image for ${duration} seconds:\n${inputAbs}\n\n`
  + `Save the resulting animation as an MP4 file at exactly this path:\n${videoAbs}\n\n`
  + 'Do not create or modify any other files, and do not run any tools beyond what is needed to render and save that MP4.'
);

export function startAmbientGeneration(recordId, body) {
  return withAnimationWriteTail(recordId, () => startAmbientGenerationImpl(recordId, body));
}

async function startAmbientGenerationImpl(recordId, body) {
  const [record, reference, ambientSet, existingRuns] = await Promise.all([
    requireTrack(recordId, AMBIENT_TRACK), loadManifest(recordId), loadSet(recordId), ambientRuns(recordId),
  ]);
  if (ambientSet) throw ambientSetFinalError();
  const main = lockedMain(reference);
  if (!main) throw new ServerError('Lock the main reference before generating an ambient loop', { status: 409, code: 'MAIN_NOT_LOCKED' });
  const chromaKey = resolveChromaKey({ manifest: reference, record });
  if (!chromaKey) throw new ServerError('No frozen chroma key is available for this sprite', { status: 409, code: 'CHROMA_KEY_REQUIRED' });
  if (existingRuns.some((run) => ['rendering', 'postprocessing'].includes(run.status))) {
    throw new ServerError('An ambient render is already in progress', { status: 409, code: 'AMBIENT_RENDER_IN_PROGRESS' });
  }

  const frameCount = clampTrackFrameCount(body.frameCount, AMBIENT_TRACK);
  const fps = clampTrackFps(body.fps, AMBIENT_TRACK);
  // Optional re-roll note (#3134) — blank leaves the prompt and the run record
  // exactly as a blind regenerate would.
  const correctionPrompt = typeof body.correctionPrompt === 'string' ? body.correctionPrompt.trim() : '';
  const runId = `${AMBIENT_TRACK}-${randomUUID().slice(0, 8)}`;
  const runRel = runRelPath(runId);
  const generatedAbs = join(spriteDir(recordId), runRel, 'generated');
  await ensureDir(generatedAbs);
  const mainAbs = resolveSpriteAssetPath(recordId, main.path);
  if (!await pathExists(mainAbs)) throw new ServerError('Locked main reference file is missing on disk', { status: 500, code: 'MAIN_REFERENCE_MISSING' });
  const inputAbs = join(generatedAbs, 'input-main-chroma.png');
  const [{ preparation, sha256: inputSha256 }, settings] = await Promise.all([
    prepareWalkAnchorChromaInput(mainAbs, inputAbs, chromaKey), getSettings(),
  ]);
  const duration = resolveGrokDuration(body.duration);
  const videoAbs = join(generatedAbs, SOURCE_CLIP_NAME);
  const run = {
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    track: AMBIENT_TRACK,
    provider: GROK_TUI_ID,
    status: 'rendering',
    id: runId,
    shellSession: runId,
    characterId: recordId,
    direction: AMBIENT_DIRECTION,
    chromaKey,
    duration,
    frameCount,
    fps,
    anchorPath: main.path,
    anchorSha256: main.sha256 || await sha256File(mainAbs),
    animationInputPath: `${runRel}/generated/input-main-chroma.png`,
    animationInputSha256: inputSha256,
    animationInputPreparation: preparation,
    ...(correctionPrompt ? { correctionPrompt } : {}),
    createdAt: new Date().toISOString(),
  };
  await saveRun(recordId, run);
  runAmbientTuiRender(recordId, {
    runId,
    generatedAbs,
    videoAbs,
    grokPath: settings.imageGen?.grok?.grokPath,
    task: ambientTask({
      prompt: buildAmbientVideoPrompt({ name: record.name, kind: record.kind, chromaKey, correctionPrompt }),
      inputAbs,
      videoAbs,
      duration,
    }),
  }).catch((err) => console.error(`❌ sprite ambient grok-tui render crashed ${recordId}/${runId}: ${err?.message || err}`));
  console.log(`📡 sprite ambient grok-tui render started ${recordId}/${runId}`);
  return { runId, duration, shellSession: runId };
}

async function runAmbientTuiRender(recordId, { runId, generatedAbs, videoAbs, grokPath, task }) {
  await executeTuiRun({
    runId,
    provider: { id: GROK_TUI_ID, type: 'tui', command: grokPath || 'grok', args: [] },
    prompt: task,
    workspacePath: generatedAbs,
    idleMs: TUI_IDLE_MS,
    timeout: TUI_TIMEOUT_MS,
    label: `sprite ambient ${recordId}`,
  }).catch((err) => console.error(`❌ sprite ambient grok-tui run failed ${recordId}/${runId}: ${err?.message || err}`));
  await withAnimationWriteTail(recordId, () => attachAmbientTuiResult(recordId, runId, videoAbs));
}

export async function attachAmbientTuiResult(recordId, runId, videoAbs) {
  const run = await loadRun(recordId, runId);
  if (!run || run.track !== AMBIENT_TRACK || await loadSet(recordId)) return;
  const selection = await loadSelection(recordId);
  if (selection?.directions?.[AMBIENT_DIRECTION]?.runId === runId) return;
  if (!await pathExists(videoAbs)) {
    run.status = 'error';
    run.postprocessError = 'Grok finished without writing the ambient video — check the shell session output';
    run.completedAt = new Date().toISOString();
    await saveRun(recordId, run);
    return;
  }
  run.status = 'postprocessing';
  run.sourceVideoPath = `${runRelPath(run.id)}/generated/${SOURCE_CLIP_NAME}`;
  await saveRun(recordId, run);
  await packageAmbientRun(recordId, run);
  await saveRun(recordId, run);
}

async function packageAmbientRun(recordId, run) {
  try {
    const [reference, record] = await Promise.all([loadManifest(recordId), getRecord(recordId)]);
    const main = lockedMain(reference);
    if (!main) throw new Error('No locked main reference in the reference manifest');
    const chromaKey = resolveChromaKey({ manifest: reference, record, run });
    if (!chromaKey) throw new Error('No chroma key is available for the ambient matte');
    const runRel = runRelPath(run.id);
    const result = await runWalkPostprocess({
      recordId,
      track: AMBIENT_TRACK,
      direction: AMBIENT_DIRECTION,
      chromaKey,
      runAbs: join(spriteDir(recordId), runRel),
      runRel,
      anchorRel: main.path,
      anchorAbs: resolveSpriteAssetPath(recordId, main.path),
      videoAbs: resolveSpriteAssetPath(recordId, run.sourceVideoPath),
      frameCount: clampTrackFrameCount(run.frameCount, AMBIENT_TRACK),
      fps: clampTrackFps(run.fps, AMBIENT_TRACK),
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
    console.error(`❌ sprite ambient postprocess failed ${recordId}/${run.id}: ${err.message}`);
  }
  run.completedAt = new Date().toISOString();
}

export function approveAmbientLoop(recordId, args) {
  return withAnimationWriteTail(recordId, () => approveAmbientLoopImpl(recordId, args));
}

async function approveAmbientLoopImpl(recordId, { runId }) {
  await requireTrack(recordId, AMBIENT_TRACK);
  if (await loadSet(recordId)) throw ambientSetFinalError();
  const run = await loadRun(recordId, runId);
  if (!run || run.track !== AMBIENT_TRACK) throw new ServerError(`Unknown ambient run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  if (run.status !== 'candidate' || !run.postprocessManifest) throw new ServerError('Run has no packaged candidate to approve', { status: 409, code: 'RUN_NOT_CANDIDATE' });
  const [reference, packaged] = await Promise.all([
    loadManifest(recordId), readJSONFile(resolveSpriteAssetPath(recordId, run.postprocessManifest), null),
  ]);
  const main = lockedMain(reference);
  if (!main) throw new ServerError('Lock the main reference before approving its ambient loop', { status: 409, code: 'MAIN_NOT_LOCKED' });
  if (run.anchorSha256) {
    const currentMainSha256 = main.sha256 || await sha256File(resolveSpriteAssetPath(recordId, main.path));
    if (run.anchorSha256 !== currentMainSha256) {
      throw new ServerError('This ambient loop was rendered from an older main reference — generate it again from the current reference', { status: 409, code: 'RUN_ANCHOR_STALE' });
    }
  }
  if (!packaged || packaged.track !== AMBIENT_TRACK || packaged.direction !== AMBIENT_DIRECTION || packaged.characterId !== recordId
    || packaged.frameCount !== run.frameCount || packaged.frameRate !== run.fps) {
    throw new ServerError('Packaged ambient manifest is missing or inconsistent', { status: 409, code: 'RUN_MANIFEST_INVALID' });
  }
  const frameCheck = await verifyPackagedFrames(recordId, packaged, { track: AMBIENT_TRACK });
  if (frameCheck.missing) throw new ServerError(
    `${frameCheck.missing} of this ambient run's ${frameCheck.total} packaged frames are missing on disk`,
    { status: 409, code: 'RUN_FRAMES_MISSING' },
  );
  const selection = (await loadSelection(recordId)) || seedSelection(recordId);
  selection.directions[AMBIENT_DIRECTION] = {
    status: 'approved',
    runId,
    runPath: runRelPath(runId),
    runManifest: run.postprocessManifest,
    runManifestSha256: await sha256File(resolveSpriteAssetPath(recordId, run.postprocessManifest)),
    approvedAt: new Date().toISOString(),
  };
  selection.status = 'complete';
  const selectionAbs = join(spriteDir(recordId), selectionRelPath(recordId));
  await ensureDir(join(spriteDir(recordId), AMBIENT_TRACK));
  await atomicWrite(selectionAbs, selection);
  await atomicWrite(join(spriteDir(recordId), ambientSetRelPath(recordId)), {
    schemaVersion: 1,
    kind: 'finalized-single-row-ambient-set',
    track: AMBIENT_TRACK,
    characterId: recordId,
    status: 'final',
    directionOrder: [AMBIENT_DIRECTION],
    selectionPath: selectionRelPath(recordId),
    selectionSha256: await sha256File(selectionAbs),
    directions: selection.directions,
    finalizedAt: new Date().toISOString(),
  });
  console.log(`🏁 sprite ambient loop finalized for ${recordId}`);
  return getAmbientState(recordId);
}
