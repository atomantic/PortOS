/**
 * The generic per-track animation workflow (#3136).
 *
 * `scanner.js` and `ambient.js` were two ~300-line copies of one control flow:
 * load the track's review selection / finalized set / runs → require a locked
 * source reference → prepare a chroma matte → start ONE user-requested Grok
 * image-to-video render → package it deterministically → review → approve →
 * freeze the set. Nothing about that sequence is scanner-shaped or ambient
 * shaped; they differed only in facts the track registry now carries:
 *
 *   - `directional`      how many facings the track is authored across (and so
 *                        how many must be approved before the set freezes) AND —
 *                        derived from it via `sourceReferenceFor` — which locked
 *                        image seeds the render: this facing's own anchor, or the
 *                        one main reference. Derived rather than declared because
 *                        only one pairing can work; a row that claimed the other
 *                        would render one facing's clip for every row.
 *   - `selectionKind` / `setKind` / `finalErrorCode`
 *                        the on-disk discriminators and the 409 code
 *
 * plus one prompt builder. So this module is that flow ONCE, parameterized by
 * track id, and a new animation type is a registry row + a prompt — not a fourth
 * copy of this file. Walk deliberately stays on its own service (`walk.js`): it
 * carries reprocess, loop trims, per-direction reopen, source-frame extraction
 * and set-level targets that no other track has, and folding those in would make
 * this module the union of every track's features rather than their intersection.
 *
 * **On-disk compatibility is exact, not approximate.** Every path, `kind`
 * string, run field, error code and message this writes is byte-identical to
 * what the two clones wrote, because installs already hold approved scanner sets
 * and ambient loops whose evidence chain the atlas compiler re-verifies by those
 * exact strings. The clone collapse is a code change only.
 *
 * The render is reachable only through `startTrackGeneration` — a direct user
 * action per the AI-provider policy. Everything after Grok writes the MP4 is
 * deterministic local packing, review, approval, and atlas input; no boot path
 * or read endpoint calls a provider.
 */

