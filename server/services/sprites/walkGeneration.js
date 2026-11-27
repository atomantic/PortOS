/** Launch sprite walk renders and attach their completed video clips. */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, pathExists, sha256File } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { FINISHED_OUTPUT_ADMISSION_MS } from '../../lib/backupPublicationWait.js';
import { executeTuiRun } from '../tuiPromptRunner.js';
import { GROK_TUI_ID } from '../../lib/grok.js';
import { getSettings } from '../settings.js';
import { spriteDir, resolveSpriteAssetPath, runRelPath } from './paths.js';
import { requireCharacter, loadManifest } from './reference.js';
import { buildWalkVideoPrompt } from './prompts.js';
import { prepareWalkAnchorChromaInput } from './walkPostprocess.js';
import { WALK_TRACK } from './animationTargets.js';
import { resolveGrokDuration } from '../../lib/grokVideoClip.js';
import { GROK_TUI_IDLE_MS, GROK_TUI_TIMEOUT_MS, grokTuiProvider, buildGrokI2vTask, resolveAnimationProvider, isLocalProviderRun } from './animationWorkflow.js';
import {
  planLocalAnimationRender, enqueueLocalAnimationRender, localRenderManifest,
  activeTuiAttachments, verifyLocalAnimationAnchor, localAnimationPrompt,
} from './localAnimationRender.js';
import {
  withWalkWriteTail as walkWriteTail, loadWalkSet, loadSelection, loadRunRecord,
  saveRunRecord, requireUnfinalized,
} from './walkRecords.js';
import { getWalkState, resolveRenderGeometry, resolveWalkRenderability } from './walkState.js';
import { packageRun } from './walkPackaging.js';

// grok's walk render runs as an OBSERVABLE TUI session (issue: user wants to
// watch/course-correct grok in the Shell) rather than a headless mediaJobQueue
// spawn. The thresholds and their rationale live in animationWorkflow.js, shared
// with every other animation track, so raising the lull tolerance can't fix one
// render path and leave the rest reaping early.
const WALK_TUI_IDLE_MS = GROK_TUI_IDLE_MS;
const WALK_TUI_TIMEOUT_MS = GROK_TUI_TIMEOUT_MS;

// Which lane a run came from, for logs shared by both.
const runProviderLabel = (run) => (isLocalProviderRun(run) ? 'local' : 'grok-tui');

/**
 * Start one observable grok walk-video render for a direction whose anchor is
 * locked. User-triggered only (route-invoked); exactly one image_to_video call
 * per run — all derivatives are deterministic local work.
 *
 * grok runs as an interactive TUI session (executeTuiRun) rather than a headless
 * job so the user can pop into the Shell page to watch it, and — if needed —
 * type to course-correct or Stop it. The session id IS the run id, so the walk
 * card can deep-link to `/shell/<runId>` the moment the render starts. The
 * render itself runs OUTSIDE the per-record write tail (a ~10-min PTY run must
 * not block other walk ops); its completion re-enters the tail to attach.
 */
export function startWalkGeneration(recordId, body) {
  return walkWriteTail(recordId, () => startWalkGenerationImpl(recordId, body));
}

