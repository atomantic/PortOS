/**
 * Sprites — the LOCAL (MiniMax H3) animation-render lane.
 *
 * Every sprite animation track used to have exactly one way to produce its
 * source clip: an observable grok TUI session (`animationWorkflow.js`). That is
 * a paid cloud call, which made the whole sprite pipeline unusable offline even
 * though PortOS already ships MiniMax H3 locally — the MLX port on Apple Silicon
 * and the diffusers/CUDA runtime on Windows and Linux (`videoGen/runtimes.js`).
 *
 * This module is the second lane. It is deliberately NOT a second copy of the
 * pipeline: everything downstream of the clip — chroma recovery, frame
 * selection, loop trimming, geometry QC, approval, atlas compile — is the same
 * deterministic postprocess both lanes hand a `source-video.mp4` to. All that
 * differs is who renders that MP4, so the only things here are:
 *
 *   - which local model this platform can render on, and whether it is ready;
 *   - how a sprite's authoring knobs (a clip length in seconds, an anchor of
 *     arbitrary aspect) map onto H3's fixed contract (a 17n+5 frame grid at a
 *     locked 24 fps, on one of six trained canvases);
 *   - queueing one render through `mediaJobQueue` and putting the finished clip
 *     where the postprocess expects it.
 *
 * Unlike the grok lane this is NOT a PTY session, so a local run has no
 * attachable Shell session. It carries a `jobId` instead, which is both what the
 * Render Queue UI shows and — via `localRunLiveness` — how a read path tells a
 * genuinely-live multi-hour render from one the server died in the middle of.
 */

import { join } from 'path';
import { PATHS, pathExists, copyFileGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getVideoModels, requiredModelCacheGroups } from '../../lib/mediaModels.js';
import { inspectModelCache, findCachedRepoFiles } from '../../lib/hfCache.js';
import { BYOV_RUNTIME_INFO, isByovRuntimeReady } from '../videoGen/runtimes.js';
import { enqueueJob, getJob } from '../mediaJobQueue/index.js';
import { minimaxH3ControlError } from '../videoGen/minimaxH3Controls.js';
import {
  LOCAL_VIDEO_PROVIDER_ID, isLocalProviderRun, GROK_TUI_TIMEOUT_MS, runCreatedAtMs,
} from './animationWorkflow.js';
import { WALK_TRACK } from './animationTargets.js';

// H3's video VAE decodes only 17n+5 frame counts and the model runs at a fixed
// 24 fps (both enforced by `videoGen/minimaxH3Controls.js`), so a sprite's
// requested clip length can only ever be honoured approximately. 24 is read
// from the model row when it declares one so a future re-profile moves both.
const H3_FALLBACK_FPS = 24;

// Both H3 runtimes PortOS ships. A platform exposes exactly one of them
// (`getVideoModels()` already selects the mlx or cuda bucket), so this set is
// what identifies "an H3 row" inside whichever bucket is active rather than a
// platform test of its own — which is what keeps this lane working on Linux
// CUDA installs without a second branch.
const MINIMAX_H3_RUNTIME_IDS = Object.freeze(new Set(['minimax_h3', 'minimax_h3_cuda']));

/**
 * The MiniMax H3 model row this install can render on, or null.
 *
 * `getVideoModels()` has already filtered to the active platform bucket and
 * dropped anything flagged broken there, so an H3 row surviving that filter is
 * by definition the one this machine would use. Null is the honest answer for a
 * platform with no H3 build at all (and is reported as such rather than
 * collapsing into "not installed", which would send the user to an install
 * button that cannot help them).
 */
export const resolveLocalVideoModel = () => (
  getVideoModels().find((model) => MINIMAX_H3_RUNTIME_IDS.has(model.runtime)) || null
);

/** The render fps a model row is locked to (H3: 24). */
export const localRenderFps = (model) => {
  const declared = Array.isArray(model?.fpsOptions) ? Number(model.fpsOptions[0]) : NaN;
  return Number.isFinite(declared) && declared > 0 ? declared : H3_FALLBACK_FPS;
};

/**
 * The legal H3 frame count closest to `durationSeconds` of footage.
 *
 * The sprite lanes ask for a clip length in seconds because that is what grok
 * takes; H3 takes a frame count off a fixed grid. Snapping to the CLOSEST legal
 * option (rather than rounding up) matters because the grid is coarse — at 24
 * fps the MLX options step by ~0.7 s but the CUDA window starts at 124 frames,
 * so rounding a 6 s request up would cost a materially longer render for
 * footage the packer discards anyway.
 *
 * Ties go to the shorter option: two equally-close counts render for different
 * lengths of time and the cheaper one is never the wrong call for source
 * footage the postprocess is going to resample regardless.
 */