import { join } from 'path';
import { readdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { atomicWrite, ensureDir, pathExists, readJSONFile, sha256File, rmGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { executeTuiRun } from '../tuiPromptRunner.js';
import { GROK_TUI_ID } from '../../lib/grok.js';
import { resolveGrokDuration } from '../../lib/grokVideoClip.js';
import {
  planLocalAnimationRender, enqueueLocalAnimationRender, localRenderManifest,
  normalizeStaleAnimationRun,
} from './localAnimationRender.js';
import { getSettings } from '../settings.js';
import { getRecord, listRecords } from './records.js';
import { requireTrack, loadManifest } from './reference.js';
import { anchorIdForDirection } from './prompts.js';
import { buildTrackVideoPrompt } from './trackPrompts.js';
import { clampTrackFrameCount, clampTrackFps, sourceReferenceFor } from './animationTracks.js';
// #3152 — this workflow drives ANY row, so every registry lookup resolves against
// the effective table (compiled `walk` + the user-defined store); a user's own
// track reaches generate/approve through exactly this path with no new code.
import { effectiveTrack, getEffectiveAnimationTracks } from './animationTrackStore.js';
import { trackDirections } from './atlasGrid.js';
import {
  spriteDir, resolveSpriteAssetPath, SOURCE_CLIP_NAME, runRelPath, RUN_RECORD_NAME,
} from './paths.js';
import { prepareWalkAnchorChromaInput, runWalkPostprocess } from './walkPostprocess.js';
import { verifyPackagedFrames } from './walkFrames.js';
import {
  resolveChromaKey, withAnimationWriteTail, lockedAnchorFor, lockedMainFor,
  GROK_TUI_IDLE_MS, GROK_TUI_TIMEOUT_MS, grokTuiProvider, buildGrokI2vTask,
  resolveAnimationProvider, isLocalProviderRun, runCreatedAtMs,
} from './animationWorkflow.js';


/**
 * The facings a track is authored across: every direction for a directional
 * track, the single row 0 for a non-directional one.
 *
 * `trackDirections` (atlasGrid) is the ONE definition of that slice, shared with
 * the compiler — which matters because the count decides both when a set freezes
 * (and what `directionOrder` it writes) and how many rows the compiler will
 * accept. Two derivations of one registry field is exactly the drift
 * `trackDirections`'s own header says it exists to prevent.
 */
export const trackAuthoringDirections = (trackId) => trackDirections(trackId);

// The on-disk layout, per track. `<track>/` subdirectory and `-<track>-` infix,
// which is exactly what scanner.js and ambient.js each spelled for themselves.
const selectionRelPath = (trackId, id) => `${trackId}/${id}-${trackId}-selection-v1.json`;
export const trackSetRelPath = (trackId, id) => `${trackId}/${id}-${trackId}-set-v1.json`;

const setFinalError = (row) => new ServerError(
  row.directional
    ? `${row.label} set is finalized — reopen it before generating or approving another ${row.label.toLowerCase()}`
    : `${row.label} is finalized and immutable`,
  { status: 409, code: row.finalErrorCode },
);

const loadSelection = (trackId, recordId) =>
  readJSONFile(join(spriteDir(recordId), selectionRelPath(trackId, recordId)), null);
const loadSet = (trackId, recordId) =>
  readJSONFile(join(spriteDir(recordId), trackSetRelPath(trackId, recordId)), null);
const loadRun = (recordId, runId) =>
  readJSONFile(join(spriteDir(recordId), runRelPath(runId), RUN_RECORD_NAME), null);

const seedSelection = (row, recordId) => ({
  schemaVersion: 1,
  kind: row.selectionKind,
  track: row.id,
  characterId: recordId,
  status: 'in-progress',
  directions: {},
});

async function saveRun(recordId, run) {
  const dir = join(spriteDir(recordId), runRelPath(run.id));
  await ensureDir(dir);
  await atomicWrite(join(dir, RUN_RECORD_NAME), run);
}

/**
 * Every run on disk belonging to `trackId`, newest first.
 *
 * Stranded `rendering` runs are normalized to `error` at READ time — never
 * persisted — by the same rule the walk lane uses. Without it a run whose render
 * could no longer be resolved (its server died and the completion hook could not
 * reach it) sits at `rendering` forever, and the in-flight guard below then
 * refuses every regenerate for that facing with TRACK_RENDER_IN_PROGRESS — with
 * no per-run delete and `reopenTrackDirection` only touching APPROVED runs, that
 * is unrecoverable short of hand-editing the record. The walk lane always had
 * this backstop; the track lane never did, and the local lane's multi-hour
 * renders made the gap materially more reachable.
 */
async function trackRuns(trackId, recordId) {
  const runsDir = join(spriteDir(recordId), 'runs');
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => (
    readJSONFile(join(runsDir, entry.name, RUN_RECORD_NAME), null)
  )));
  return runs.filter((run) => run?.track === trackId)
    .map((run) => normalizeStaleAnimationRun(run, staleRenderError(trackId)))
    .sort((a, b) => runCreatedAtMs(b.createdAt) - runCreatedAtMs(a.createdAt));
}

/** The read-time message a stranded run carries, named for the track it is on. */
const staleRenderError = (trackId) => (
  `The ${effectiveTrack(trackId).label.toLowerCase()} render was interrupted `
  + '(server restart or timeout) — regenerate to retry.'
);

/**
 * The track's authoring state: `{ track, definition, selection, set, runs }`.
 *
 * `definition` is the registry row, shipped so the client renders the track's
 * label, facing count, and bounds from data instead of mirroring them as
 * component copy — that is what lets one component serve a track it has never
 * heard of. `set` is the finalized-set key for every track; the old per-track
 * spellings (`scannerSet`/`ambientSet`) went away with the clones.
 */
export async function getTrackState(trackId, recordId) {
  const row = effectiveTrack(trackId);
  const [selection, set, runs] = await Promise.all([
    loadSelection(row.id, recordId), loadSet(row.id, recordId), trackRuns(row.id, recordId),
  ]);
  return { track: row.id, definition: row, selection, set, runs };
}

