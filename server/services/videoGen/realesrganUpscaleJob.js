/**
 * Local Real-ESRGAN video upscale (#19985) — the media-job lifecycle.
 *
 * `enqueueRealesrganUpscale` validates against the read-only plan and queues a
 * `video-upscale` job (`mode: 'realesrgan'`) on this machine's GPU lane;
 * `runVideoUpscale` is what the queue worker invokes and `cancel` is the hook
 * `cancelJob` reaches through `getGenModuleForJob`.
 *
 * The pass is spatial only, frame by frame, so the deliverable keeps the
 * source's cadence and timeline exactly:
 *
 *   source ─decode─▶ PNG frames ─(batches) Real-ESRGAN─▶ enhanced frames
 *          ─encode at the source frame rate─▶ segments ─concat─▶ raw video
 *          ─finalizeUpscaleOutput─▶ deliverable (source frame count, source audio)
 *
 * Batches bound the scratch disk: a 4x network writes very large frames, so
 * each batch is encoded to a lossless segment and its frames removed before
 * the next one runs.
 *
 * Same contracts as the other upscalers: the source clip and its history row
 * are never touched, a failure or cancel removes every partial output, the new
 * history row is published last inside the backup publication boundary, and
 * the kind is local-only (absent from the federation kind maps).
 */

import { mkdir, readdir, rename, rm, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  findFfmpeg, runFfmpegProcess, vfrSyncArgs, bt709TagFilter, BT709_CONTAINER_ARGS,
} from '../../lib/ffmpeg.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { videoGenEvents } from './events.js';
import { getHistoryItem } from './history.js';
import {
  publishUpscaledVideo, removeOwnedUpscaleFile, resolveQueuedUpscaleSource, resolveUpscaleMusicVideo,
} from './upscaleJobHelpers.js';
import { finalizeUpscaleOutput } from './upscaleFfmpeg.js';
import { planUpscaleHistoryItem } from './upscaleVideo.js';
import { realesrganArgs, resolveRealesrganInvocation } from './realesrganRuntime.js';
import {
  DEFAULT_REALESRGAN_MODEL, LTX_UPSCALE_JOB_KIND, REALESRGAN_JOB_MODE, REALESRGAN_MODELS, REALESRGAN_RUNTIME_ID,
} from './upscalePlan.js';

// Frames per Real-ESRGAN invocation. Small enough that a 4x batch of 1080p
// frames stays in the low gigabytes of scratch, large enough that the model
// load each invocation pays is amortized.
export const REALESRGAN_BATCH_FRAMES = 16;
const FRAME_PATTERN = '%08d.png';

const activeUpscales = new Map();

const upscaledPrompt = (prompt) => (prompt ? `${prompt} (2× Real-ESRGAN)` : '(upscaled 2× Real-ESRGAN)');

/**
 * The source frame rate as an ffmpeg rate string. Probes report a float, and
 * re-timing 23.976 as a rounded decimal would drift against the source audio
 * over a long clip, so NTSC rates are restored to their exact /1001 form.
 */
export const frameRateArg = (fps) => {
  const value = Number(fps);
  if (!(value > 0)) return null;
  if (Math.abs(value - Math.round(value)) < 1e-6) return String(Math.round(value));
  const ntsc = value * 1001;
  if (Math.abs(ntsc - Math.round(ntsc)) < 0.05) return `${Math.round(ntsc)}/1001`;
  return value.toFixed(6);
};

/**
 * Validate against the read-only plan and queue the job. Everything knowable
 * before the GPU is committed is refused here: an already-upscaled source, an
 * uninstalled or unverified runtime, and a source whose geometry or frame rate
 * cannot be measured.
 */
