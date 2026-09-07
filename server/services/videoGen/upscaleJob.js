/**
 * Generative video upscale — the media-job lifecycle (#6511).
 *
 * The Lanczos pass is an inline ffmpeg filter, so `upscaleVideo.js` runs it
 * during the request. A generative pass is a multi-minute GPU render, so it
 * goes through `mediaJobQueue` instead: `enqueueLtxUpscale` validates and
 * queues, `runVideoUpscale` is what the queue worker invokes, and `cancel` is
 * the hook `cancelJob` reaches through `getGenModuleForJob`.
 *
 * Two contracts govern everything here:
 *
 *  - **The source is never touched.** Cancellation, a probe failure, a render
 *    failure and a mux failure all leave the source clip and its history row
 *    byte-identical and remove every partial output. That mirrors the Lanczos
 *    path's copy-then-transform shape: the deliverable is a NEW file and a NEW
 *    history row, or it does not exist at all.
 *  - **Local only.** `LTX_UPSCALE_JOB_KIND` is deliberately absent from the
 *    federation layer's kind maps, so the source video cannot be offered to a
 *    peer. See the privacy rules in AGENTS.md.
 */

import { existsSync } from 'fs';
import { randomUUID, randomInt } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  safeUnder, generateThumbnail, probeVideoStreamInfo, probeVideoDuration,
} from '../../lib/ffmpeg.js';
import { createLineReader } from '../../lib/streamLines.js';
import { spawnDetached } from '../../lib/detachedSpawn.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import { PYTHON_NOISE_RE } from '../../lib/sseUtils.js';
import { omitRenderTiming, renderTimingFields } from '../../lib/renderTiming.js';
import { resolveIcLoraWeightByKey } from '../../lib/icLoraWeights.js';
import { hfChildEnv } from '../hfToken.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { videoGenEvents } from './events.js';
import { getHistoryItem, loadHistory, mutateVideoHistory } from './history.js';
import { buildArgs } from './renderArgs.js';
import { runtimeIsCacheOnly, runtimeNeedsProcessGroupKill } from './runtimes.js';
import { padSourceForUpscale, finalizeUpscaleOutput } from './upscaleFfmpeg.js';
import { planUpscaleHistoryItem } from './upscaleVideo.js';
import {
  LTX_UPSCALE_JOB_KIND, LTX_UPSCALE_WEIGHT_KEY, UPSCALE_SCALE,
  ltxAlignmentBlocker, ltxAlignmentIsNoop,
} from './upscalePlan.js';

const MAX_SEED = 2 ** 32 - 1;
const STAGE_RE = /^STAGE:\s*(\S+)\s*(.*)$/;
// Both runners emit these once, before the pipeline loads: the runtime
// fingerprint (`scripts/_runner_common.py emit_runtime_fingerprint`) and the
// adapter's `reference_downscale_factor` read off the weight. They are
// provenance, so they are captured here and written onto the history row —
// a render can then be tied to the exact ltx/mlx/torch + chip stack and the
// factor it enforced, the way a plain render's row carries `runtime`.
const RUNTIME_PREFIX = 'RUNTIME:';
const REFERENCE_DOWNSCALE_RE = /^UPSCALE_REFERENCE_DOWNSCALE:\s*(\d+)\s*$/;
const STDERR_TAIL_LINES = 20;

// jobId → the in-flight run's cancel handles. Module-local rather than the
// shared `videoJobState`, because an upscale child is not a render child: the
// GPU lane already serializes the two, and mixing them would let a plain
// `videoGen.cancel()` kill an upscale (and vice versa) with no job id to
// discriminate on.
const activeUpscales = new Map();

// Same suffix convention the Lanczos pass uses, so the gallery reads
// "<original prompt> (2×)" whichever method produced the row.
const upscaledPrompt = (prompt) => (prompt ? `${prompt} (2×)` : '(upscaled 2×)');

/**
 * Validate an upscale request and queue it. Everything that can be known
 * before a GPU is committed is checked HERE — an unsupported/uninstalled
 * runtime, a missing adapter, a missing base checkpoint, and a source the model
 * grid cannot take without losing duration — so a refusal is an immediate
 * 4xx/501 rather than a job that fails minutes later.
 */