/**
 * Every record id carrying approved work for `trackId`, in library order (#3153).
 *
 * The evidence a delete or a directionality flip would orphan, as ONE question:
 * either the finalized set (the frozen `setKind` artifact the atlas compiler
 * re-verifies) or a review selection with at least one approved direction. Both
 * are renders the user approved and both are keyed by the discriminator strings
 * the mutation would remove from the registry — a set alone would miss a
 * half-approved directional track, where seven approvals exist but the eighth
 * hasn't frozen the set yet.
 *
 * Lives here rather than in the CRUD service because the on-disk layout
 * (`<track>/<id>-<track>-{selection,set}-v1.json`) is this module's contract; a
 * second reader spelling those filenames is exactly the drift the generic
 * workflow collapsed.
 *
 * Deliberately tolerant of a record whose directory is unreadable: `loadSelection`
 * and `loadSet` answer `null` for anything absent, so a record with no assets
 * simply doesn't carry the track. It never invents a false positive that would
 * block a legitimate delete.
 */
export async function recordsCarryingTrack(trackId) {
  const records = await listRecords();
  const carried = await Promise.all(records.map(async (record) => {
    const [selection, set] = await Promise.all([
      loadSelection(trackId, record.id), loadSet(trackId, record.id),
    ]);
    const approved = Object.values(selection?.directions || {})
      .some((entry) => entry?.status === 'approved');
    return set || approved ? record.id : null;
  }));
  return carried.filter(Boolean);
}

/**
 * Everything about the locked reference this track's render is seeded from — both
 * when it exists and when it doesn't.
 *
 * ONE resolver so no caller ever branches on the source shape again. It returns
 * the artifact's `label`, the error `code`s to use when it isn't locked or has
 * vanished from disk, and — when it IS locked — its `path`/`sha256`/`inputName`.
 * Returning the label and codes unconditionally is the point: the "lock it first"
 * 409 and the "missing on disk" 500 both need to name the artifact the row asked
 * for, and re-deriving that name at each throw site is how three of them ended up
 * spelling the anchor's name three different ways.
 *
 * `locked` is the sentinel: absent means nothing is frozen yet, which is a
 * different answer from "frozen but gone", handled by the caller's disk check.
 */
function trackSourceFor(row, manifest, direction) {
  if (sourceReferenceFor(row.id, getEffectiveAnimationTracks()) === 'main') {
    const main = lockedMainFor(manifest);
    return {
      label: 'main reference',
      notLockedCode: 'MAIN_NOT_LOCKED',
      missingCode: 'MAIN_REFERENCE_MISSING',
      inputName: 'input-main-chroma.png',
      locked: main ? { path: main.path, sha256: main.sha256 || null } : null,
    };
  }
  const anchor = lockedAnchorFor(manifest, direction);
  return {
    label: `${anchorIdForDirection(direction)} anchor`,
    notLockedCode: 'ANCHOR_NOT_LOCKED',
    missingCode: 'ANCHOR_MISSING',
    inputName: 'input-anchor-chroma.png',
    locked: anchor ? { path: anchor.path, sha256: anchor.sha256 || null } : null,
  };
}

/**
 * The facing a request is for, resolved against the track's OWN facing list.
 *
 * A non-directional track occupies exactly its single row, so its facing is
 * derived from the registry rather than accepted from the request — no
 * user-supplied direction can drift from what the compiler will later expect.
 *
 * A directional track's facing must be one the TRACK has, not merely one the
 * sprite grid has: the route's Zod enum accepts all eight facings, but
 * `trackAuthoringDirections` is a per-track slice, so a future track with fewer
 * facings would otherwise accept a render for a row it doesn't occupy — which
 * would author a set the compiler refuses, after the render was already paid for.
 */
function resolveTrackDirection(row, requested) {
  const authored = trackAuthoringDirections(row.id);
  if (!row.directional) return authored[0];
  if (!authored.includes(requested)) {
    throw new ServerError(
      `The ${row.id} track has no '${String(requested)}' facing — it is authored across: ${authored.join(', ')}`,
      { status: 400, code: 'TRACK_DIRECTION_INVALID' },
    );
  }
  return requested;
}

/** The 409 for a render/approval whose source reference isn't frozen yet. */
const notLockedError = (source, row, verb) => new ServerError(
  `Lock the ${source.label} before ${verb} its ${row.label.toLowerCase()}`,
  { status: 409, code: source.notLockedCode },
);

export function startTrackGeneration(trackId, recordId, body) {
  return withAnimationWriteTail(recordId, () => startTrackGenerationImpl(trackId, recordId, body));
}

