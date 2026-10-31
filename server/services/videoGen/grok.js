/**
 * Video Gen — xAI Grok Build CLI provider (image-first flow).
 *
 * Grok has no text-to-video tool: its `image_to_video` animates a source
 * image (durations 6/10/15 s). So the flow, following grok's bundled
 * `game-animation-frames` skill, is image-first — one headless agent turn
 * that (1) generates a base image with `image_gen` when the caller didn't
 * supply one, then (2) animates it with `image_to_video`, saving the MP4 to
 * a directed scratch path PortOS harvests. When the caller supplies a
 * source image (i2v from the gallery or an upload), step 1 is skipped and
 * `image_to_video` runs on it directly.
 *
 * Mirrors the imageGen/grok.js provider's lifecycle (scratch cleanup,
 * signature sniff, tree-kill on cancel — see that module's authority note)
 * and hands the harvested file to the shared
 * `finalizeGeneratedVideo` helper so streaming optimization, thumbnailing,
 * the history entry, and the completed events all match local renders.
 *
 * The user gate is the same `imageGen.grok.enabled` toggle as image
 * generation — one Grok backend, both media kinds. The route rejects
 * disabled/missing-binary up front; this module assumes it's enabled.
 */

import { createMediaJobPreparation } from '../../lib/mediaJobPreparation.js';
import { storyboardGuidanceMeta } from './storyboardGuidance.js';
import { spawn } from '../../lib/childProcess.js';
import { mkdir, open, stat } from 'fs/promises';
import { isAbsolute, join, resolve as pathResolve, sep } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { atomicWrite, ensureDir, PATHS, copyFileGuarded, unlinkGuarded, rmGuarded } from '../../lib/fileUtils.js';
import sharp from 'sharp';
import { ServerError } from '../../lib/errorHandler.js';
import { attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer } from '../../lib/sseUtils.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { killProcessTree, prepareCliSpawn } from '../../lib/bufferedSpawn.js';
import { ensureGrokHeadlessArgs, prepareGrokPromptFile } from '../../lib/grok.js';
import { videoGenEvents } from './events.js';
import { discardUnpublishedVideo, finalizeGeneratedVideo, emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { noImageReason, deriveAspectRatio, GROK_ASPECT_RATIOS } from '../imageGen/grok.js';
import { grokVideoBillableUnits, resolveGrokDuration } from '../../lib/grokVideoClip.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';
import { probeVideoDuration } from '../../lib/ffmpeg.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { agentInstructionsAddition, carriedPromptAdditions, sentPromptRecord } from '../../lib/modelInput.js';
import { storyboardGuidanceAddition, storyboardGuidanceText } from '../../lib/storyboardGuidance.js';

// 30 minutes — an image-first video turn is two sequential tool calls
// (image_gen then image_to_video render + download), so it runs meaningfully
// longer than a single image. Keep this ABOVE the mediaJobQueue cloud-lane
// idle watchdog (20 min) — the provider emits `activity` on every stdout
// chunk (grok narrates while it works), so the idle watchdog only trips on
// a truly silent hang while this wall-clock cap bounds the whole run.
const GROK_VIDEO_TIMEOUT_MS = (() => {
  const n = Number(process.env.GROK_VIDEO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
})();

const DEFAULT_BIN = 'grok';
const DEFAULT_HARVEST_TIMEOUT_MS = 10000;
let harvestTimeoutMs = DEFAULT_HARVEST_TIMEOUT_MS;

// The clip lengths this module gates on live in lib/grokVideoClip.js — the one
// list the Zod schemas and the client picker also derive from (#3022).

// Per-job state — keyed by jobId (cloud lane allows parallel renders). Same
// client shape as videoGen/local.js so attachSseClient/broadcastSse work.
const jobs = new Map();
const activeProcs = new Map();
const activeJobs = new Map();

export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

const sigtermWithEscalation = (id, proc) => {
  if (process.platform === 'win32') {
    // prepareCliSpawn wraps a .cmd shim in cmd.exe on Windows — taskkill /T
    // the whole tree so the real grok child dies too (mirrors imageGen/grok.js).
    killProcessTree(proc);
    return;
  }
  killWithEscalation(proc, { label: 'grok video child', delayMs: 5000, stillRunning: () => activeProcs.get(id) === proc });
};

const preparations = createMediaJobPreparation();

export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error("videoGen/grok.cancel requires a jobId — use cancelAll() to terminate every in-flight render");
  }
  const pending = preparations.cancel(jobId);
  if (pending) return pending;
  const proc = activeProcs.get(jobId);
  if (!proc) return false;
  sigtermWithEscalation(jobId, proc);
  return true;
};