async function startWalkGenerationImpl(recordId, body) {
  const record = await requireCharacter(recordId);
  await requireUnfinalized(recordId);
  const direction = body.direction;
  const manifest = await loadManifest(recordId);
  const { anchor, chromaKey, error } = resolveWalkRenderability(manifest, record, direction);
  if (error) throw error();
  // Refuse a second render for a direction already in flight. A fresh runId per
  // call is the only reservation, and the client's Generate button can briefly
  // re-enable between the media-poll eviction of its optimistic key and the next
  // getWalkState refetch — without this backstop, a click in that window fires a
  // second paid grok render for the same direction. Serialized by the write tail,
  // so no TOCTOU. getWalkState normalizes a stale 'rendering' run (server died
  // mid-render) to 'error', so this blocks only a genuinely live render.
  const { runs: inFlight, walkTarget, selection } = await getWalkState(recordId);
  if (inFlight.some((r) => r.direction === direction && (r.status === 'rendering' || r.status === 'postprocessing'))) {
    throw new ServerError(`A walk render for ${direction} is already in progress`, { status: 409, code: 'WALK_RENDER_IN_PROGRESS' });
  }
  // Cycle geometry is pinned at the SET level (#2985) — every direction in one
  // atlas must share it. An omitted count/fps adopts the target; a disagreeing
  // one is refused here rather than at atlas-compile time, eight renders later.
  const { frameCount, fps } = await resolveRenderGeometry(recordId, { walkTarget, selection }, body);
  const anchorAbs = resolveSpriteAssetPath(recordId, anchor.path);
  if (!await pathExists(anchorAbs)) {
    throw new ServerError('Locked anchor file is missing on disk', { status: 500, code: 'ANCHOR_MISSING' });
  }

  // WHICH lane renders the clip (#4876). Absent → grok, so every pre-existing
  // client, persisted retry, and test renders exactly where it did before the
  // local lane existed.
  const provider = resolveAnimationProvider(body.provider);
  if (body.returnToIdleAnchor && provider !== 'local') {
    throw new ServerError('Return to idle anchor requires a local render', { status: 400, code: 'LOCAL_VIDEO_REQUIRED' });
  }
  // Clip length grok will actually deliver — a request it does not offer falls
  // back to its shortest (see lib/grokVideoClip.js). The walk's look comes from
  // frameCount/fps below, not from how much footage the packer had to pick from.
  // The local lane snaps the same request onto H3's 17n+5 frame grid instead,
  // which is why `duration` stays the shared unit rather than a grok-only field.
  const duration = resolveGrokDuration(body.duration);
  // Resolved BEFORE the run directory is created, not just before the run
  // record: an install with no runnable local model must leave NOTHING behind.
  // An empty run directory is not inert — the run scan reads it back, finds no
  // record, and (before this) took getWalkState down with it.
  const localPlan = provider === 'local'
    ? await planLocalAnimationRender({ durationSeconds: duration, returnToIdleAnchor: body.returnToIdleAnchor === true })
    : null;

  if (localPlan) await verifyLocalAnimationAnchor(anchor, anchorAbs);

  const runId = `walk-${direction}-${randomUUID().slice(0, 8)}`;
  const runRel = runRelPath(runId);
  const runAbs = join(spriteDir(recordId), runRel);
  const generatedAbs = join(runAbs, 'generated');
  await ensureDir(generatedAbs);

  // i2v motion input: the anchor composited onto the SOLID chroma matte grok
  // must animate over (NOT a transparent PNG — that made grok composite over
  // black and reinvent an off-spec magenta from the prompt text; see
  // prepareWalkAnchorChromaInput). Saved without mutating the locked anchor.
  // Overlap the input prep with the (independent) settings read.
  const inputAbs = join(generatedAbs, 'input-anchor-chroma.png');
  const [{ preparation, sha256: inputSha256, canvas }, settings] = await Promise.all([
    prepareWalkAnchorChromaInput(anchorAbs, inputAbs, chromaKey, localPlan?.chooseCanvas || null),
    getSettings(),
  ]);
  // Frame count + playback fps are the deterministic-postprocess knobs, not the
  // clip's — the provider animates the same clip regardless, and the packer
  // resamples/labels the cycle afterward. Resolved from the set target above and
  // stored on the run so the completion hook's packageRun (and any later
  // reprocess) applies exactly what the set is pinned to.
  // Optional re-roll note (#3134): appended to the motion prompt so a second
  // render can be told what the first got wrong. Trimmed here and stamped on the
  // run record below only when non-empty, so a blank note leaves both the prompt
  // and the persisted run byte-identical to a blind regenerate.
  const correctionPrompt = typeof body.correctionPrompt === 'string'
    ? (body.provider === 'local' ? body.correctionPrompt : body.correctionPrompt.trim()) : '';
  const basePrompt = buildWalkVideoPrompt({
    name: record.name, direction, chromaKey, correctionPrompt: localPlan ? undefined : correctionPrompt,
  });
  const prompt = localPlan ? localAnimationPrompt(basePrompt, correctionPrompt) : basePrompt;
  const videoAbs = join(generatedAbs, 'source-video.mp4');
  const grokPath = settings.imageGen?.grok?.grokPath;
  // Run record BEFORE the job is queued: the completion hook finds the run by
  // `runId` out of the job's own params, so the record must already exist when
  // the job can first settle. (The grok lane persists first for the mirror
  // reason — a crash between the two leaves an inert 'rendering' run rather
  // than a session the attach can't file.) `shellSession` is the id the walk
  // card deep-links to; a local render is a queued media job, not a PTY, so it
  // carries `jobId` instead — the two are mutually exclusive on purpose.
  const now = new Date().toISOString();
  const run = {
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    // Vendor recorded as metadata, not baked into the storage path — the local
    // lane stamps its own provider and stores under the same runs/ tree.
    provider: GROK_TUI_ID,
    status: 'rendering',
    id: runId,
    // The TUI run id doubles as the attachable Shell session id (executeTuiRun
    // registers the PTY under this id), so the card can link to /shell/<id>.
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
    createdAt: now,
    // Spread LAST so the local lane's provider/geometry provenance overrides the
    // grok defaults above rather than being silently overwritten by them.
    ...(localPlan ? { ...localRenderManifest(localPlan, canvas, {
      path: `${runRel}/generated/input-anchor-chroma.png`, sha256: inputSha256, prompt,
    }), shellSession: null } : {}),
  };
  await saveRunRecord(recordId, run);

  if (localPlan) {
    // Queued AFTER the record is durable. Nothing here awaits the render: the
    // boot-registered completion hook stages the clip and runs the attach, which
    // is what lets a render outlive this request, the client, and a restart.
    // A refused admission (#8325) must not strand the run at `rendering`
    // with no job behind it — settle it as an error before surfacing.
    const jobId = await enqueueLocalAnimationRender({
      plan: localPlan, canvas, prompt, inputAbs, inputSha256, recordId, runId, track: WALK_TRACK, direction,
    }).catch(async (err) => {
      Object.assign(run, { status: 'error', postprocessError: err.message, completedAt: new Date().toISOString() });
      await saveRunRecord(recordId, run);
      throw err;
    });
    // Stamped in a SECOND write so a failure here cannot strand the job: the
    // hook already has everything it needs from the job's own params, and a run
    // that misses this only degrades `localRunLiveness` to `unknown`, whose
    // wall-clock fallback still resolves it.
    run.jobId = jobId;
    await saveRunRecord(recordId, run);
    console.log(`🚶 sprite walk local render started ${recordId}/${runId} (job ${jobId.slice(0, 8)}, ${localPlan.numFrames}f @ ${localPlan.fps}fps)`);
    return { runId, direction, duration, provider: 'local', jobId };
  }

  // Fire the observable grok-tui render fire-and-forget (do NOT await — this
  // impl holds the per-record write tail, which a ~10-min render must not).
  // Completion re-enters the tail via attachTuiWalkResult; errors are captured
  // onto the run record (no request lifecycle to bubble to).
  runWalkTuiRender(recordId, {
    runId, direction, grokPath, task: buildGrokI2vTask({ prompt, inputAbs, videoAbs, duration }),
    generatedAbs, videoAbs,
  }).catch((err) => console.error(`❌ sprite walk grok-tui render crashed ${recordId}/${runId}: ${err?.message || err}`));

  console.log(`🚶 sprite walk grok-tui render started ${recordId}/${runId} (shell session ${runId})`);
  return { runId, direction, duration, provider: 'grok', shellSession: runId };
}