async function startTrackGenerationImpl(trackId, recordId, body) {
  const row = effectiveTrack(trackId);
  const [record, reference, existingSet, existingRuns] = await Promise.all([
    requireTrack(recordId, row.id), loadManifest(recordId), loadSet(row.id, recordId), trackRuns(row.id, recordId),
  ]);
  if (existingSet) throw setFinalError(row);
  const direction = resolveTrackDirection(row, body.direction);
  const source = trackSourceFor(row, reference, direction);
  if (!source.locked) throw notLockedError(source, row, 'generating');
  const chromaKey = resolveChromaKey({ manifest: reference, record });
  if (!chromaKey) throw new ServerError('No frozen chroma key is available for this sprite', { status: 409, code: 'CHROMA_KEY_REQUIRED' });
  // In-flight guard, per facing for a directional track and per record for a
  // single-row one (where "another facing" doesn't exist).
  const inFlight = existingRuns.some((run) => (
    ['rendering', 'postprocessing'].includes(run.status) && (!row.directional || run.direction === direction)
  ));
  if (inFlight) {
    throw new ServerError(
      row.directional
        ? `A ${row.label.toLowerCase()} render for ${direction} is already in progress`
        : `A ${row.label.toLowerCase()} render is already in progress`,
      { status: 409, code: 'TRACK_RENDER_IN_PROGRESS' },
    );
  }

  const effectiveTracks = getEffectiveAnimationTracks();
  const frameCount = clampTrackFrameCount(body.frameCount, row.id, effectiveTracks);
  const fps = clampTrackFps(body.fps, row.id, effectiveTracks);
  // Optional re-roll note (#3134) — blank leaves the prompt and the run record
  // exactly as a blind regenerate would.
  const correctionPrompt = typeof body.correctionPrompt === 'string' ? body.correctionPrompt.trim() : '';
  // WHICH lane renders the clip (#4876) — same contract the walk lane uses, so a
  // track never needs its own provider rules. Absent → grok.
  const provider = resolveAnimationProvider(body.provider);
  const duration = resolveGrokDuration(body.duration);
  // Readiness first: an install with no runnable local model 409s here, before a
  // run record exists.
  const localPlan = provider === 'local'
    ? await planLocalAnimationRender({ durationSeconds: duration })
    : null;
  // Run ids stay in the clones' shapes: `<track>-<direction>-<uuid8>` for a
  // directional track, `<track>-<uuid8>` for a single-row one.
  const runId = row.directional
    ? `${row.id}-${direction}-${randomUUID().slice(0, 8)}`
    : `${row.id}-${randomUUID().slice(0, 8)}`;
  const runRel = runRelPath(runId);
  const generatedAbs = join(spriteDir(recordId), runRel, 'generated');
  await ensureDir(generatedAbs);
  const sourceAbs = resolveSpriteAssetPath(recordId, source.locked.path);
  if (!await pathExists(sourceAbs)) {
    throw new ServerError(
      `Locked ${source.label} file is missing on disk`,
      { status: 500, code: source.missingCode },
    );
  }
  const inputAbs = join(generatedAbs, source.inputName);
  const [{ preparation, sha256: inputSha256, canvas }, settings] = await Promise.all([
    prepareWalkAnchorChromaInput(sourceAbs, inputAbs, chromaKey, localPlan?.chooseCanvas || null),
    getSettings(),
  ]);
  const videoAbs = join(generatedAbs, SOURCE_CLIP_NAME);
  const prompt = buildTrackVideoPrompt(row.id, {
    name: record.name, kind: record.kind, direction, chromaKey, correctionPrompt,
  });
  const run = {
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    track: row.id,
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
    // `anchorPath`/`anchorSha256` name the SOURCE reference whatever it was —
    // the ambient clone already used these keys for the main reference, and the
    // approve gate's staleness check reads them, so the spelling stays.
    anchorPath: source.locked.path,
    anchorSha256: source.locked.sha256 || await sha256File(sourceAbs),
    animationInputPath: `${runRel}/generated/${source.inputName}`,
    animationInputSha256: inputSha256,
    animationInputPreparation: preparation,
    ...(correctionPrompt ? { correctionPrompt } : {}),
    createdAt: new Date().toISOString(),
    // Spread LAST so the local lane's provider/geometry provenance wins over the
    // grok defaults above. A local render is a queued media job, not a PTY, so it
    // carries `jobId` in place of an attachable `shellSession`.
    ...(localPlan ? { ...localRenderManifest(localPlan, canvas), shellSession: null } : {}),
  };
  await saveRun(recordId, run);
  if (localPlan) {
    // Queued after the record is durable, and never awaited here — the
    // boot-registered completion hook stages the clip and runs the attach. See
    // the walk lane's note: that is what survives a restart, which matters most
    // on this lane because track runs have no wall-clock backstop at all.
    const jobId = enqueueLocalAnimationRender({
      plan: localPlan, canvas, prompt, inputAbs, recordId, runId, track: row.id, direction,
    });
    run.jobId = jobId;
    await saveRun(recordId, run);
    console.log(`📡 sprite ${row.id} local render started ${recordId}/${runId} (job ${jobId.slice(0, 8)}, ${localPlan.numFrames}f @ ${localPlan.fps}fps)`);
    return row.directional
      ? { runId, direction, duration, provider: 'local', jobId }
      : { runId, duration, provider: 'local', jobId };
  }
  runTrackTuiRender(row, recordId, {
    runId,
    direction,
    generatedAbs,
    videoAbs,
    grokPath: settings.imageGen?.grok?.grokPath,
    task: buildGrokI2vTask({ prompt, inputAbs, videoAbs, duration }),
  }).catch((err) => console.error(`❌ sprite ${row.id} grok-tui render crashed ${recordId}/${runId}: ${err?.message || err}`));
  console.log(`📡 sprite ${row.id} grok-tui render started ${recordId}/${runId}`);
  return row.directional
    ? { runId, direction, duration, provider: 'grok', shellSession: runId }
    : { runId, duration, provider: 'grok', shellSession: runId };
}