export const cancelAll = () => {
  const ids = [...preparations.ids(), ...activeProcs.keys()];
  if (ids.length === 0) return false;
  for (const id of ids) cancel(id);
  return true;
};

// MP4/QuickTime signature: a top-level `ftyp` box at byte offset 4. Grok is
// directed to save MP4; anything else (webm, text error, truncated file) is
// rejected rather than shipped into the gallery mislabeled.
const isMp4Header = (buf) =>
  Buffer.isBuffer(buf) && buf.length >= 8
  && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;

// Build the single-turn agent prompt for the image-first flow. Explicit about
// the tools, the save path, and staying out of everything else. Scratch cwd
// organizes output, not host authority; HTTP generation is operator-gated.
//
// A storyboard-guided render (`guidanceImagePath`) never animates the panel:
// image_edit builds a photographic first frame from the panel (layout only) and
// the references (the look), saved as first-frame.png, which image_to_video then
// animates. grok's image_gen takes no image, so the panel routes to image_edit.
export function buildGrokVideoPrompt({
  prompt, negativePrompt, aspectRatio, duration, stagingPath, sourceImagePath, scratchDir,
  guidanceImagePath = null, referenceImagePaths = [],
}) {
  const avoid = negativePrompt?.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  const ratio = aspectRatio ? `\nUse aspect_ratio "${aspectRatio}" for the ${guidanceImagePath ? 'first frame' : 'base image'}.` : '';
  let steps;
  if (guidanceImagePath) {
    const images = [guidanceImagePath, ...referenceImagePaths];
    steps = [
      `First, use your built-in image_edit tool to generate one photographic first frame and save it as ${grokFirstFramePath(scratchDir)}.`,
      `Pass these ${images.length === 1 ? 'image' : `${images.length} images`} to the tool's \`image\` array, in this order: ${images.join(', ')}`,
      storyboardGuidanceText({ guidance: guidanceImagePath, references: referenceImagePaths }),
      `Shot prompt: ${prompt.trim()}${avoid}${ratio}`,
      `Then use your built-in image_to_video tool to animate that first frame (never the storyboard panel) for ${duration} seconds, using the shot prompt as the motion description.`,
    ].join('\n');
  } else if (sourceImagePath) {
    steps = `Use your built-in image_to_video tool to animate the source image at ${sourceImagePath} for ${duration} seconds.\nMotion/direction prompt: ${prompt.trim()}${avoid}`;
  } else {
    steps = `First, use your built-in image_gen tool to generate one base image for this prompt and save it as ${join(scratchDir, 'base.png')}:\n${prompt.trim()}${avoid}${ratio}\nThen use your built-in image_to_video tool to animate that base image for ${duration} seconds, using the same prompt as the motion description.`;
  }
  return `${steps}\nSave the resulting video as an MP4 file at exactly this path: ${stagingPath}\nDo not create any other files, do not modify any code, and do not run any other tools beyond what is needed to generate the image/video and write the MP4 to that path. When the file is written, you are done.`;
}

