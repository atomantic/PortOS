/** Multi-chunk local-video orchestration. */

import { unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { probeFrameCount, trimVideoFromFrame } from '../../lib/ffmpeg.js';
import {
  resolveContextFrames, resolveContinuityStrategy, extendLatentFrames,
  contextPrefixFrames, tailWindowStartFrame,
} from '../../lib/videoContinuity.js';
import { broadcastSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { loadHistory, mutateVideoHistory } from './history.js';
import { videoChainUnsupportedError } from './modeContract.js';
import { estimateRenderMs } from './eta.js';
import {
  resolveVideoSpeedProfileForModes, speedProfileDeclineReasonForModes,
  resolveVideoSampler, inferEffectiveVideoMode,
} from '../../lib/videoSpeedProfiles.js';
import { videoJobState } from './jobState.js';
import { DEFAULT_NUM_FRAMES, resolveVideoDimensions } from './renderArgs.js';
import { extractLastFrame } from './frameExtraction.js';
import { stitchVideos } from './stitchVideos.js';
import { generateVideo, resolveVideoModel, defaultVideoModelId } from './generateVideo.js';

// Generate a chain of N video chunks, each conditioned on the one before it,
// then stitch them into a single longer clip. Reports progress + terminal
// events against the OUTER jobId (so the mediaJobQueue's dispatcher sees one
// logical job through the chain) while each inner chunk runs as a normal
// generateVideo() with its own inner jobId, file, and history entry.
//
// Continuation strategy (`lib/videoContinuity.js`, tunable via
// `contextFrames`):
//
//   'window' — chunk N+1 is an `extend` render conditioned on a clip cut from
//     the last `contextFrames` frames of chunk N, so the model inherits the
//     scene's MOTION, not just its final pose. Requires a runtime with an
//     extend pipeline (ltx2 today) and applies whatever mode the chain started
//     in. Because extend returns `source + extension`, each windowed chunk
//     opens with an echo of the window; that echo is measured and dropped
//     inside the stitch's concat filter graph, so the timeline holds each
//     frame exactly once while the chunk files stay as the model rendered
//     them.
//   'frame' — the historical hop: extract chunk N's last frame and run chunk
//     N+1 as image-to-video off that still. What every other runtime gets, and
//     what `contextFrames: 0` opts back into.
//
// On completion the inner chunk entries are hidden so only the stitched clip
// is visible by default; the user can toggle hidden in the gallery to
// inspect individual chunks.
//
// On cancel the chain stops before the next chunk; the in-flight chunk's
// child is SIGTERM'd by cancel() and surfaces a 'failed' event we translate
// into a chain-level failure. Already-completed inner chunks are hidden but
// not deleted (the partial output is still on disk if the user wants it).
//
// `chunkPrompts` (#3695) optionally steers each chunk individually: entry i is
// chunk i's prompt, and a null/blank/missing entry falls back to the main
// `prompt`. It is destructured out of `rest` on purpose so the per-chunk
// generateVideo() calls below never receive the whole list.
export async function generateChainedVideo({ chunks, chunkPrompts, contextFrames, jobId: outerJobId, ...rest }) {
  const totalChunks = Number(chunks) || 1;
  if (totalChunks === 1) {
    return generateVideo({ jobId: outerJobId, ...rest });
  }
  if (!outerJobId) throw new ServerError('generateChainedVideo requires jobId', { status: 500, code: 'INTERNAL' });

  const chainModel = resolveVideoModel(rest.modelId || defaultVideoModelId());
  const chainError = videoChainUnsupportedError(chainModel);
  if (chainError) throw chainError;

  // How chunk N+1 sees chunk N. 'window' hands LTX-2's extend pipeline the
  // prior chunk's last `windowFrames` frames (motion + appearance); 'frame'
  // is the historical single-still i2v hop, and is what every runtime without
  // an extend pipeline resolves to. See lib/videoContinuity.js.
  const windowFrames = resolveContextFrames(contextFrames);
  const continuity = resolveContinuityStrategy({ model: chainModel, contextFrames: windowFrames });
  // Mirrors generateVideo's own default — the trim math converts frame indices
  // to audio timestamps, so it can't run on an undefined rate.
  const chainFps = Number(rest.fps) > 0 ? Number(rest.fps) : 24;
  // Latents each chained chunk asks ExtendPipeline to append. buildLtx2Args
  // derives the same number from the same numFrames; the trim below subtracts
  // the pixel frames they decode to, so the two have to stay in step —
  // INCLUDING when the caller omitted numFrames. `numFrames` is optional on
  // the route, and generateVideo resolves the same default before deriving
  // `--extend-frames`; resolving it there but not here made the orchestrator
  // assume an 8-frame extension against a ~120-frame one, so the prefix trim
  // would have kept 8 frames of each hop and thrown the rest away.
  // Optional-chained on purpose: `videoChainUnsupportedError` waves an
  // unresolvable model through (an unknown runtime resolves to the base mode
  // set, which includes 'image'), so a model removed between enqueue and
  // dispatch reaches here as null. Falling back keeps the chain's first chunk
  // the thing that reports it — generateVideo throws a 400 "Unknown video
  // model: X" — instead of a null-deref out of the dispatcher.
  const chunkExtendLatents = extendLatentFrames(
    rest.numFrames ?? chainModel?.defaultFrames ?? DEFAULT_NUM_FRAMES,
  );

  const chainState = { stopped: false };
  videoJobState.activeChain = chainState;

  // Hold an outer job entry so attachSseClient(outerJobId) wires up against
  // the same SSE stream the queue sees. Without this, /api/video-gen/:id/events
  // attached at the outer id would 404 because no shared job-map entry exists.
  const outerJob = { id: outerJobId, clients: [], status: 'running' };
  videoJobState.jobs.set(outerJobId, outerJob);

  // Chain-level wall-clock estimate (#3801). Every chunk is a full render that
  // pays the fixed per-render cost again, so the chain estimate is the
  // per-chunk estimate times the chunk count — `chunks` is handed to the
  // estimator rather than folding the chain into one oversized render.
  // The dimension/step defaults mirror generateVideo's model-aware resolution
  // and samplerLocked step rule; the estimator returns null on anything it
  // can't resolve, so malformed custom registry defaults degrade to the legacy
  // canvas rather than producing a wrong or non-finite estimate.
  // Deliberately placed AFTER the active chain and shared job are registered: it is the
  // first await in this function, and a cancel arriving during the history
  // read must still find the chain to stop.
  // A chain's chunks do NOT all run in the request's mode: chunk 0 keeps it,
  // and chunks 1+ re-enter as `extend` on a window-continuity chain or `image`
  // on a frame hop (see the dispatch below — these two must stay in step).
  // `extend` routes through ExtendPipeline, which no two-stage speed profile is
  // validated for, so a Fast chain would render chunk 0 fast and the rest at
  // the model default: a visible seam mid-clip, plus a chain ETA claiming a
  // speed-up most of the render never takes. resolveVideoSpeedProfileForModes
  // therefore applies the profile to the whole chain or to none of it, and
  // `speedProfileId` is stripped from `rest` below so the per-chunk renders
  // agree with this decision instead of each re-deciding.
  const chainChunkModes = [
    inferEffectiveVideoMode(rest),
    ...(totalChunks > 1 ? [continuity === 'window' ? 'extend' : 'image'] : []),
  ];
  const chainSpeedProfile = resolveVideoSpeedProfileForModes({
    model: chainModel, profileId: rest.speedProfileId, modes: chainChunkModes,
  });
  const chainSpeedDeclined = chainSpeedProfile ? null : speedProfileDeclineReasonForModes({
    model: chainModel, profileId: rest.speedProfileId, modes: chainChunkModes,
  });
  if (chainSpeedDeclined) {
    console.log(`⚠️ Speed profile declined for chain [${outerJobId.slice(0, 8)}] ${chainSpeedDeclined.code}: ${chainSpeedDeclined.message}`);
  }
  // What every chunk will actually be handed. Absent (not 'quality') when the
  // chain declined, so a chunk stamps no profile it didn't render with.
  const chainSpeedProfileId = chainSpeedProfile ? rest.speedProfileId : undefined;
  // `resolveVideoSampler` is the SAME precedence rule generateVideo applies, so
  // the chain estimate can't drift from what the chunks actually render at.
  const { steps: chainSteps } = resolveVideoSampler({
    model: chainModel, steps: rest.steps, guidanceScale: rest.guidanceScale, speedProfile: chainSpeedProfile,
  });
  const chainDimensions = resolveVideoDimensions(chainModel, rest.width, rest.height);
  const chainEta = estimateRenderMs({
    history: await loadHistory(),
    modelId: rest.modelId || defaultVideoModelId(),
    width: chainDimensions.width,
    height: chainDimensions.height,
    numFrames: rest.numFrames ?? chainModel?.defaultFrames ?? DEFAULT_NUM_FRAMES,
    steps: chainSteps,
    speedProfileId: chainSpeedProfile?.id ?? null,
    chunks: totalChunks,
  });
  const chainEtaField = chainEta ? { etaMs: chainEta.etaMs } : {};
  console.log(`🎬 Chained video [${outerJobId.slice(0, 8)}]: ${totalChunks} chunks, eta=${chainEta ? `${Math.round(chainEta.etaMs / 1000)}s (${chainEta.basis}, n=${chainEta.sampleCount})` : 'unknown'}`);

  const chunkIds = [];
  let currentSource = rest.sourceImagePath;
  // 'window' continuation: the tail slice of the prior chunk that the next one
  // conditions on. A fresh short clip per hop, NOT the prior chunk's whole
  // output — extend_from_video returns `source + extension`, so conditioning
  // on the full clip would make every chunk re-contain the one before it (the
  // stitch then repeats that content once per hop) while the conditioning cost
  // grew with the chain. Written under tmpdir and deleted when the chain ends.
  let currentContextClip = null;
  const contextClipPaths = [];
  // Echoed-context cut for each chunk that has one: where the chunk's own new
  // footage starts, and how many frames it therefore contributes. Handed to
  // stitchVideos, which applies the cuts in its concat filter graph — the
  // chunk files themselves are never rewritten, so the chain pays exactly one
  // encode (the stitch) instead of one per chunk plus the stitch.
  const chunkTrims = new Map();
  // First chunk always preserves the user's mode (text, image, fflf or extend)
  // and is never trimmed: in an extend chain its output is `source clip +
  // extension`, and the source clip belongs in the result exactly once — here.
  // Chunks 1+ take the resolved continuity path instead.
  const firstMode = rest.mode || (currentSource ? 'image' : 'text');

  const runChunk = (i) => new Promise((resolve, reject) => {
    const innerJobId = randomUUID();
    chunkIds.push(innerJobId);
    const onProgress = (e) => {
      if (e.generationId !== innerJobId) return;
      const innerProg = typeof e.progress === 'number' ? e.progress : 0;
      const aggregate = (i + Math.max(0, Math.min(1, innerProg))) / totalChunks;
      videoGenEvents.emit('progress', {
        generationId: outerJobId,
        progress: aggregate,
        step: typeof e.step === 'number' ? e.step : undefined,
        totalSteps: typeof e.totalSteps === 'number' ? e.totalSteps : undefined,
        message: `Chunk ${i + 1}/${totalChunks}${e.message ? ` — ${e.message}` : ''}`,
        // Chain-level estimate, NOT the inner chunk's — the outer id's
        // consumers are watching the whole chain's clock.
        ...chainEtaField,
        // The chunk's own render phase, so a chained render names its step the
        // same way a single-shot one does instead of falling back to the
        // page's load/render heuristic for the whole chain (#5872).
        phase: typeof e.phase === 'string' && e.phase ? e.phase : undefined,
      });
      broadcastSse(outerJob, {
        type: 'progress',
        progress: aggregate,
        message: `Chunk ${i + 1}/${totalChunks}`,
      });
    };
    const detach = () => {
      videoGenEvents.off('progress', onProgress);
      videoGenEvents.off('completed', onCompleted);
      videoGenEvents.off('failed', onFailed);
    };
    const onCompleted = (e) => {
      if (e.generationId !== innerJobId) return;
      detach();
      resolve(e);
    };
    const onFailed = (e) => {
      if (e.generationId !== innerJobId) return;
      detach();
      reject(new Error(e.error || 'chunk failed'));
    };
    videoGenEvents.on('progress', onProgress);
    videoGenEvents.on('completed', onCompleted);
    videoGenEvents.on('failed', onFailed);

    // Bump the seed by chunk index when the user supplied one — keeps each
    // chunk visually varied while remaining reproducible from the user's
    // chosen seed. When seed is unset, generateVideo picks one randomly
    // per chunk (existing behavior).
    const chunkSeed = rest.seed != null && rest.seed !== ''
      ? Number(rest.seed) + i
      : undefined;

    // Chunks 1+ on a window-continuity chain re-enter as extend renders
    // conditioned on the tail clip built after the previous chunk, whatever
    // mode the chain STARTED in — a text or i2v chain gets the same motion
    // carry-over an extend chain does, instead of restarting from a still.
    const isWindowHop = continuity === 'window' && i > 0;
    // Per-chunk beat (#3695). `chunkPrompts` is already normalized (blank →
    // null) by prepareVideoGenParams, but re-guard on emptiness here too so a
    // direct service caller can't hand a chunk an empty prompt — an absent beat
    // must always resolve to the main prompt, never to ''.
    const beat = chunkPrompts?.[i];
    const chunkPrompt = (typeof beat === 'string' && beat.trim() !== '') ? beat : rest.prompt;

    generateVideo({
      ...rest,
      // Decided ONCE for the chain above, not re-decided per chunk: `undefined`
      // when any chunk's mode declines the profile, so every chunk renders on
      // the same sampler and the stitched clip has no mid-clip seam.
      speedProfileId: chainSpeedProfileId,
      prompt: chunkPrompt,
      seed: chunkSeed,
      jobId: innerJobId,
      // window hop: condition on the tail clip cut from the prior chunk, so
      // the model reads motion out of it rather than a single static pose.
      // frame hop: condition on the prior chunk's extracted last frame.
      sourceImagePath: isWindowHop ? null : currentSource,
      extendFromVideoPath: isWindowHop ? currentContextClip : (i === 0 ? rest.extendFromVideoPath : null),
      // Only the first chunk consumes the user's uploadedTempPath (durable
      // copy under data/uploads). Later chunks condition on the prior chunk
      // instead — a tail window (window hop) or an extracted frame (frame hop).
      uploadedTempPath: i === 0 ? rest.uploadedTempPath : null,
      uploadedTempPaths: i === 0 ? (rest.uploadedTempPaths || []) : [],
      hidden: true,
      mode: isWindowHop ? 'extend' : (i === 0 ? firstMode : 'image'),
      // After the first chunk, drop FFLF-style last image — chained
      // continuation conditions on one thing, the tail of the chunk before it,
      // and has no second anchor to pin an end frame to.
      lastImagePath: i === 0 ? rest.lastImagePath : null,
      // Multi-keyframe interpolation only makes sense for the first chunk
      // (the user pinned specific frame indices in a single clip). Subsequent
      // chunks fall through to the image-chain path, conditioning on the
      // prior chunk's tail frame.
      keyframes: i === 0 ? rest.keyframes : null,
      // The reference-mode promise (#4874) belongs to the first chunk alone. Every
      // continuation conditions on the PRIOR chunk's tail — a still or a window
      // clip the chain produced, not something the user offered as inspiration —
      // and loosening that hop would break the seam it exists to hold. A window hop
      // isn't image mode at all, so carrying the mode forward would also fail the
      // gate outright.
      i2vReferenceMode: i === 0 ? rest.i2vReferenceMode : null,
    }).catch((err) => {
      detach();
      reject(err);
    });
  });

  // The conditioning windows are scratch input to the next chunk, never
  // output — drop them on every terminal path (both of which always run) so a
  // long chain doesn't leave a trail of clips in tmpdir. Best-effort and
  // fire-and-forget: a leftover temp file must never fail a finished render.
  const cleanupContextClips = () => {
    for (const p of contextClipPaths) unlink(p).catch(() => {});
    contextClipPaths.length = 0;
  };
  const finishOk = (payload) => {
    if (videoJobState.activeChain === chainState) videoJobState.activeChain = null;
    cleanupContextClips();
    videoGenEvents.emit('completed', { generationId: outerJobId, ...payload });
    broadcastSse(outerJob, { type: 'complete', result: payload });
    closeJobAfterDelay(videoJobState.jobs, outerJobId);
  };
  const finishFail = (error) => {
    if (videoJobState.activeChain === chainState) videoJobState.activeChain = null;
    cleanupContextClips();
    videoGenEvents.emit('failed', { generationId: outerJobId, error });
    broadcastSse(outerJob, { type: 'error', error });
    closeJobAfterDelay(videoJobState.jobs, outerJobId);
  };

  // Schedule the chain on the next tick and return the descriptor
  // synchronously — matches generateVideo's spawn-then-emit contract.
  (async () => {
    for (let i = 0; i < totalChunks; i++) {
      if (chainState.stopped) {
        await setHistoryItemsHidden(chunkIds, true);
        finishFail('Canceled mid-chain');
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      const completed = await runChunk(i).catch((err) => ({ error: err.message }));
      if (completed?.error) {
        await setHistoryItemsHidden(chunkIds, true);
        finishFail(completed.error);
        return;
      }
      // The chunk's output file is always <innerJobId>.mp4 under PATHS.videos
      // (see generateVideo: filename = `${jobId}.mp4`).
      const chunkId = chunkIds[chunkIds.length - 1];
      const chunkPath = join(PATHS.videos, `${chunkId}.mp4`);

      if (continuity === 'window') {
        // One probe serves both cuts below. Neither rewrites chunkPath, so the
        // count stays valid for both — worth keeping to one call because
        // probeFrameCount falls back to a full decode pass when the container
        // header carries no nb_frames.
        // eslint-disable-next-line no-await-in-loop
        const frames = await probeFrameCount(chunkPath);

        // A window hop's render is `context window + new frames`. The window is
        // the tail of the chunk before it, which the stitched timeline already
        // holds, so record where the new footage starts and let the stitch drop
        // the echo in its filter graph. Measured from the RENDERED length rather
        // than from the window we supplied: the VAE snaps the encoded context up
        // to a latent boundary, so the echo is usually a few frames longer than
        // what we handed in.
        let contextPrefix = 0;
        if (i > 0) {
          contextPrefix = contextPrefixFrames({ totalFrames: frames, extendLatents: chunkExtendLatents });
          if (contextPrefix <= 0) {
            console.log(`⚠️ Chunk ${i + 1}/${totalChunks} context prefix unmeasurable (frames=${frames ?? 'unknown'}), leaving it untrimmed`);
          }
        }
        // Record the measurement even when there's nothing to cut (chunk 0, or
        // an unmeasurable prefix). An extend render's file is `source +
        // extension`, so a chunk's own history `numFrames` — the count it was
        // REQUESTED at — understates what it contributes to the timeline, and
        // that's the only other number the stitch could fall back on.
        if (frames != null) chunkTrims.set(chunkId, { startFrame: contextPrefix, frames: frames - contextPrefix });

        if (i < totalChunks - 1) {
          // Cut the next hop's conditioning window off this chunk's tail. Both
          // the count and the cut clamp: a window longer than the chunk simply
          // conditions on all of it.
          //
          // An unprobeable length clamps the same way, which means the whole
          // chunk becomes the window — the unbounded conditioning this exists
          // to avoid, for one hop. It self-corrects (the next chunk's prefix
          // trim measures the echo off the render, not off the window), but say
          // so rather than letting the fallback be silent.
          if (frames == null) {
            console.log(`⚠️ Chunk ${i + 1}/${totalChunks} length unprobeable — conditioning the next chunk on the whole clip instead of a ${windowFrames}-frame window`);
          }
          const contextPath = join(tmpdir(), `chaincontext-${chunkId}.mp4`);
          // eslint-disable-next-line no-await-in-loop
          const cut = await trimVideoFromFrame(chunkPath, contextPath, {
            // Floored at the echo the stitch is going to drop: the window must
            // come from this chunk's OWN footage, never from the replay of the
            // one before it. (The chunk file still holds that replay now that
            // the cut happens at stitch time.)
            startFrame: Math.max(contextPrefix, tailWindowStartFrame({ totalFrames: frames, frames: windowFrames })),
            fps: chainFps,
          });
          if (!cut.ok) {
            await setHistoryItemsHidden(chunkIds, true);
            finishFail(`Failed to build the continuation context window between chunks: ${cut.reason}`);
            return;
          }
          contextClipPaths.push(contextPath);
          currentContextClip = contextPath;
        }
      } else if (i < totalChunks - 1) {
        // extractLastFrame caches by id, so re-clicks (e.g. from gallery
        // "Continue") don't re-spawn ffmpeg.
        // eslint-disable-next-line no-await-in-loop
        const frame = await extractLastFrame(chunkId).catch((err) => ({ error: err.message }));
        if (frame?.error) {
          await setHistoryItemsHidden(chunkIds, true);
          finishFail(`Failed to extract frame between chunks: ${frame.error}`);
          return;
        }
        currentSource = join(PATHS.images, frame.filename);
      }
    }

    const stitched = await stitchVideos(chunkIds, {
      id: outerJobId,
      filenamePrefix: 'chained',
      historyKey: 'chainedFrom',
      promptOverride: rest.prompt || null,
      // Persist the beats alongside the stitched clip so the gallery entry (and
      // a Remix off it) carries the same source of truth the chain rendered
      // from — the individual chunk entries only ever hold their own resolved
      // prompt, which loses which of them were explicit beats vs. fallbacks.
      chunkPrompts: chunkPrompts?.some(Boolean) ? chunkPrompts : null,
      // Echoed-context prefixes to cut out of each windowed chunk as the
      // timeline is assembled, rather than by pre-encoding the chunk files.
      trims: chunkTrims.size ? chunkTrims : null,
    }).catch((err) => ({ error: err.message }));
    if (stitched?.error) {
      await setHistoryItemsHidden(chunkIds, true);
      finishFail(`Stitch failed: ${stitched.error}`);
      return;
    }
    await setHistoryItemsHidden(chunkIds, true);
    finishOk({
      filename: stitched.filename,
      thumbnail: stitched.thumbnail,
      path: `/data/videos/${stitched.filename}`,
      chainedFrom: chunkIds,
    });
  })().catch((err) => {
    console.log(`❌ chain orchestration crashed [${outerJobId.slice(0, 8)}]: ${err.message}`);
    finishFail(err.message);
  });

  // Match the synchronous shape of generateVideo so the route's response
  // assembly doesn't need a chain-specific branch. The actual filename is
  // delivered via SSE 'complete' once the chain settles.
  return {
    jobId: outerJobId,
    generationId: outerJobId,
    filename: `chained-${outerJobId}.mp4`,
    mode: 'local',
    model: rest.modelId,
  };
}

// Hide many history entries in one load+save. The per-id setHistoryItemHidden
// would re-read + atomic-write the entire history file once per id; for an
// 8-chunk chain that's 16 file ops on every terminal path. Best-effort —
// errors are swallowed because the stitched clip is more important than
// the visibility flag.
async function setHistoryItemsHidden(ids, hidden) {
  if (!ids?.length) return;
  const wanted = new Set(ids);
  // Serialized through the shared history tail so a concurrent write path
  // (a download completing, a render finalizing) can't clobber this update.
  await mutateVideoHistory((history) => {
    for (const item of history) {
      if (wanted.has(item.id)) item.hidden = !!hidden;
    }
    return history;
  }).catch(() => {});
}
