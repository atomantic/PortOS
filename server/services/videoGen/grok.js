/**
 * Video Gen — xAI Grok Build CLI provider (image-first flow).
 *
 * Grok has no text-to-video tool: its `image_to_video` animates a source
 * image (durations 6s/10s). So the flow, following grok's bundled
 * `game-animation-frames` skill, is image-first — one headless agent turn
 * that (1) generates a base image with `image_gen` when the caller didn't
 * supply one, then (2) animates it with `image_to_video`, saving the MP4 to
 * a directed scratch path PortOS harvests. When the caller supplies a
 * source image (i2v from the gallery or an upload), step 1 is skipped and
 * `image_to_video` runs on it directly.
 *
 * Mirrors the imageGen/grok.js provider's lifecycle (scratch-cwd
 * confinement, signature sniff, tree-kill on cancel — see that module's
 * containment note) and hands the harvested file to the shared
 * `finalizeGeneratedVideo` helper so streaming optimization, thumbnailing,
 * the history entry, and the completed events all match local renders.
 *
 * The user gate is the same `imageGen.grok.enabled` toggle as image
 * generation — one Grok backend, both media kinds. The route rejects
 * disabled/missing-binary up front; this module assumes it's enabled.
 */

import { spawn } from 'child_process';
import { copyFile, mkdir, open, rename, rm, stat, unlink } from 'fs/promises';
import { isAbsolute, join, resolve as pathResolve, sep } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { killProcessTree, prepareCliSpawn } from '../../lib/bufferedSpawn.js';
import { ensureGrokHeadlessArgs, prepareGrokPromptFile } from '../../lib/grok.js';
import { videoGenEvents } from './events.js';
import { finalizeGeneratedVideo } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { noImageReason, deriveAspectRatio, GROK_ASPECT_RATIOS } from '../imageGen/grok.js';

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

// Durations grok's image_to_video tool accepts, in seconds.
export const GROK_VIDEO_DURATIONS = Object.freeze([6, 10]);

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

export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error("videoGen/grok.cancel requires a jobId — use cancelAll() to terminate every in-flight render");
  }
  const proc = activeProcs.get(jobId);
  if (!proc) return false;
  sigtermWithEscalation(jobId, proc);
  return true;
};

export const cancelAll = () => {
  const entries = [...activeProcs.entries()];
  if (entries.length === 0) return false;
  for (const [id, proc] of entries) sigtermWithEscalation(id, proc);
  return true;
};

// MP4/QuickTime signature: a top-level `ftyp` box at byte offset 4. Grok is
// directed to save MP4; anything else (webm, text error, truncated file) is
// rejected rather than shipped into the gallery mislabeled.
const isMp4Header = (buf) =>
  Buffer.isBuffer(buf) && buf.length >= 8
  && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;

// Build the single-turn agent prompt for the image-first flow. Explicit about
// the tools, the save path, and staying out of everything else (the child is
// additionally cwd-confined to the scratch dir).
export function buildGrokVideoPrompt({ prompt, negativePrompt, aspectRatio, duration, stagingPath, sourceImagePath, scratchDir }) {
  const avoid = negativePrompt?.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  const ratio = aspectRatio ? `\nUse aspect_ratio "${aspectRatio}" for the base image.` : '';
  const steps = sourceImagePath
    ? `Use your built-in image_to_video tool to animate the source image at ${sourceImagePath} for ${duration} seconds.\nMotion/direction prompt: ${prompt.trim()}${avoid}`
    : `First, use your built-in image_gen tool to generate one base image for this prompt and save it as ${join(scratchDir, 'base.png')}:\n${prompt.trim()}${avoid}${ratio}\nThen use your built-in image_to_video tool to animate that base image for ${duration} seconds, using the same prompt as the motion description.`;
  return `${steps}\nSave the resulting video as an MP4 file at exactly this path: ${stagingPath}\nDo not create any other files, do not modify any code, and do not run any other tools beyond what is needed to generate the image/video and write the MP4 to that path. When the file is written, you are done.`;
}

export async function generateVideo({
  grokPath, aspectRatio, prompt = '', negativePrompt, width, height,
  sourceImagePath = null, duration,
  jobId: providedJobId = null,
}) {
  await ensureDir(PATHS.videos);

  if (!prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const effectiveDuration = GROK_VIDEO_DURATIONS.includes(Number(duration)) ? Number(duration) : GROK_VIDEO_DURATIONS[0];

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  // Per-job scratch dir doubles as the child's cwd (containment) and holds
  // both the intermediate base image and the staged MP4. Removed on every
  // terminal path.
  const scratchDir = join(tmpdir(), `portos-grok-video-${jobId}`);
  const stagingPath = join(scratchDir, 'output.mp4');
  await mkdir(scratchDir, { recursive: true });

  const derived = deriveAspectRatio(width, height);
  const configured = GROK_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : null;
  const effectiveRatio = derived || configured;

  const fullPrompt = buildGrokVideoPrompt({
    prompt, negativePrompt, aspectRatio: effectiveRatio, duration: effectiveDuration,
    stagingPath, sourceImagePath, scratchDir,
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
  };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}] grok: ${prompt.slice(0, 60)}…`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
  broadcastSse(job, { type: 'status', message: 'Spawning grok…' });

  runGrokVideo(job, jobId, bin, args, {
    useStdin, fullPrompt, cleanupPromptFile, scratchDir, stagingPath, outputPath, filename, meta,
  }).catch((err) => {
    console.log(`❌ grok video run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId, filename, path: `/data/videos/${filename}`, generationId: jobId,
    mode: 'grok',
    status: 'running',
  };
}