/**
 * Drive the observable grok-tui render to completion, then attach its result.
 * executeTuiRun spawns grok in a PTY and registers it as a Shell session under
 * `runId`; its promise resolves on success OR failure, so the attach decides
 * outcome from whether the directed MP4 actually landed on disk.
 */
async function runWalkTuiRender(recordId, { runId, direction, grokPath, task, generatedAbs, videoAbs }) {
  const provider = grokTuiProvider(grokPath);
  await executeTuiRun({
    runId,
    provider,
    prompt: task,
    workspacePath: generatedAbs,
    idleMs: WALK_TUI_IDLE_MS,
    timeout: WALK_TUI_TIMEOUT_MS,
    label: `sprite walk ${recordId}/${direction}`,
  }).catch((err) => {
    console.error(`❌ sprite walk grok-tui run failed ${recordId}/${runId}: ${err?.message || err}`);
  });
  // The lease comes first, like the completion hook's: the clip grok wrote, the
  // decoded frames and the run record naming them are one publication (#9982).
  const attachmentKey = `${recordId}/${runId}`;
  activeTuiAttachments.add(attachmentKey);
  try {
    await withBackupAssetPublication(() => walkWriteTail(recordId, () => attachTuiWalkResult(recordId, runId, videoAbs)), {
      timeoutMs: FINISHED_OUTPUT_ADMISSION_MS,
      onWait: () => console.log(`⏸️ sprite walk ${recordId}/${runId} waiting for the backup to finish before attaching`),
    });
  } finally {
    activeTuiAttachments.delete(attachmentKey);
  }
}