export const resolveLocalFrameCount = (model, durationSeconds) => {
  const options = (Array.isArray(model?.frameOptions) ? model.frameOptions : [])
    .map(Number)
    .filter((frames) => Number.isFinite(frames) && frames > 0)
    .sort((a, b) => a - b);
  const fallback = Number(model?.defaultFrames);
  if (!options.length) {
    return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
  }
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return options.includes(fallback) ? fallback : options[0];
  }
  const target = seconds * localRenderFps(model);
  return options.reduce((best, frames) => (
    Math.abs(frames - target) < Math.abs(best - target) ? frames : best
  ), options[0]);
};

/**
 * The trained H3 canvas whose aspect ratio is closest to the anchor's.
 *
 * H3 renders only on the six canvases its row declares, and `generateVideo`
 * conforms a conditioning image to the chosen one with
 * `scale=increase,crop` — a CENTER CROP. Handing it a portrait sprite anchor on
 * H3's 16:9 default would therefore slice the character's head and feet off
 * before the render even starts, and the geometry QC would fail every run for a
 * reason invisible in the output. Picking the nearest-aspect canvas here (and
 * padding the input to it in `prepareWalkAnchorChromaInput`) makes that crop a
 * no-op instead.
 *
 * Ties go to the SMALLER canvas: equal aspect fidelity for less render time.
 */
export const pickLocalRenderCanvas = (model, { width, height } = {}) => {
  const presets = (Array.isArray(model?.resolutionOptions) ? model.resolutionOptions : [])
    .map((preset) => ({ width: Number(preset?.w), height: Number(preset?.h) }))
    .filter((preset) => (
      Number.isFinite(preset.width) && preset.width > 0
      && Number.isFinite(preset.height) && preset.height > 0
    ));
  const fallbackWidth = Number(model?.defaultWidth);
  const fallbackHeight = Number(model?.defaultHeight);
  const fallback = Number.isFinite(fallbackWidth) && fallbackWidth > 0
    && Number.isFinite(fallbackHeight) && fallbackHeight > 0
    ? { width: fallbackWidth, height: fallbackHeight }
    : null;
  if (!presets.length) return fallback;
  const w = Number(width);
  const h = Number(height);
  // No measurable anchor: the model's declared default is the honest choice —
  // guessing an aspect from nothing would be worse than the row's own answer.
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
    return fallback || presets[0];
  }
  const wanted = w / h;
  // Compared in LOG space so "twice as wide as wanted" and "half as wide" score
  // equally — a linear difference is asymmetric and biases every portrait
  // anchor toward the landscape presets.
  const distance = (preset) => Math.abs(Math.log((preset.width / preset.height) / wanted));
  return presets.reduce((best, preset) => {
    const delta = distance(preset) - distance(best);
    if (delta < 0) return preset;
    if (delta > 0) return best;
    return preset.width * preset.height < best.width * best.height ? preset : best;
  }, presets[0]);
};

/**
 * Whether every weight `model` needs is resolvable in the HF cache.
 *
 * `requiredModelCacheGroups` is what makes this correct on BOTH platforms: the
 * MLX row pins its upstream FL2VA checkpoint in `requiredWeights`, while the
 * CUDA row pins its ~144 GB diffusers subset in `repoFiles` against its own
 * (~498 GB) repo. Checking only `requiredWeights` reported a CUDA download that
 * was interrupted after a few shards as complete, so the picker offered a render
 * that then died inside the runner's cache-only resolve.
 *
 * Still coarser than the render path's own preflight (`assertMiniMaxH3Preflight`
 * additionally verifies the pinned runtime checkout is clean). Restating THAT
 * here would be a second copy free to drift; this answers the question the UI
 * asks — "is there any point offering the button?" — and a deeper failure still
 * surfaces as a captured error on the run record naming the exact missing piece.
 */
const localModelWeightsCached = async (model) => {
  const groups = requiredModelCacheGroups(model);
  const [base, ...resolved] = await Promise.all([
    inspectModelCache(model.repo, model.revision ? { revision: model.revision } : {}),
    ...groups.map((group) => (
      group?.repo && Array.isArray(group.files) && group.files.length
        ? findCachedRepoFiles(group.repo, group.files, group.revision ? { revision: group.revision } : {})
        : Promise.resolve(null)
    )),
  ]);
  if (!base.cached) return false;
  // findCachedRepoFiles resolves to null when ANY pinned file is missing. A row
  // with no groups at all never enters this loop, so its base snapshot stands.
  return resolved.every((files) => Array.isArray(files) && files.length > 0);
};