async function runTrackTuiRender(row, recordId, { runId, direction, generatedAbs, videoAbs, grokPath, task }) {
  await executeTuiRun({
    runId,
    provider: grokTuiProvider(grokPath),
    prompt: task,
    workspacePath: generatedAbs,
    idleMs: GROK_TUI_IDLE_MS,
    timeout: GROK_TUI_TIMEOUT_MS,
    label: row.directional ? `sprite ${row.id} ${recordId}/${direction}` : `sprite ${row.id} ${recordId}`,
  }).catch((err) => console.error(`❌ sprite ${row.id} grok-tui run failed ${recordId}/${runId}: ${err?.message || err}`));
  await withAnimationWriteTail(recordId, () => attachTrackTuiResult(row.id, recordId, runId, videoAbs));
}

export async function attachTrackTuiResult(trackId, recordId, runId, videoAbs) {
  const row = effectiveTrack(trackId);
  const run = await loadRun(recordId, runId);
  if (!run || run.track !== row.id || await loadSet(row.id, recordId)) return;
  const selection = await loadSelection(row.id, recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) return;
  if (!await pathExists(videoAbs)) {
    run.status = 'error';
    run.postprocessError = isLocalProviderRun(run)
      ? `The local render produced no ${row.label.toLowerCase()} video — check the Render Queue for the failed job`
      : `Grok finished without writing the ${row.label.toLowerCase()} video — check the shell session output`;
    run.completedAt = new Date().toISOString();
    await saveRun(recordId, run);
    return;
  }
  run.status = 'postprocessing';
  // Anchors the packaging staleness window (normalizeStaleAnimationRun). It MUST
  // be measured from here rather than from `createdAt`: a local render can have
  // been queued hours before packaging starts, so a createdAt-anchored window
  // reports every healthy local run as interrupted the moment it begins to pack.
  run.postprocessingStartedAt = new Date().toISOString();
  run.sourceVideoPath = `${runRelPath(run.id)}/generated/${SOURCE_CLIP_NAME}`;
  await saveRun(recordId, run);
  await packageTrackRun(row, recordId, run);
  await saveRun(recordId, run);
}