export async function enqueueRealesrganUpscale(historyId, {
  realesrganModel = DEFAULT_REALESRGAN_MODEL,
  musicVideo = null,
  musicVideoProjectId = null,
  sceneId = null,
} = {}) {
  const plan = await planUpscaleHistoryItem(historyId, { method: 'realesrgan', realesrganModel });
  if (plan.alreadyUpscaled) {
    throw new ServerError('Cannot upscale an already-upscaled video', { status: 400, code: 'ALREADY_UPSCALED' });
  }
  if (!plan.runtime.supported) {
    throw new ServerError(`Real-ESRGAN is not available on this install: ${plan.runtime.reason}`, { status: 501, code: 'UNSUPPORTED_RUNTIME' });
  }
  if (!plan.runtime.installed) {
    throw new ServerError(plan.runtime.reason || 'Install Real-ESRGAN before upscaling with it.', { status: 400, code: 'REALESRGAN_NOT_READY' });
  }
  if (!(plan.source.width > 0) || !(plan.source.height > 0) || !(Number(plan.source.fps) > 0)) {
    throw new ServerError(
      'The source size or frame rate could not be measured, so the upscale cannot keep its cadence.',
      { status: 400, code: 'UPSCALE_SOURCE_UNMEASURED' },
    );
  }
  const item = await getHistoryItem(plan.id);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  return enqueueJob({
    kind: LTX_UPSCALE_JOB_KIND,
    params: {
      mode: REALESRGAN_JOB_MODE,
      upscaleMethod: 'realesrgan',
      historyId: plan.id,
      // The FILENAME, re-resolved through safeUnder at run time: job params are
      // persisted and replayed, so they must not carry a usable absolute path.
      sourceFilename: item.filename,
      realesrganModel: plan.runtime.model.id,
      source: plan.source,
      target: plan.target,
      prompt: upscaledPrompt(item.prompt),
      width: plan.target.width,
      height: plan.target.height,
      numFrames: plan.target.frameCount,
      fps: plan.source.fps,
      ...resolveUpscaleMusicVideo(item, { musicVideo, musicVideoProjectId, sceneId }),
    },
  });
}

/** Cancel a running Real-ESRGAN upscale; every child process is signalled through the shared abort. */
export function cancel(jobId) {
  const entry = activeUpscales.get(jobId);
  if (!entry) return false;
  entry.canceled = true;
  entry.abort.abort();
  return true;
}

const failIfCanceled = (entry) => {
  if (entry.canceled) throw new ServerError('Upscale canceled', { status: 499, code: 'UPSCALE_CANCELED' });
};

const runStep = async (entry, { label = 'ffmpeg', failure, code, ...options }) => {
  failIfCanceled(entry);
  const result = await runFfmpegProcess({ signal: entry.abort.signal, label, ...options });
  failIfCanceled(entry);
  if (!result.ok) throw new ServerError(`${failure}: ${result.reason}`, { status: 500, code });
  return result;
};

const listFrames = async (dir) => (await readdir(dir)).filter((name) => /^\d+\.png$/.test(name)).sort();

/**
 * Enhance every extracted frame in batches and encode each batch to a lossless
 * segment at the target size. Returns the segment paths in timeline order.
 */