export async function enqueueLtxUpscale(historyId) {
  const plan = await planUpscaleHistoryItem(historyId, { method: 'ltx' });
  if (plan.alreadyUpscaled) {
    throw new ServerError('Cannot upscale an already-upscaled video', { status: 400, code: 'ALREADY_UPSCALED' });
  }
  if (!plan.runtime.supported || !plan.runtime.installed) {
    throw new ServerError(
      `Generative upscale is not available on this install: ${plan.runtime.reason}`,
      { status: 501, code: 'UNSUPPORTED_RUNTIME' },
    );
  }
  // Cache-only resolve (#6508): a `requiresPreDownload` weight never falls back
  // to a repo id, so an un-cached adapter is a refusal here rather than a
  // silent multi-hundred-MB pull inside the render.
  const adapter = await resolveIcLoraWeightByKey(LTX_UPSCALE_WEIGHT_KEY);
  if (!adapter?.path) {
    throw new ServerError(
      `${plan.adapter.label} is not downloaded — download it from the model panel before upscaling.`,
      { status: 400, code: 'IC_LORA_WEIGHT_UNRESOLVED' },
    );
  }
  // The runner is never allowed to resolve its own checkpoint: every LTX loader
  // falls back to `snapshot_download` for a path it cannot stat, which for this
  // pack is an unannounced ~68 GB pull inside a render. Resolved here, cache-only,
  // so a missing pack is a refusal before the GPU is committed.
  if (!plan.baseModel?.cached || !plan.baseModel.path) {
    throw new ServerError(
      plan.baseModel?.reason || 'The LTX-2.5 model pack for this backend is not downloaded.',
      { status: 400, code: 'UPSCALE_BASE_MODEL_UNRESOLVED' },
    );
  }
  const blocker = ltxAlignmentBlocker(plan.alignment);
  if (blocker) {
    throw new ServerError(blocker, { status: 400, code: 'UPSCALE_SOURCE_UNALIGNABLE' });
  }
  // The frame rate is not part of the spatial grid, but the plan cannot be
  // APPLIED without it: it sets the duration of the padded tail and is a
  // required runner argument. An unmeasured rate is the same refusal.
  if (!(Number(plan.source.fps) > 0)) {
    throw new ServerError(
      'The source frame rate could not be measured, so the padded tail and the render frame rate cannot be set.',
      { status: 400, code: 'UPSCALE_SOURCE_UNALIGNABLE' },
    );
  }
  // Read back for the two fields the plan projection deliberately omits (it is
  // a geometry/capability disclosure, not a row dump).
  const item = await getHistoryItem(plan.id);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  return enqueueJob({
    kind: LTX_UPSCALE_JOB_KIND,
    params: {
      historyId: plan.id,
      // The FILENAME, not an absolute path: job params are persisted and
      // replayed, and `runVideoUpscale` re-resolves them through `safeUnder`
      // so a hand-edited media-jobs.json cannot point the render (or the
      // audio re-mux) at a file outside data/videos.
      sourceFilename: item.filename,
      method: 'ltx',
      runtime: plan.runtime.id,
      adapterKey: plan.adapter.key,
      adapterPath: adapter.path,
      // The resolved snapshot directory, not the repo id — see the refusal above.
      baseModelPath: plan.baseModel.path,
      // Explicit, from the weight registry — the Python helper is never allowed
      // to carry its own copy of these bounds (see buildLtxUpscaleArgs).
      icMinReferences: adapter.spec.minReferences,
      icMaxReferences: adapter.spec.maxReferences,
      seed: randomInt(0, MAX_SEED + 1),
      source: plan.source,
      alignment: plan.alignment,
      target: plan.target,
      // Projected by sanitizeJob, so the Render Queue names what is being
      // upscaled instead of showing an unlabeled row.
      prompt: upscaledPrompt(item.prompt),
      width: plan.target.width,
      height: plan.target.height,
      numFrames: plan.target.frameCount,
      fps: plan.source.fps,
    },
  });
}