/**
 * Attach the finished clip and run the deterministic postprocess — shared by
 * BOTH render lanes, because everything downstream of `source-video.mp4` is
 * provider-agnostic. Guards against overwriting frozen evidence (finalized set /
 * already-approved run). The source video is already at its final path by the
 * time this runs (grok writes it there directly; the local lane copies it out of
 * the media-job output), so there is no copy here either way.
 */
export async function attachTuiWalkResult(recordId, runId, videoAbs) {
  const run = await loadRunRecord(recordId, runId);
  if (!run) {
    console.error(`❌ sprite walk run record missing for ${recordId}/${runId} — skipping attach`);
    return;
  }
  if (await loadWalkSet(recordId)) {
    console.error(`❌ sprite walk attach skipped for ${recordId}/${runId} — walk set is finalized`);
    return;
  }
  const selection = await loadSelection(recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) {
    console.error(`❌ sprite walk attach skipped for ${recordId}/${runId} — run is approved (immutable)`);
    return;
  }
  if (!await pathExists(videoAbs)) {
    run.status = 'error';
    run.postprocessError = isLocalProviderRun(run)
      ? 'The local render produced no walk video — check the Render Queue for the failed job'
      : 'Grok finished without writing the walk video — check the shell session output';
    run.completedAt = new Date().toISOString();
    await saveRunRecord(recordId, run);
    console.error(`❌ sprite walk ${runProviderLabel(run)} produced no video ${recordId}/${runId}`);
    return;
  }
  run.sourceVideoSha256 = await sha256File(videoAbs);
  run.status = 'postprocessing';
  // Anchors the packaging staleness window (normalizeStaleAnimationRun). It MUST
  // be measured from here rather than from `createdAt`: a local render can have
  // been queued hours before packaging starts, so a createdAt-anchored window
  // reports every healthy local run as interrupted the moment it begins to pack.
  run.postprocessingStartedAt = new Date().toISOString();
  await saveRunRecord(recordId, run);
  await packageRun(recordId, run);
  await saveRunRecord(recordId, run);
  console.log(`🚶 sprite walk ${runProviderLabel(run)} run ${recordId}/${runId} → ${run.status}`);
}