async function enhanceFrames({ jobId, entry, ffmpeg, invocation, workDir, frames, fps, target }) {
  const batchIn = join(workDir, 'batch-in');
  const batchOut = join(workDir, 'batch-out');
  const segmentsDir = join(workDir, 'segments');
  await mkdir(segmentsDir, { recursive: true });
  const tag = await bt709TagFilter();
  // RGB → BT.709 limited-range YUV, resampled to the 2x target when the
  // network's native scale is larger (the fixed-4x general model).
  const encodeFilter = [
    `scale=${target.width}:${target.height}:flags=lanczos:out_color_matrix=bt709:out_range=tv`,
    'format=yuv420p',
    ...(tag ? [tag] : []),
  ].join(',');
  const segments = [];
  for (let start = 0; start < frames.length; start += REALESRGAN_BATCH_FRAMES) {
    const batch = frames.slice(start, start + REALESRGAN_BATCH_FRAMES);
    await rm(batchIn, { recursive: true, force: true });
    await rm(batchOut, { recursive: true, force: true });
    await mkdir(batchIn, { recursive: true });
    await mkdir(batchOut, { recursive: true });
    for (const name of batch) await rename(join(workDir, 'frames', name), join(batchIn, name));
    await runStep(entry, {
      bin: invocation.bin,
      label: 'Real-ESRGAN',
      args: realesrganArgs({ input: batchIn, output: batchOut, ...invocation }),
      failure: 'Real-ESRGAN could not enhance the frames',
      code: 'REALESRGAN_FAILED',
    });
    const enhanced = await listFrames(batchOut);
    if (enhanced.length !== batch.length || enhanced.some((name, i) => name !== batch[i])) {
      throw new ServerError(
        `Real-ESRGAN returned ${enhanced.length} of ${batch.length} frames`,
        { status: 500, code: 'REALESRGAN_FAILED' },
      );
    }
    const segment = join(segmentsDir, `${String(segments.length).padStart(6, '0')}.mp4`);
    await runStep(entry, {
      bin: ffmpeg,
      args: [
        '-framerate', fps,
        '-start_number', String(Number.parseInt(batch[0], 10)),
        '-i', join(batchOut, FRAME_PATTERN),
        '-frames:v', String(batch.length),
        '-vf', encodeFilter,
        // Lossless intermediate: the deliverable's encode is the only lossy one.
        '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0',
        ...BT709_CONTAINER_ARGS,
        '-an', '-y', segment,
      ],
      failure: 'Could not encode the enhanced frames',
      code: 'UPSCALE_ENCODE_FAILED',
    });
    segments.push(segment);
    const done = Math.min(frames.length, start + batch.length);
    videoGenEvents.emit('progress', {
      generationId: jobId,
      progress: 0.1 + 0.8 * (done / frames.length),
      status: `Real-ESRGAN: ${done}/${frames.length} frames`,
    });
    videoGenEvents.emit('activity', { generationId: jobId });
  }
  await rm(batchIn, { recursive: true, force: true });
  await rm(batchOut, { recursive: true, force: true });
  return segments;
}

/**
 * The queue worker's entry point. Never throws: every outcome is reported on
 * `videoGenEvents` as `completed` or `failed`, which the media queue awaits
 * (a `failed` on a cancel-requested job is recorded as canceled).
 */