/**
 * Readiness for the local lane, shaped for direct display.
 *
 * Always resolves — an unavailable lane is a `ready: false` plus a `reason`
 * naming the one thing to fix, never a throw. The client renders the reason
 * beside a disabled option, so "why can't I pick this?" is answered in place
 * rather than as a 409 after a click.
 */
export async function getLocalAnimationProviderStatus() {
  const model = resolveLocalVideoModel();
  if (!model) {
    return {
      id: 'local',
      label: 'Local (MiniMax H3)',
      ready: false,
      reason: 'This platform has no local MiniMax H3 video build — sprite animation renders on grok here.',
    };
  }
  const base = {
    id: 'local',
    label: 'Local (MiniMax H3)',
    modelId: model.id,
    modelName: model.name,
    runtime: model.runtime,
    fps: localRenderFps(model),
  };
  const runtimeLabel = BYOV_RUNTIME_INFO[model.runtime]?.label || model.runtime;
  if (!await isByovRuntimeReady(model.runtime)) {
    return {
      ...base,
      ready: false,
      reason: `The ${runtimeLabel} runtime is not installed — install it from Video Gen, then reload.`,
    };
  }
  if (!await localModelWeightsCached(model)) {
    return {
      ...base,
      ready: false,
      reason: `${model.name} is not downloaded — download it from Video Gen, then reload.`,
    };
  }
  return { ...base, ready: true, reason: null };
}

/**
 * Every animation provider the sprite lanes offer, in display order.
 *
 * grok reports `ready: true` unconditionally: it is the pre-existing default and
 * nothing here gates it, so claiming to know its CLI is installed would be an
 * invented gate that could only ever be wrong in the direction of hiding a
 * working button.
 */
export async function listAnimationProviders() {
  return [
    {
      id: 'grok',
      label: 'Grok (cloud)',
      ready: true,
      reason: null,
    },
    await getLocalAnimationProviderStatus(),
  ];
}

/**
 * Resolve the render plan for one local clip, or throw the 409 that says why
 * this install cannot render one.
 *
 * Called BEFORE the run record is written so an unusable lane costs the user a
 * clear error instead of an inert `error` run they then have to go delete.
 *
 * The canvas is NOT decided here — it depends on the anchor's aspect ratio, and
 * only the input-prep step measures that. The plan carries a `chooseCanvas` the
 * prep step calls with the measured size and hands back on its result, so the
 * measurement happens exactly once and the padded input and the render argv
 * cannot disagree about which canvas was picked.
 */
