/**
 * Video Gen — how chunk N+1 of a chained render is conditioned on chunk N.
 *
 * Two strategies exist, and which one a request gets is decided here so the
 * route, `prepareParams.js` and the chain orchestrator in `local.js` can't
 * drift on the rule:
 *
 *   'frame'  — extract the prior chunk's LAST FRAME and run chunk N+1 as
 *              image-to-video off that still. Works on every runtime, but the
 *              model gets a pose with no velocity, so motion visibly stalls
 *              and restarts at every seam.
 *   'window' — hand the prior chunk's LAST N FRAMES to LTX-2's
 *              ExtendPipeline.extend_from_video, which conditions on that
 *              window's latent (motion AND appearance) instead of a still.
 *              The `ltx2` and `ltx25` runtimes have the pipeline; every other
 *              runtime degrades to 'frame'.
 *
 * Why a WINDOW and not the whole prior clip. `extend_from_video` returns
 * `source + extension` (see `retake.py`: `F_total = F_source + extend_frames`),
 * so feeding it the previous chunk's full output makes chunk N+1 contain
 * everything chunk N did, and stitching the chunks then repeats that content
 * once per hop while per-chunk cost grows with every hop. A fixed-size tail
 * window makes the conditioning cost constant, keeps only the most recent
 * appearance state (so exposure/color drift doesn't compound from the clip's
 * opening frames), and — because we know how much of the output is echoed
 * context — lets the orchestrator trim the echo back off before stitching.
 *
 * Pure and dependency-free: `prepareParams.js` imports it without dragging in
 * `local.js`, which the module suites mock wholesale.
 */

/**
 * Default tail-window size, in pixel frames.
 *
 * ~1 second at 24fps, and just under 3 LTX latent frames (the VAE compresses
 * 8 pixel frames per latent), which is enough for the model to read a motion
 * vector out of the context rather than a single pose. Community reports on
 * long-form LTX chaining converge on roughly this size: smaller windows read
 * as a still and reintroduce the seam, larger ones cost more per hop without
 * visibly improving continuity.
 */
export const DEFAULT_CONTEXT_FRAMES = 22;

/**
 * `0` is a real, supported value — "condition on the last frame only", i.e.
 * opt back into the 'frame' strategy on a runtime that could do better. It is
 * NOT the same as an absent value, which takes DEFAULT_CONTEXT_FRAMES.
 */
export const MIN_CONTEXT_FRAMES = 0;

/**
 * Ceiling on the tail window. 121 frames is ~5s at 24fps and 16 LTX latent
 * frames — past that the context costs more to encode and denoise than the
 * extension itself, and LTX's own extend API caps context + extension at 505
 * frames total, which a chained render can reach from both ends at once.
 */
export const MAX_CONTEXT_FRAMES = 121;

// Timing belongs to a verified runtime contract, not to a mutable capability
// set. H3's history packing and frame grid differ from LTX's even though both
// can condition on images; a future adapter must bring its own output layout.
const LTX_CONTINUATION = Object.freeze({
  temporalContext: true,
  latentFrameStride: 8,
  outputLayout: 'echoed-history-prefix',
  unavailableReason: null,
});
const CONTINUATION_CONTRACTS = Object.freeze({
  ltx2: LTX_CONTINUATION,
  ltx25: LTX_CONTINUATION,
  minimax_h3: Object.freeze({
    temporalContext: false,
    unavailableReason: 'The pinned H3 MLX helper has no verified video/audio history-conditioning adapter.',
  }),
  minimax_h3_cuda: Object.freeze({
    temporalContext: false,
    unavailableReason: 'The H3 CUDA history adapter has no verified Windows/NVIDIA moving-subject and still-baseline motion/audio comparison.',
  }),
});
const UNAVAILABLE_CONTINUATION = Object.freeze({
  temporalContext: false,
  unavailableReason: 'This runtime has no verified temporal continuation contract.',
});

/** Verified temporal capability and timing; unavailable runtimes expose no stride. */
export const continuationContract = (runtime) => (Object.hasOwn(CONTINUATION_CONTRACTS, runtime)
  ? CONTINUATION_CONTRACTS[runtime] : UNAVAILABLE_CONTINUATION);

/** True only when the runtime has a verified video-history continuation path. */
export const supportsContextWindow = (model) => continuationContract(model?.runtime).temporalContext;

const echoedHistoryContract = (runtime) => {
  const contract = continuationContract(runtime);
  if (!contract.temporalContext || contract.outputLayout !== 'echoed-history-prefix') {
    throw new Error(`Temporal continuation unavailable for ${runtime ?? 'unknown runtime'}: ${contract.unavailableReason}`);
  }
  return contract;
};

/**
 * Normalize a caller-supplied context-frame count.
 *
 * Absent (`null`/`undefined`/`''`) → the default. An explicit `0` → 0, which
 * the strategy resolver reads as "last frame only" — conflating the two would
 * make it impossible to opt out of windowed continuation once it's the
 * default. Anything non-finite falls back to the default rather than
 * poisoning the arithmetic downstream; finite values clamp into range.
 */