export async function runVideoUpscale({
  jobId, historyId, sourceFilename, realesrganModel = DEFAULT_REALESRGAN_MODEL, source, target, musicVideo = null,
}) {
  const entry = { canceled: false, abort: new AbortController() };
  activeUpscales.set(jobId, entry);
  const renderStartedAtMs = Date.now();
  // Deterministic, so a run replayed after a crash clears its predecessor's scratch.
  const workDir = join(tmpdir(), `portos-realesrgan-${jobId}`);
  let unpublishedPath = null;
  let result = null;
  let failureReason = null;
  try {
    const model = REALESRGAN_MODELS[realesrganModel];
    if (!model) throw new ServerError(`Unknown Real-ESRGAN weights '${realesrganModel}'`, { status: 400, code: 'VALIDATION_ERROR' });
    const { item, sourcePath } = await resolveQueuedUpscaleSource(historyId, sourceFilename);
    const invocation = await resolveRealesrganInvocation(model.id);
    const ffmpeg = await findFfmpeg({ requiredEncoder: 'libx264' });
    if (!ffmpeg) throw new ServerError('ffmpeg not found', { status: 500, code: 'FFMPEG_MISSING' });
    const fps = frameRateArg(source?.fps);
    if (!fps || !(target?.width > 0) || !(target?.height > 0)) {
      throw new ServerError('The queued upscale has no measured frame rate or target size.', { status: 400, code: 'UPSCALE_SOURCE_UNMEASURED' });
    }

    videoGenEvents.emit('started', {
      generationId: jobId,
      id: jobId,
      upscaledFrom: historyId,
      upscaleMethod: 'realesrgan',
      upscaleRuntime: REALESRGAN_RUNTIME_ID,
      width: target.width,
      height: target.height,
      numFrames: target.frameCount,
      fps: source.fps,
      etaMs: null,
    });
    console.log(`🔍 Upscaling video [${historyId.slice(0, 8)}] with ${model.id}: ${source.width}×${source.height} → ${target.width}×${target.height}`);

    await rm(workDir, { recursive: true, force: true });
    await mkdir(join(workDir, 'frames'), { recursive: true });
    videoGenEvents.emit('progress', { generationId: jobId, progress: 0.02, status: 'Reading frames…' });
    // Every decoded frame, in order, with no rate conversion: the frame list IS
    // the source's cadence, and its length is the deliverable's frame count.
    await runStep(entry, {
      bin: ffmpeg,
      args: ['-i', sourcePath, '-map', '0:v:0', ...await vfrSyncArgs(ffmpeg), '-y', join(workDir, 'frames', FRAME_PATTERN)],
      failure: 'Could not read the source frames',
      code: 'UPSCALE_DECODE_FAILED',
    });
    const frames = await listFrames(join(workDir, 'frames'));
    if (frames.length === 0) throw new ServerError('The source clip has no decodable frames.', { status: 400, code: 'UPSCALE_DECODE_FAILED' });

    const segments = await enhanceFrames({ jobId, entry, ffmpeg, invocation, workDir, frames, fps, target });
    const listPath = join(workDir, 'segments.txt');
    await writeFile(listPath, segments.map((path) => `file '${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const rawPath = join(workDir, 'raw.mp4');
    await runStep(entry, {
      bin: ffmpeg,
      args: ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', rawPath],
      failure: 'Could not join the enhanced segments',
      code: 'UPSCALE_ENCODE_FAILED',
    });

    videoGenEvents.emit('progress', { generationId: jobId, progress: 0.92, status: 'Restoring the source audio…' });
    const newId = randomUUID();
    const newFilename = `${newId}.mp4`;
    const deliverablePath = join(PATHS.videos, newFilename);
    unpublishedPath = deliverablePath;
    const finalized = await finalizeUpscaleOutput(rawPath, deliverablePath, {
      width: target.width,
      height: target.height,
      frameCount: frames.length,
      audioSourcePath: sourcePath,
      signal: entry.abort.signal,
    });
    failIfCanceled(entry);
    if (!finalized.ok) throw new ServerError(`Failed to finish the upscaled clip: ${finalized.reason}`, { status: 500, code: 'UPSCALE_MUX_FAILED' });

    unpublishedPath = null;
    result = await publishUpscaledVideo({
      jobId, newId, newFilename, deliverablePath, item, musicVideo, renderStartedAtMs,
      isCanceled: () => entry.canceled,
      buildFields: measured => ({
        width: measured.width ?? target.width,
        height: measured.height ?? target.height,
        fps: measured.fps ?? source.fps,
        numFrames: measured.frameCount ?? frames.length,
        upscaleMethod: 'realesrgan',
        upscaleRuntime: REALESRGAN_RUNTIME_ID,
        upscaleModel: model.id,
        prompt: upscaledPrompt(item.prompt),
      }),
      formatSuccessLog: row => `✅ Upscaled [${newId.slice(0, 8)}] with ${model.id}: ${newFilename} (${row.width}×${row.height}, ${row.numFrames} frames, ${Math.round((row.renderMs ?? 0) / 1000)}s)`,
    });
  } catch (err) {
    await removeOwnedUpscaleFile(jobId, unpublishedPath);
    const reason = entry.canceled ? 'Canceled while running' : (err?.message || 'Upscale failed');
    if (entry.canceled) console.log(`🛑 Real-ESRGAN upscale canceled [${jobId.slice(0, 8)}]`);
    else console.error(`❌ Real-ESRGAN upscale failed [${jobId.slice(0, 8)}]: ${reason}`);
    failureReason = reason;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    activeUpscales.delete(jobId);
  }
  if (failureReason) videoGenEvents.emit('failed', { generationId: jobId, error: failureReason });
  else videoGenEvents.emit('completed', { generationId: jobId, ...result });
  return result;
}