async function packageTrackRun(row, recordId, run) {
  // Runs outside the request lifecycle (the TUI completion tail), so a throw
  // here would take the process down rather than reaching error middleware —
  // hence the try/catch, per the AGENTS.md boundary exception.
  try {
    const [reference, record] = await Promise.all([loadManifest(recordId), getRecord(recordId)]);
    const source = trackSourceFor(row, reference, run.direction);
    if (!source.locked) throw new Error(`No locked ${source.label} in the reference manifest`);
    const chromaKey = resolveChromaKey({ manifest: reference, record, run });
    if (!chromaKey) throw new Error(`No chroma key is available for the ${row.label.toLowerCase()} matte`);
    const runRel = runRelPath(run.id);
    const effectiveTracks = getEffectiveAnimationTracks();
    const result = await runWalkPostprocess({
      recordId,
      track: row.id,
      direction: run.direction,
      chromaKey,
      runAbs: join(spriteDir(recordId), runRel),
      runRel,
      anchorRel: source.locked.path,
      anchorAbs: resolveSpriteAssetPath(recordId, source.locked.path),
      videoAbs: resolveSpriteAssetPath(recordId, run.sourceVideoPath),
      frameCount: clampTrackFrameCount(run.frameCount, row.id, effectiveTracks),
      fps: clampTrackFps(run.fps, row.id, effectiveTracks),
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
    console.error(`❌ sprite ${row.id} postprocess failed ${recordId}/${run.id}: ${err.message}`);
  }
  run.completedAt = new Date().toISOString();
}

export function approveTrackRun(trackId, recordId, args) {
  return withAnimationWriteTail(recordId, () => approveTrackRunImpl(trackId, recordId, args));
}

async function approveTrackRunImpl(trackId, recordId, { direction: requested, runId }) {
  const row = effectiveTrack(trackId);
  await requireTrack(recordId, row.id);
  if (await loadSet(row.id, recordId)) throw setFinalError(row);
  const direction = resolveTrackDirection(row, requested);
  const label = row.label.toLowerCase();
  const run = await loadRun(recordId, runId);
  if (!run || run.track !== row.id) throw new ServerError(`Unknown ${label} run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  if (run.direction !== direction) throw new ServerError(`Run ${runId} animates '${run.direction}', not '${direction}'`, { status: 400, code: 'RUN_DIRECTION_MISMATCH' });
  if (run.status !== 'candidate' || !run.postprocessManifest) throw new ServerError('Run has no packaged candidate to approve', { status: 409, code: 'RUN_NOT_CANDIDATE' });
  const [reference, packaged] = await Promise.all([
    loadManifest(recordId), readJSONFile(resolveSpriteAssetPath(recordId, run.postprocessManifest), null),
  ]);
  const source = trackSourceFor(row, reference, direction);
  if (!source.locked) throw notLockedError(source, row, 'approving');
  if (run.anchorSha256) {
    const currentSha256 = source.locked.sha256
      || await sha256File(resolveSpriteAssetPath(recordId, source.locked.path));
    if (run.anchorSha256 !== currentSha256) {
      throw new ServerError(
        `This ${label} was rendered from an older ${source.label} — generate it again from the current reference`,
        { status: 409, code: 'RUN_ANCHOR_STALE' },
      );
    }
  }
  if (!packaged || packaged.track !== row.id || packaged.direction !== direction || packaged.characterId !== recordId
    || packaged.frameCount !== run.frameCount || packaged.frameRate !== run.fps) {
    throw new ServerError(`Packaged ${label} manifest is missing or inconsistent`, { status: 409, code: 'RUN_MANIFEST_INVALID' });
  }
  const frameCheck = await verifyPackagedFrames(recordId, packaged, { track: row.id });
  if (frameCheck.missing) throw new ServerError(
    `${frameCheck.missing} of this ${label} run's ${frameCheck.total} packaged frames are missing on disk`,
    { status: 409, code: 'RUN_FRAMES_MISSING' },
  );
  const selection = (await loadSelection(row.id, recordId)) || seedSelection(row, recordId);
  selection.directions[direction] = {
    status: 'approved',
    runId,
    runPath: runRelPath(runId),
    runManifest: run.postprocessManifest,
    runManifestSha256: await sha256File(resolveSpriteAssetPath(recordId, run.postprocessManifest)),
    approvedAt: new Date().toISOString(),
  };
  // How many facings must land before the set freezes is registry data, so a
  // single-row track freezes on its first approval and a directional one on its
  // eighth — the two clones' `allApproved` rules, unified.
  const authoringDirections = trackAuthoringDirections(row.id);
  const allApproved = authoringDirections.every((item) => selection.directions[item]?.status === 'approved');
  selection.status = allApproved ? 'complete' : 'in-progress';
  const selectionAbs = join(spriteDir(recordId), selectionRelPath(row.id, recordId));
  await ensureDir(join(spriteDir(recordId), row.id));
  await atomicWrite(selectionAbs, selection);
  if (allApproved) {
    await atomicWrite(join(spriteDir(recordId), trackSetRelPath(row.id, recordId)), {
      schemaVersion: 1,
      kind: row.setKind,
      track: row.id,
      characterId: recordId,
      status: 'final',
      directionOrder: authoringDirections,
      selectionPath: selectionRelPath(row.id, recordId),
      selectionSha256: await sha256File(selectionAbs),
      directions: selection.directions,
      finalizedAt: new Date().toISOString(),
    });
    console.log(`🏁 sprite ${row.id} set finalized for ${recordId}`);
  }
  return getTrackState(row.id, recordId);
}

/**
 * Drop one facing's approval because the reference it was rendered from changed.
 *
 * Called from the reference-unlock paths in `walk.js`: a revised anchor or a
 * regenerated turnaround must not leave a stale approved clip standing, since
 * the atlas would then compile frames drawn from an image that no longer exists.
 * Returns true when something was actually invalidated.
 */
export function invalidateTrackDirectionForAnchorRevision(trackId, recordId, { direction }) {
  return withAnimationWriteTail(recordId, () => invalidateTrackDirectionImpl(trackId, recordId, direction));
}

/** Every facing of `trackId`, for a turnaround revision that resets them all. */
export function invalidateTrackForTurnaroundRevision(trackId, recordId) {
  return withAnimationWriteTail(recordId, async () => {
    const invalidated = [];
    for (const direction of trackAuthoringDirections(trackId)) {
      // eslint-disable-next-line no-await-in-loop -- ordered: each facing's selection write must settle before the next reads it
      if (await invalidateTrackDirectionImpl(trackId, recordId, direction)) invalidated.push(direction);
    }
    return invalidated;
  });
}

/**
 * Deliberately reopen one approved facing (or the sole row of a non-directional
 * track) so a user can replace a finalized motion without revising its identity
 * source. Approved files remain on disk as superseded provenance.
 */
export function reopenTrackDirection(trackId, recordId, { direction: requested } = {}) {
  return withAnimationWriteTail(recordId, async () => {
    const row = effectiveTrack(trackId);
    await requireTrack(recordId, row.id);
    const direction = resolveTrackDirection(row, requested);
    const reopened = await invalidateTrackDirectionImpl(
      row.id,
      recordId,
      direction,
      'manual-track-revision',
    );
    if (!reopened) {
      throw new ServerError(
        `${row.label} ${row.directional ? `${direction} ` : ''}has no approved render to reopen`,
        { status: 409, code: 'TRACK_NOT_APPROVED' },
      );
    }
    return getTrackState(row.id, recordId);
  });
}

async function invalidateTrackDirectionImpl(
  trackId,
  recordId,
  direction,
  supersededReason = 'directional-anchor-revised',
) {
  const row = effectiveTrack(trackId);
  const [finalizedSet, loaded] = await Promise.all([loadSet(row.id, recordId), loadSelection(row.id, recordId)]);
  const approved = loaded?.directions?.[direction] || finalizedSet?.directions?.[direction];
  if (approved?.status !== 'approved') return false;
  const selection = loaded || { ...seedSelection(row, recordId), directions: { ...(finalizedSet?.directions || {}) } };
  if (finalizedSet) await rmGuarded(join(spriteDir(recordId), trackSetRelPath(row.id, recordId)), { force: true });
  delete selection.directions[direction];
  selection.status = 'in-progress';
  await ensureDir(join(spriteDir(recordId), row.id));
  await atomicWrite(join(spriteDir(recordId), selectionRelPath(row.id, recordId)), selection);
  const run = approved.runId ? await loadRun(recordId, approved.runId) : null;
  if (run?.track === row.id) {
    await saveRun(recordId, {
      ...run,
      status: supersededReason === 'manual-track-revision' ? 'superseded' : 'superseded-anchor',
      supersededAt: new Date().toISOString(),
      supersededReason,
    });
  }
  const reasonLabel = supersededReason === 'manual-track-revision' ? 'manual revision' : 'anchor revision';
  console.log(`♻️ sprite ${row.id} direction ${recordId}/${direction} reopened after ${reasonLabel}`);
  return true;
}