// Where a storyboard-guided render's first frame is directed, so it can be kept beside the clip.
const grokFirstFramePath = (scratchDir) => join(scratchDir, 'first-frame.png');

/**
 * The agent prompt a grok video render sends and its record (#11317): shared by
 * the render and the Video Gen form's preview so both show the same text.
 */
export function grokVideoSentPrompt({
  prompt = '', negativePrompt, aspectRatio, width, height, duration, sourceImagePath = null, scratchDir, promptAdditions = [],
  guidanceImagePath = null, referenceImagePaths = [],
}) {
  const effectiveDuration = resolveGrokDuration(duration);
  const configured = GROK_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : null;
  const effectiveRatio = deriveAspectRatio(width, height) || configured;
  const buildWith = (text) => buildGrokVideoPrompt({
    prompt: text, negativePrompt, aspectRatio: effectiveRatio, duration: effectiveDuration,
    stagingPath: join(scratchDir, 'output.mp4'), sourceImagePath, scratchDir, guidanceImagePath, referenceImagePaths,
  });
  const fullPrompt = buildWith(prompt);
  const guidance = guidanceImagePath
    ? storyboardGuidanceAddition(storyboardGuidanceText({ guidance: guidanceImagePath, references: referenceImagePaths }))
    : null;
  return {
    fullPrompt, effectiveRatio, effectiveDuration,
    record: sentPromptRecord({ sentPrompt: fullPrompt, carried: carriedPromptAdditions({ promptAdditions }),
      added: [guidance, agentInstructionsAddition('Grok video tool instructions', buildWith)] }),
  };
}

export const generateVideo = (params) => preparations.run(params, generateVideoPrepared);

async function generateVideoPrepared({
  grokPath, aspectRatio, prompt = '', negativePrompt, width, height,
  sourceImagePath = null, duration,
  uploadedTempPath = null,
  jobId: providedJobId = null,
  promptAdditions = [],
  guidanceImagePath = null, referenceImagePaths = [],
}) {
  await ensureDir(PATHS.videos);

  // Wall-clock render timing (#5878). finalizeGeneratedVideo reads this off the
  // job; without it a grok render lands with no `renderMs` at all — the cloud
  // lane is exactly the one whose cost the user can't guess from hardware.
  // Measured from here (queue ingestion) rather than from the spawn, which is
  // what videoGen/spawnWatch.js does for local renders.
  const renderStartedAtMs = Date.now();

  if (!prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  // Per-job scratch dir doubles as the child's cwd (containment) and holds
  // both the intermediate base image and the staged MP4. Removed on every
  // terminal path.
  const scratchDir = join(tmpdir(), `portos-grok-video-${jobId}`);
  const stagingPath = join(scratchDir, 'output.mp4');
  await mkdir(scratchDir, { recursive: true });

  const { fullPrompt, effectiveRatio, effectiveDuration, record: sentRecord } = grokVideoSentPrompt({
    prompt, negativePrompt, aspectRatio, width, height, duration, sourceImagePath, scratchDir, promptAdditions,
    guidanceImagePath, referenceImagePaths,
  });

  const bin = grokPath || DEFAULT_BIN;
  const baseArgs = ensureGrokHeadlessArgs([], null);
  const { args, useStdin, cleanup: cleanupPromptFile } = prepareGrokPromptFile(baseArgs, fullPrompt);

  // History/meta shape mirrors local.js's fields that the Media History
  // consumers (normalize.js, the lightbox) actually read; grok has no
  // seed/steps/fps knobs so those stay absent. `modelId: 'grok'` tags the
  // record's engine for the grid badge and keeps Remix from offering
  // local-only dials.
  const meta = {
    id: jobId,
    prompt: prompt.trim(),
    negativePrompt: negativePrompt || '',
    modelId: 'grok',
    duration: effectiveDuration,
    ...(effectiveRatio ? { aspectRatio: effectiveRatio } : {}),
    filename,
    createdAt: new Date().toISOString(),
    mode: sourceImagePath ? 'image' : 'text',
    ...storyboardGuidanceMeta(guidanceImagePath, referenceImagePaths),
    ...sentRecord,
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}] grok`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
  emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, 'Spawning grok…');

  runGrokVideo(job, jobId, bin, args, {
    useStdin, fullPrompt, cleanupPromptFile, scratchDir, stagingPath, outputPath, filename, meta, uploadedTempPath,
  }).catch((err) => {
    console.error(`❌ grok video run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId, filename, path: `/data/videos/${filename}`, generationId: jobId,
    mode: 'grok',
    status: 'running',
  };
}