async function runGrokVideo(job, jobId, bin, args, {
  useStdin, fullPrompt, cleanupPromptFile, scratchDir, stagingPath, outputPath, filename, meta,
}) {
  // Resolve a path-shaped grokPath against the PortOS cwd before the child's
  // cwd moves to the scratch dir; bare names stay bare for PATH lookup.
  const resolvedBin = (!isAbsolute(bin) && (bin.includes('/') || bin.includes(sep))) ? pathResolve(bin) : bin;
  const { command: spawnBin, args: spawnArgs } = prepareCliSpawn(resolvedBin, args);
  const proc = spawn(spawnBin, spawnArgs, { cwd: scratchDir, shell: false, stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  activeProcs.set(jobId, proc);
  const removeScratch = () => rm(scratchDir, { recursive: true, force: true }).catch(() => {});

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

  proc.on('error', (err) => {
    clearTimeout(timeoutTimer);
    cleanupPromptFile();
    removeScratch();
    finalizeError(job, jobId, proc, `Failed to spawn ${bin}: ${err.message}`);
  });

  proc.stdout.on('data', (chunk) => {
    stdoutTail += chunk.toString();
    if (stdoutTail.length > STDOUT_TAIL_BYTES) stdoutTail = stdoutTail.slice(-STDOUT_TAIL_BYTES);
    broadcastSse(job, { type: 'status', message: 'Running…' });
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
    clearTimeout(timeoutTimer);
    cleanupPromptFile();
    try {
      if (code !== 0) {
        const reason = signal ? `Killed by signal ${signal}` : `Exit code ${code}`;
        const tail = stderrTail.trim().split('\n').slice(-6).join('\n');
        removeScratch();
        return finalizeError(job, jobId, proc, `Grok video generation failed: ${reason}\n${tail}`);
      }
      const harvested = await harvestStagedVideo(stagingPath, 10000);
      if (!harvested.found) {
        removeScratch();
        const prefix = harvested.invalid ? 'Grok wrote a non-MP4 file at the directed path. ' : '';
        return finalizeError(job, jobId, proc, `${prefix}${noVideoReason(stdoutTail)}`);
      }
      // Move, not copy (metadata-only when tmp and the videos dir share a
      // filesystem); copy+unlink is the cross-device fallback.
      await rename(stagingPath, outputPath).catch(async () => {
        await copyFile(stagingPath, outputPath);
        await unlink(stagingPath).catch(() => {});
      });
      removeScratch();
      if (activeProcs.get(jobId) === proc) activeProcs.delete(jobId);
      activeJobs.delete(jobId);
      // Shared finalizer: faststart optimization, thumbnail, history entry,
      // SSE complete + videoGenEvents 'completed' — identical to local
      // renders so every downstream consumer (history grid, media index,
      // completion hooks) sees the same contract.
      await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta, actualSeed: null, mutateHistory: mutateVideoHistory });
      closeJobAfterDelay(jobs, jobId);
    } catch (err) {
      removeScratch();
      finalizeError(job, jobId, proc, `Grok video post-exit handler failed: ${err?.message || err}`);
    }
  });
}

// Reuse the image provider's narration-tail formatting but with video wording.
function noVideoReason(stdoutTail = '') {
  const reason = noImageReason(stdoutTail);
  return reason
    .replace('Grok returned no image', 'Grok returned no video')
    .replace('Grok did not produce an image at the directed path', 'Grok did not produce a video at the directed path')
    .replace('the image_gen tool may be unavailable', 'the image_to_video tool may be unavailable');
}

const finalizeError = (job, jobId, proc, reason) => {
  if (job.status === 'error' || job.status === 'complete') return;
  if (proc == null || activeProcs.get(jobId) === proc) activeProcs.delete(jobId);
  job.status = 'error';
  activeJobs.delete(jobId);
  console.log(`❌ grok video generation failed [${jobId.slice(0, 8)}]: ${reason.split('\n')[0]}`);
  broadcastSse(job, { type: 'error', error: reason });
  videoGenEvents.emit('failed', { generationId: jobId, error: reason });
  closeJobAfterDelay(jobs, jobId);
};

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
    await new Promise((r) => setTimeout(r, 250));
  }
  return { found: false, invalid: sawInvalid };
}

// Test-only handles (mirrors imageGen/grok.js's carve-out).
export const _internals = {
  harvestStagedVideo,
  buildGrokVideoPrompt,
  isMp4Header,
};