// Cancel the running upscale for `jobId`. Called by mediaJobQueue's cancelJob
// and by its idle watchdog; both then read the resulting child death as the
// job's terminal state.
export function cancel(jobId) {
  const entry = activeUpscales.get(jobId);
  if (!entry) return false;
  entry.canceled = true;
  entry.abort.abort();
  if (entry.proc) {
    killWithEscalation(entry.proc, {
      label: 'video upscale child',
      stillRunning: () => activeUpscales.get(jobId)?.proc === entry.proc,
    });
  }
  return true;
}

// Build the child env for the upscale runner, mirroring the render path: no
// inherited PYTHONPATH (the venv owns its site-packages), unbuffered stdio so
// STAGE lines reach the watchdog as they happen, and no ambient HF credential
// for a cache-only runtime that must never reach the network.
const upscaleChildEnv = async (runtime) => {
  const cacheOnly = runtimeIsCacheOnly(runtime);
  const env = cacheOnly ? safeChildProcessEnv() : await hfChildEnv();
  delete env.PYTHONPATH;
  env.PYTHONUNBUFFERED = '1';
  if (cacheOnly) {
    delete env.HF_TOKEN;
    delete env.HUGGING_FACE_HUB_TOKEN;
    env.HF_HUB_DISABLE_IMPLICIT_TOKEN = '1';
    env.HF_HUB_OFFLINE = '1';
    env.TRANSFORMERS_OFFLINE = '1';
  }
  return env;
};

/**
 * Spawn the upscale runner and settle when it exits.
 *
 * Resolves `{ ok }` rather than rejecting so every terminal path in
 * `runVideoUpscale` converges on the same cleanup. Non-noise child output is
 * forwarded as `activity` so the queue's idle watchdog measures real silence,
 * and `STAGE:` markers become status frames the UI can name.
 */
const runUpscaleChild = async ({ jobId, bin, args, runtime, entry }) => {
  // A cancel that landed while the alignment pass was still running has no
  // child to kill yet, so it is honored HERE rather than letting the runner
  // start and burn a GPU on work nobody is waiting for.
  if (entry.canceled) return { ok: false, reason: 'canceled before the runner started' };
  const proc = await spawnDetached(bin, args, {
    env: await upscaleChildEnv(runtime),
    controlDir: join(PATHS.videos, '.detached', jobId),
    cleanup: true,
    killProcessGroup: runtimeNeedsProcessGroupKill(runtime),
  });
  entry.proc = proc;
  // …and a cancel that landed during the spawn itself: the handle exists now,
  // so signal it immediately instead of waiting for a render nobody wants.
  if (entry.canceled) cancel(jobId);
  const stderrTail = [];
  const provenance = { runtime: null, referenceDownscale: null };
  const onLine = (line, isStderr) => {
    const text = String(line).trim();
    if (!text || PYTHON_NOISE_RE.test(text)) return;
    if (isStderr) {
      stderrTail.push(text);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
    videoGenEvents.emit('activity', { generationId: jobId });
    if (text.startsWith(RUNTIME_PREFIX)) {
      // A malformed payload stays in the stderr tail rather than becoming a
      // half-parsed fingerprint on the row.
      try { provenance.runtime = JSON.parse(text.slice(RUNTIME_PREFIX.length)); } catch { /* keep null */ }
      return;
    }
    const downscale = REFERENCE_DOWNSCALE_RE.exec(text);
    if (downscale) {
      provenance.referenceDownscale = Number(downscale[1]);
      return;
    }
    const stage = STAGE_RE.exec(text);
    if (stage) {
      videoGenEvents.emit('status', { generationId: jobId, phase: stage[1], message: stage[2] || stage[1] });
    }
  };
  const outReader = createLineReader((l) => onLine(l, false));
  const errReader = createLineReader((l) => onLine(l, true));
  proc.stdout.on('data', (c) => outReader.push(c));
  proc.stderr.on('data', (c) => errReader.push(c));
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      outReader.flush();
      errReader.flush();
      resolve(result);
    };
    proc.on('error', (err) => settle({ ok: false, reason: `spawn failed: ${err.message}` }));
    proc.on('close', (code, signal) => {
      if (code === 0) { settle({ ok: true, ...provenance }); return; }
      const tail = stderrTail.slice(-4).join(' | ');
      const how = signal ? `killed (${signal})` : `exit ${code}`;
      settle({ ok: false, reason: tail ? `upscale runner ${how}: ${tail}` : `upscale runner ${how}` });
    });
  });
};