async function runGrokVideo(job, jobId, bin, args, {
  useStdin, fullPrompt, cleanupPromptFile, scratchDir, stagingPath, outputPath, filename, meta, uploadedTempPath,
}) {
  const retainOwnership = (error) => {
    maintenance.markCurrentUnsettled();
    maintenance.markResourceUnsettled('media', jobId);
    console.error(`❌ Grok video settlement failed [${jobId.slice(0, 8)}]: ${error?.message || error}`);
  };
  // The route stages a multipart source image into data/uploads and hands us
  // its path — the provider owns unlinking it on every terminal path (same
  // contract as videoGen/local.js; the queue only cleans up when the
  // provider throws before spawning, or on boot-restore of a dead job).
  let cleanupPromise;
  const cleanup = () => cleanupPromise ||= Promise.allSettled([
    Promise.resolve().then(() => cleanupPromptFile({ throwOnError: true })),
    Promise.resolve().then(() => rmGuarded(scratchDir, { recursive: true, force: true })),
    Promise.resolve().then(() => uploadedTempPath && unlinkGuarded(uploadedTempPath)),
  ]).then(results => {
    for (const result of results) {
      if (result.status === 'rejected' && result.reason?.code !== 'ENOENT') retainOwnership(result.reason);
    }
  });

  if (preparations.take(jobId)) {
    await cleanup();
    return finalizeJobFailure.canceled(job, jobId);
  }
  // Resolve a path-shaped grokPath against the PortOS cwd before the child's
  // cwd moves to the scratch dir; bare names stay bare for PATH lookup.
  const resolvedBin = (!isAbsolute(bin) && (bin.includes('/') || bin.includes(sep))) ? pathResolve(bin) : bin;
  const { command: spawnBin, args: spawnArgs } = prepareCliSpawn(resolvedBin, args);
  // Pin PWD to the spawn cwd — see withSpawnCwdEnv (#3193). grok reads
  // process.cwd(), so this is defensive rather than a live fix; it keeps every
  // scratch-dir spawn telling the child one consistent story about where it is.
  const proc = spawn(spawnBin, spawnArgs, { cwd: scratchDir, env: withSpawnCwdEnv(process.env, scratchDir), shell: false, stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  activeProcs.set(jobId, proc);

  if (useStdin) {
    proc.stdin.on('error', () => {});
    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  }

  let stdoutTail = '';
  const STDOUT_TAIL_BYTES = 8 * 1024;
  let stderrTail = '';
  const STDERR_TAIL_BYTES = 32 * 1024;
  const timeoutTimer = setTimeout(() => {
    if (activeProcs.get(jobId) === proc) {
      console.log(`⏱️ grok video timed out after ${GROK_VIDEO_TIMEOUT_MS}ms [${jobId.slice(0, 8)}]`);
      sigtermWithEscalation(jobId, proc);
    }
  }, GROK_VIDEO_TIMEOUT_MS);

  let terminalStarted = false;
  const publication = {};
  let processError;
  proc.on('error', (err) => {
    if (terminalStarted) return;
    processError = err;
    // A failed kill/send can report error while the child is still alive.
    // Keep its cancel handle (including SIGKILL escalation) until close.
    if (proc.pid) return;
    terminalStarted = true;
    clearTimeout(timeoutTimer);
    cleanup().then(() => {
      finalizeJobFailure(job, jobId, proc, `Failed to spawn ${bin}: ${err.message}`);
    }).catch(retainOwnership);
  });

  proc.stdout.on('data', (chunk) => {
    stdoutTail += chunk.toString();
    if (stdoutTail.length > STDOUT_TAIL_BYTES) stdoutTail = stdoutTail.slice(-STDOUT_TAIL_BYTES);
    emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.RENDER, 'Running…');
    // Feed the mediaJobQueue's idle watchdog — grok narrates while working,
    // so a genuinely wedged child stops emitting and still trips the 20-min
    // idle cap, while a long-but-active image_to_video render doesn't.
    videoGenEvents.emit('activity', { generationId: jobId });
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrTail += text;
    if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
    videoGenEvents.emit('activity', { generationId: jobId });
  });

  proc.on('close', async (code, signal) => {
    if (terminalStarted) return;
    terminalStarted = true;
    clearTimeout(timeoutTimer);
    try {
      if (code !== 0 || processError) {
        const reason = processError?.message || (signal ? `Killed by signal ${signal}` : `Exit code ${code}`);
        const tail = stderrTail.trim().split('\n').slice(-6).join('\n');
        await cleanup();
        return finalizeJobFailure(job, jobId, proc, `Grok video generation failed: ${reason}\n${tail}`);
      }
      const harvested = await harvestStagedVideo(stagingPath, harvestTimeoutMs);
      if (!harvested.found) {
        await cleanup();
        const prefix = harvested.invalid ? 'Grok wrote a non-MP4 file at the directed path. ' : '';
        return finalizeJobFailure(job, jobId, proc, `${prefix}${noVideoReason(stdoutTail)}`);
      }
      await copyFileGuarded(stagingPath, outputPath);
      // grok's agent picks its own image_to_video length (see grokVideoClip.js),
      // so record what it actually delivered and flag a clip that came back
      // short: that is how a 15 s request is confirmed through the CLI.
      const deliveredSec = await probeVideoDuration(outputPath).catch(() => null);
      if (Number.isFinite(deliveredSec)) {
        meta.deliveredSec = Math.round(deliveredSec * 100) / 100;
        if (deliveredSec < meta.duration - 1) console.warn(`⚠️ grok delivered ${meta.deliveredSec}s for a ${meta.duration}s request [${jobId.slice(0, 8)}]`);
      }
      try {
        const units = grokVideoBillableUnits({
          requestedSeconds: meta.duration,
          deliveredSeconds: Number.isFinite(deliveredSec) ? deliveredSec : null,
          hasSourceImage: meta.mode === 'image',
        });
        const { recordGrokVideoUsage } = await import('../grokMediaUsage.js');
        await recordGrokVideoUsage({ jobId, createdAt: meta.createdAt, ...units });
      } catch (usageErr) {
        console.error(`❌ Failed to record Grok video usage [${jobId.slice(0, 8)}]: ${usageErr.message}`);
      }
      if (meta.storyboardGuidance) await keepFirstFrame(scratchDir, jobId, meta);
      // Removing the scratch directory also removes the harvested staging file.
      await cleanup();
      if (activeProcs.get(jobId) === proc) activeProcs.delete(jobId);
      activeJobs.delete(jobId);
      // Shared finalizer: faststart optimization, thumbnail, history entry,
      // SSE complete + videoGenEvents 'completed' — identical to local
      // renders so every downstream consumer (history grid, media index,
      // completion hooks) sees the same contract.
      await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta, actualSeed: null, mutateHistory: mutateVideoHistory, publication });
      closeJobAfterDelay(jobs, jobId);
    } catch (err) {
      await cleanup();
      if (!publication.committed) await discardUnpublishedVideo({ jobId, outputPath }).catch(retainOwnership);
      retainOwnership(err);
      // A dispatch failure can follow a durable commit; preserve its bytes and
      // still surface a terminal failure past the completion idempotence guard.
      finalizeJobFailure(job, jobId, proc, `Grok video post-exit handler failed: ${err?.message || err}`, { force: true });
    }
  });
}