export const resolveContextFrames = (requested) => {
  if (requested == null || requested === '') return DEFAULT_CONTEXT_FRAMES;
  const n = Number(requested);
  if (!Number.isFinite(n)) return DEFAULT_CONTEXT_FRAMES;
  return Math.min(MAX_CONTEXT_FRAMES, Math.max(MIN_CONTEXT_FRAMES, Math.floor(n)));
};

/**
 * The strategy a chained render will actually use.
 *
 * `contextFrames` is the already-resolved count (call `resolveContextFrames`
 * first). A model whose runtime has no extend pipeline always gets 'frame',
 * whatever the caller asked for — the count is simply ignored rather than
 * rejected, so switching models mid-form can't strand the request.
 */
export const resolveContinuityStrategy = ({ model, contextFrames }) => (
  contextFrames > 0 && supportsContextWindow(model) ? 'window' : 'frame'
);

/**
 * Latent frames to request from ExtendPipeline for a chunk that should add
 * `numFrames` pixel frames. No leading +1: the context window already supplies
 * the anchor frame. Floors at 1 so a too-small request still renders something.
 */
export const extendLatentFrames = (numFrames, runtime) => {
  const { latentFrameStride } = echoedHistoryContract(runtime);
  const n = Number(numFrames);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n / latentFrameStride));
};

/** Pixel frames an `extendLatents`-latent extension contributes to the output. */
export const extendedPixelFrames = (extendLatents, runtime) => {
  const { latentFrameStride } = echoedHistoryContract(runtime);
  return Math.max(0, Math.floor(Number(extendLatents) || 0)) * latentFrameStride;
};

/**
 * How many leading frames of an extend render are echoed context that the
 * stitched timeline already contains.
 *
 * Derived from the RENDERED output rather than from the context clip we fed
 * in, because the VAE snaps the encoded source to a latent boundary — the
 * echo is generally a few frames longer than the window we supplied. Since
 * `extend()` appends exactly `extend_frames` latents, everything before the
 * last `extendLatents × 8` frames is echo.
 *
 * Returns 0 when the numbers don't support a trim (unprobeable output, an
 * output no longer than the extension, a nonsensical count) — the caller must
 * treat 0 as "leave the chunk alone", never as "trim everything".
 */
export const contextPrefixFrames = ({ runtime, totalFrames, extendLatents }) => {
  const total = Number(totalFrames);
  const newFrames = extendedPixelFrames(extendLatents, runtime);
  if (!Number.isFinite(total) || total <= 0 || newFrames <= 0) return 0;
  return Math.max(0, total - newFrames);
};

/**
 * First frame index of an `frames`-long tail window in a `totalFrames` clip.
 * Clamps at 0 so a window larger than the clip just keeps the whole clip.
 */
export const tailWindowStartFrame = ({ totalFrames, frames }) => {
  const total = Number(totalFrames);
  const want = Number(frames);
  if (!Number.isFinite(total) || !Number.isFinite(want)) return 0;
  return Math.max(0, Math.floor(total) - Math.floor(want));
};

/**
 * Where to join the ORIGINAL source clip to the model's new frames in a plain
 * (non-chained) native extend render, so the delivered file keeps the source
 * region as shot instead of the model's VAE decode of it.
 *
 * `extend_from_video` returns `source + extension`; the source half has been
 * encoded and decoded again (and its audio re-synthesised), and extending that
 * result again repeats it over the whole accumulated clip. Conditioning is left
 * alone — only delivery changes: frames `[0, keepFrames)` come from the source
 * file and frames `[newStartFrame, outputFrames)` from the render.
 *
 * LTX only conditions on the first `1 + 8k` source frames, so a source with a
 * ragged tail has `droppedSourceFrames` (< one latent) the model never saw. The
 * extension continues from the last frame the model DID see, so those frames
 * are dropped from the join exactly as they already are in the model's output.
 *
 * Returns `null` — the caller keeps the model output — whenever the measured
 * numbers don't match that layout: an unprobeable clip, an echo longer than the
 * source, or a source whose tail the model skipped by more than a latent (it
 * truncated the context, so which frames it kept is not something to guess at).
 */
export const planExtendSplice = ({ runtime, sourceFrames, outputFrames, extendLatents }) => {
  const { latentFrameStride } = echoedHistoryContract(runtime);
  const source = Math.floor(Number(sourceFrames));
  const total = Number(outputFrames);
  const keepFrames = contextPrefixFrames({ runtime, totalFrames: total, extendLatents });
  if (!Number.isFinite(source) || source <= 0 || keepFrames <= 0) return null;
  if (keepFrames > source || source - keepFrames >= latentFrameStride) return null;
  return {
    keepFrames,
    newStartFrame: keepFrames,
    newFrames: total - keepFrames,
    droppedSourceFrames: source - keepFrames,
  };
};