/**
 * The queue worker's entry point. Never throws — every outcome is reported on
 * `videoGenEvents` as `completed` or `failed`, which is the terminal signal
 * `mediaJobQueue`'s dispatcher awaits. A `failed` on a job whose cancel was
 * requested is mapped to `canceled` by the queue, so this does not need to
 * distinguish them on the wire.
 */
export async function runVideoUpscale({
  jobId, historyId, sourceFilename, runtime, adapterPath, adapterKey, baseModelPath,
  icMinReferences, icMaxReferences, seed, source, alignment, target,
}) {
  const entry = { canceled: false, proc: null, abort: new AbortController() };
  activeUpscales.set(jobId, entry);
  const renderStartedAtMs = Date.now();
  // Every path this run might create, so a failure at ANY step removes all of
  // them. The source clip is never in this list.
  const scratch = [];
  let deliverablePath = null;
  let thumbnailPath = null;
  try {
    // Re-read the row rather than trusting the enqueue-time snapshot: a queued
    // job can wait behind a long render, and the user may have deleted or
    // already upscaled the source in the meantime.
    const history = await loadHistory();
    const item = history.find((h) => h.id === historyId);
    if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
    if (item.upscaledFrom) {
      throw new ServerError('Cannot upscale an already-upscaled video', { status: 400, code: 'ALREADY_UPSCALED' });
    }
    // Re-resolve the queued filename through safeUnder rather than trusting the
    // persisted string: media-jobs.json is replayed on boot and hand-editable,
    // and this path is handed to both the render and the audio re-mux.
    if (item.filename !== sourceFilename) {
      throw new ServerError('The source clip was replaced while this upscale was queued.', { status: 409, code: 'UPSCALE_SOURCE_CHANGED' });
    }
    const sourcePath = safeUnder(PATHS.videos, sourceFilename);
    if (!sourcePath || !existsSync(sourcePath)) {
      throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });
    }

    videoGenEvents.emit('started', {
      generationId: jobId,
      id: jobId,
      upscaledFrom: historyId,
      upscaleMethod: 'ltx',
      upscaleRuntime: runtime,
      width: target.width,
      height: target.height,
      numFrames: target.frameCount,
      fps: source.fps,
      seed,
      etaMs: null,
    });
    console.log(`🔍 Upscaling video [${historyId.slice(0, 8)}] on ${runtime}: ${source.width}×${source.height} → ${target.width}×${target.height}`);

    // Apply exactly #6509's plan: pad to the grid, never crop, never trim. A
    // conforming source skips the pass entirely and is READ in place.
    let referencePath = sourcePath;
    if (!ltxAlignmentIsNoop(alignment)) {
      referencePath = join(tmpdir(), `portos-upscale-src-${jobId}.mp4`);
      scratch.push(referencePath);
      const padded = await padSourceForUpscale(sourcePath, referencePath, {
        width: alignment.paddedSource.width,
        height: alignment.paddedSource.height,
        padFrames: alignment.padFrames,
        fps: source.fps,
        signal: entry.abort.signal,
      });
      if (!padded.ok) {
        throw new ServerError(`Failed to align the source clip: ${padded.reason}`, { status: 500, code: 'UPSCALE_ALIGN_FAILED' });
      }
    }

    const renderPath = join(tmpdir(), `portos-upscale-out-${jobId}.mp4`);
    scratch.push(renderPath);
    const { bin, args } = buildArgs({
      upscale: {
        runtime,
        sourceVideoPath: referencePath,
        baseModelPath,
        icLoraWeightPath: adapterPath,
        icMinReferences,
        icMaxReferences,
        width: target.width,
        height: target.height,
        numFrames: target.frameCount,
        fps: source.fps,
        seed,
      },
      outputPath: renderPath,
    });
    const rendered = await runUpscaleChild({ jobId, bin, args, runtime, entry });
    if (!rendered.ok) {
      throw new ServerError(rendered.reason, { status: 500, code: 'UPSCALE_RENDER_FAILED' });
    }
    if (entry.canceled) {
      throw new ServerError('Upscale canceled', { status: 499, code: 'UPSCALE_CANCELED' });
    }
    if (!existsSync(renderPath)) {
      throw new ServerError('The upscale runner exited cleanly but wrote no video.', { status: 500, code: 'UPSCALE_RENDER_FAILED' });
    }

    // Crop the alignment padding back off, trim the cloned tail frames, and
    // re-mux the ORIGINAL clip's audio at offset zero. A source with no audio
    // track yields a silent deliverable, not a failure.
    const newId = randomUUID();
    const newFilename = `${newId}.mp4`;
    deliverablePath = join(PATHS.videos, newFilename);
    const finalized = await finalizeUpscaleOutput(renderPath, deliverablePath, {
      width: source.width * UPSCALE_SCALE,
      height: source.height * UPSCALE_SCALE,
      frameCount: source.frameCount,
      audioSourcePath: sourcePath,
      signal: entry.abort.signal,
    });
    if (!finalized.ok) {
      throw new ServerError(`Failed to finish the upscaled clip: ${finalized.reason}`, { status: 500, code: 'UPSCALE_MUX_FAILED' });
    }

    // Provenance is MEASURED off the deliverable, not assumed from the plan —
    // a generative render is the one upscale method whose output can legally
    // differ from 2× the source, so a recorded guess would be a lie.
    const [measured, duration] = await Promise.all([
      probeVideoStreamInfo(deliverablePath),
      probeVideoDuration(deliverablePath),
    ]);
    const thumbnail = await generateThumbnail(deliverablePath, newId);
    // Tracked so a failure between here and the history write cannot leave a
    // poster for a clip that does not exist.
    thumbnailPath = thumbnail ? safeUnder(PATHS.videoThumbnails, thumbnail) : null;
    const newEntry = {
      ...omitRenderTiming(item),
      id: newId,
      filename: newFilename,
      thumbnail,
      createdAt: new Date().toISOString(),
      width: measured.width ?? source.width * UPSCALE_SCALE,
      height: measured.height ?? source.height * UPSCALE_SCALE,
      fps: measured.fps ?? source.fps,
      numFrames: measured.frameCount ?? source.frameCount,
      duration,
      seed,
      upscaledFrom: item.id,
      upscaleMethod: 'ltx',
      upscaleRuntime: runtime,
      upscaleAdapter: adapterKey,
      // Measured by the runner off the weight it fused, and the rule it
      // enforced — null when the runner did not report one.
      upscaleReferenceDownscale: rendered.referenceDownscale ?? null,
      // Same shape a plain render's row carries: the exact ltx/mlx/torch +
      // chip + OS stack this clip rendered on. Absent when not reported.
      ...(rendered.runtime ? { runtime: rendered.runtime } : {}),
      // What the grid actually required of this source, kept beside the result
      // so a reader can tell a padded render from a conforming one.
      upscaleAlignment: {
        padWidth: alignment.padWidth,
        padHeight: alignment.padHeight,
        padFrames: alignment.padFrames,
        trimFrames: alignment.trimFrames,
      },
      prompt: upscaledPrompt(item.prompt),
      hidden: false,
      ...renderTimingFields(renderStartedAtMs),
    };
    await mutateVideoHistory((h) => { h.unshift(newEntry); return h; });
    console.log(`✅ Upscaled [${newId.slice(0, 8)}]: ${newFilename} (${newEntry.width}×${newEntry.height}, ${Math.round((newEntry.renderMs ?? 0) / 1000)}s)`);
    videoGenEvents.emit('completed', { generationId: jobId, ...newEntry });
    return newEntry;
  } catch (err) {
    // The history row is written LAST, so nothing here can orphan one — only a
    // partial file can exist, and it is removed before the failure is reported.
    for (const path of [deliverablePath, thumbnailPath]) {
      if (path) await unlinkGuarded(path).catch(() => {});
    }
    const reason = entry.canceled ? 'Canceled while running' : (err.message || 'Upscale failed');
    console.log(`❌ Video upscale ${entry.canceled ? 'canceled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
    videoGenEvents.emit('failed', { generationId: jobId, error: reason });
    return null;
  } finally {
    for (const path of scratch) await unlinkGuarded(path).catch(() => {});
    activeUpscales.delete(jobId);
  }
}