/**
 * A storyboard-guided clip's first frame is the still it was animated from, so
 * it joins the gallery beside the clip (`meta.firstFrameFile`). Best-effort: the
 * clip is still delivered when grok saved no frame.
 */
async function keepFirstFrame(scratchDir, jobId, meta) {
  const source = grokFirstFramePath(scratchDir);
  if (!(await stat(source).catch(() => null))?.size) {
    console.log(`⏭️ grok saved no first frame for storyboard clip [${jobId.slice(0, 8)}]`);
    return;
  }
  const filename = `${jobId}-first-frame.png`;
  try {
    await ensureDir(PATHS.images);
    // Grok may save another format under the .png name; the gallery serves PNG only.
    const png = await sharp(source).png().toBuffer();
    // Publish the image, its sidecar and its index row together, as gallery uploads do (imageGen/local.js).
    await withBackupAssetPublication(async () => {
      await Promise.all([
        atomicWrite(join(PATHS.images, filename), png),
        atomicWrite(join(PATHS.images, `${jobId}-first-frame.metadata.json`), {
          id: `${jobId}-first-frame`, prompt: meta.prompt, modelId: 'grok', mode: 'grok', createdAt: new Date().toISOString(),
          filename, storyboardGuidance: meta.storyboardGuidance, videoHistoryId: jobId,
        }),
      ]);
      const { refreshImageIndex } = await import('../imageGen/sidecarStore.js');
      await refreshImageIndex(filename);
    });
    meta.firstFrameFile = filename;
  } catch (err) {
    console.warn(`⚠️ Could not keep the storyboard clip's first frame [${jobId.slice(0, 8)}]: ${err.message}`);
  }
}