export async function planLocalAnimationRender({ durationSeconds } = {}) {
  const status = await getLocalAnimationProviderStatus();
  if (!status.ready) {
    throw new ServerError(status.reason, { status: 409, code: 'LOCAL_VIDEO_PROVIDER_NOT_READY' });
  }
  const model = resolveLocalVideoModel();
  const numFrames = resolveLocalFrameCount(model, durationSeconds);
  if (!numFrames) {
    throw new ServerError(
      `${model.name} declares no legal frame counts, so a local render cannot be sized.`,
      { status: 500, code: 'LOCAL_VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  const fps = localRenderFps(model);
  // Validate the plan against the RENDER BOUNDARY'S OWN gate rather than a
  // restatement of it. `data/media-models.json` is user-editable, so an install
  // that edits `fpsOptions` or the frame grid would otherwise get a plan this
  // module happily accepts and a job that 400s hours later inside the runner
  // args. Calling the real checker means every current and future H3 control
  // rule is inherited here for free instead of drifting from a local copy.
  const controlError = minimaxH3ControlError({ model, numFrames, fps });
  if (controlError) {
    throw new ServerError(
      `${model.name} cannot render this clip: ${controlError.message}`,
      { status: 500, code: 'LOCAL_VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  return {
    model,
    numFrames,
    fps,
    chooseCanvas: (anchorSize) => pickLocalRenderCanvas(model, anchorSize),
  };
}

/**
 * The provenance a local run stamps on its record, so a finished clip
 * self-documents which lane, model, runtime, and geometry produced it — the same
 * question `provider` alone answered while grok was the only lane.
 */
export const localRenderManifest = (plan, canvas) => ({
  provider: LOCAL_VIDEO_PROVIDER_ID,
  videoModelId: plan.model.id,
  videoRuntime: plan.model.runtime,
  renderFrames: plan.numFrames,
  renderFps: plan.fps,
  renderSeconds: Math.round((plan.numFrames / plan.fps) * 100) / 100,
  ...(canvas ? { renderWidth: canvas.width, renderHeight: canvas.height } : {}),
});

/**
 * The media-job params tag that makes a queued render self-describing.
 *
 * Load-bearing, not decoration: the completion hook decodes ONLY this — it holds
 * no in-memory state — so a render that outlives the request, the client, or the
 * whole server process can still be filed onto the run it belongs to. The
 * shipped `spriteWalk` tag rides along for the walk lane because the client's
 * `useSpritePendingRenders` rehydrate already keys off it (`owner: 'sprites'` +
 * `params.spriteWalk.direction`), so a browser reload mid-render shows the
 * direction as in-flight instead of re-enabling its Generate button.
 */
export const spriteAnimationJobTag = ({ recordId, runId, track, direction }) => ({
  spriteAnimation: { recordId, runId, track, direction },
  ...(track === WALK_TRACK ? { spriteWalk: { recordId, direction } } : {}),
});

/**
 * Queue the render. Returns the media-job id synchronously so the caller can
 * stamp it on an already-persisted run record.
 *
 * `hidden: true` keeps the clip out of the user's video gallery: it is an
 * intermediate the sprite pipeline consumes, not a video they asked to keep.
 * `enqueueJob` rather than `enqueueUnattendedMediaJob` is deliberate — the user
 * explicitly chose the LOCAL provider, and the unattended helper's default
 * routing could send the job to a peer instead.
 */
export function enqueueLocalAnimationRender({ plan, canvas, prompt, inputAbs, recordId, runId, track, direction }) {
  return enqueueJob({
    kind: 'video',
    // The owner the client's sprite pending-render hook filters on.
    owner: 'sprites',
    params: {
      modelId: plan.model.id,
      prompt,
      mode: 'image',
      sourceImagePath: inputAbs,
      ...(canvas ? { width: canvas.width, height: canvas.height } : {}),
      numFrames: plan.numFrames,
      fps: plan.fps,
      hidden: true,
      ...spriteAnimationJobTag({ recordId, runId, track, direction }),
    },
  }).jobId;
}

/**
 * Copy a finished render's clip to where the deterministic postprocess reads it.
 *
 * NEVER throws. The caller's contract is that the attach runs either way — the
 * attach already treats "no clip at videoAbs" as a terminal, user-visible error,
 * so a copy failure that propagated instead would skip that attach and strand
 * the run at `rendering` with nothing to move it (permanently, on the track
 * lane, whose in-flight guard then refuses every retry).
 *
 * COPY rather than move: the (hidden) gallery record generateVideo wrote still
 * points at this file, and its thumbnail sits beside it.
 */
export async function collectLocalAnimationClip({ jobId, videoAbs, label }) {
  // generateVideo names its output after the job id (`filename = ${jobId}.mp4`).
  const renderedAbs = join(PATHS.videos, `${jobId}.mp4`);
  if (!await pathExists(renderedAbs)) {
    // Expected for a genuinely failed render, and the reason the caller files
    // the run as errored — so this is informational, not an error line.
    console.log(`🎞️ ${label} has no local clip at ${renderedAbs}`);
    return false;
  }
  try {
    await copyFileGuarded(renderedAbs, videoAbs);
    return true;
  } catch (err) {
    console.error(`❌ ${label} could not stage the local clip into its run: ${err?.message || err}`);
    return false;
  }
}

/**
 * What the media-job queue says about a `rendering` local run.
 *
 * FOUR states, and collapsing any pair of them breaks something concrete:
 *
 *  - `live`     — queued or running. A local H3 clip is a multi-HOUR render, so
 *                 the grok lane's wall-clock cutoff would call this dead.
 *  - `settling` — the job COMPLETED and the attach is in flight (or the boot hook
 *                 is about to run it). Reading this as dead is the bug that
 *                 mattered: the attach spends a second or two copying and
 *                 hashing a 20–80 MB clip, and a detail poll landing in that gap
 *                 would report a SUCCESSFUL render as "interrupted" — and, worse,
 *                 unblock the in-flight guard so a second multi-hour render could
 *                 be started for the same direction.
 *  - `dead`     — failed or canceled, including the `interrupted by restart` the
 *                 queue stamps on a job that was running when the server died.
 *  - `unknown`  — no job id, or a job the archive has rolled past. NOT `dead`:
 *                 that would error a live run the moment its job aged out.
 *
 * Only `dead` is decided here; `settling` and `unknown` defer to the caller's
 * wall clock, which is generous enough that the boot hook wins the race.
 */
export const localRunLiveness = (run) => {
  const jobId = run?.jobId;
  if (typeof jobId !== 'string' || !jobId) return 'unknown';
  const job = getJob(jobId);
  if (!job) return 'unknown';
  if (job.status === 'completed') return 'settling';
  if (job.status === 'failed' || job.status === 'canceled') return 'dead';
  return 'live';
};

// How long a GROK run may sit at `rendering` before a read treats it as
// stranded: its TUI hard cap plus a buffer. Past that the session and its
// completion handler can only have died with the process.
const GROK_RENDER_STALE_MS = GROK_TUI_TIMEOUT_MS + 60_000;
// The LOCAL lane's equivalent, used only when the media-job queue cannot answer
// for a run — it has no job id, its job has rolled out of the archive, or the
// job COMPLETED and its attach has not landed yet. Deliberately a day rather
// than grok's half hour: a local H3 clip is a multi-HOUR render on current
// Apple Silicon, and the completion hook wins this race in every normal case.
const LOCAL_RENDER_STALE_MS = 24 * 60 * 60_000;
// How long a run of EITHER lane may sit at `postprocessing`. Unlike a render,
// packaging is bounded local CPU work measured in minutes, so grok's window is
// already generous and the lane makes no difference to it — but it is measured
// from `postprocessingStartedAt`, NOT `createdAt`; see the branch below.
const PACKAGING_STALE_MS = GROK_RENDER_STALE_MS;

/**
 * Read-time normalization of a run stuck at `rendering`, shared by both lanes
 * and never persisted.
 *
 * A run's status is flipped to a terminal state by its attach. So a run still
 * `rendering` long past when that could have happened is stranded — the server
 * died mid-render, and the in-memory session or awaiter went with it. Presenting
 * it as an error at read time is what stops the UI polling forever, surfaces
 * regenerate, and releases the in-flight guard that would otherwise refuse every
 * retry for that facing.
 *
 * For a LOCAL run the media-job queue is a better signal than the clock: it
 * persists and rehydrates across restarts, so it answers correctly both for a
 * render that has legitimately been going for hours and for one whose server
 * died. Only `dead` (failed / canceled, including the queue's own "interrupted
 * by restart") decides anything here:
 *
 *  - `settling` — the job finished and the attach is copying and hashing a
 *    20–80 MB clip — must NOT read as dead, or a poll landing in that window
 *    reports a SUCCESSFUL render as interrupted and, worse, unblocks the
 *    in-flight guard so a second multi-hour render can start for the same facing.
 *  - `unknown` must not either, or a live run errors the moment its job ages out
 *    of the archive.
 *
 * Both fall through to the (generous) local clock, which is the backstop for the
 * cases the completion hook cannot reach at all: an archive pruned while the
 * server was down for longer than its TTL, or an attach that threw.
 */
export const normalizeStaleAnimationRun = (run, errorMessage) => {
  // `postprocessing` needs the same treatment as `rendering`, and a TIGHTER
  // window: it is bounded LOCAL work (decode the clip, align, despill, pack), so
  // a run still in it long afterwards means the process doing that work died.
  // Both in-flight guards count `postprocessing` as busy, so without this a run
  // interrupted mid-package makes its facing permanently unrenderable — the same
  // dead end `rendering` had, one state further along. Both lanes, because the
  // packaging is identical on both.
  if (run?.status === 'postprocessing') {
    // Measured from when PACKAGING started, not from when the render was queued.
    // A local render can precede its packaging by hours, so a createdAt-anchored
    // window would report every healthy local run as interrupted the instant it
    // began to pack — and, because the in-flight guards read this normalized
    // status, would release them and invite a second multi-hour render for a
    // facing that already has a good candidate. Records written before this
    // field existed fall back to `createdAt`, which is what they were measured
    // against anyway.
    const startedAt = run.postprocessingStartedAt ?? run.createdAt;
    return Date.now() - runCreatedAtMs(startedAt) <= PACKAGING_STALE_MS
      ? run
      : { ...run, status: 'error', postprocessError: errorMessage };
  }
  if (run?.status !== 'rendering') return run;
  const local = isLocalProviderRun(run);
  if (local) {
    const liveness = localRunLiveness(run);
    if (liveness === 'live') return run;
    if (liveness === 'dead') return { ...run, status: 'error', postprocessError: errorMessage };
  }
  const staleAfterMs = local ? LOCAL_RENDER_STALE_MS : GROK_RENDER_STALE_MS;
  if (Date.now() - runCreatedAtMs(run.createdAt) <= staleAfterMs) return run;
  return { ...run, status: 'error', postprocessError: errorMessage };
};