// Reuse the image provider's narration-tail formatting but with video wording.
function noVideoReason(stdoutTail = '') {
  const reason = noImageReason(stdoutTail);
  return reason
    .replace('Grok returned no image', 'Grok returned no video')
    .replace('Grok did not produce an image at the directed path', 'Grok did not produce a video at the directed path')
    .replace('the image_gen tool may be unavailable', 'the image_to_video tool may be unavailable');
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeProcs,
  label: 'grok video generation',
  events: videoGenEvents,
});

// Poll for the directed MP4 until it exists non-empty with an `ftyp` header,
// or timeoutMs elapses. { found, invalid } mirrors the image harvest —
// `invalid` means a non-empty file appeared that never matched MP4.
async function harvestStagedVideo(stagingPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawInvalid = false;
  while (Date.now() < deadline) {
    const s = await stat(stagingPath).catch(() => null);
    if (s && s.size > 0) {
      const head = Buffer.alloc(12);
      const fh = await open(stagingPath, 'r').catch(() => null);
      if (fh) {
        const { bytesRead } = await fh.read(head, 0, 12, 0).catch(() => ({ bytesRead: 0 }));
        await fh.close().catch(() => {});
        if (isMp4Header(head.subarray(0, bytesRead))) return { found: true, invalid: false };
        sawInvalid = true;
      }
    }
    const remainingMs = Math.max(1, deadline - Date.now());
    await new Promise((r) => setTimeout(r, Math.min(250, remainingMs)));
  }
  return { found: false, invalid: sawInvalid };
}

// Test-only handles (mirrors imageGen/grok.js's carve-out).
export const _internals = {
  harvestStagedVideo,
  buildGrokVideoPrompt,
  isMp4Header,
  setHarvestTimeoutForTests: (timeoutMs = DEFAULT_HARVEST_TIMEOUT_MS) => {
    harvestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_HARVEST_TIMEOUT_MS;
  },
};
