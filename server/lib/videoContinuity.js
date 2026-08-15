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
 *              Only the `ltx2` runtime has the pipeline, so every other
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

/**
 * The LTX-2 VAE's temporal compression: one latent frame decodes to 8 pixel
 * frames (the first latent carries the extra anchor frame, which is why a
 * clip's pixel length is 8k+1 rather than 8k).
 *
 * This is a property of LTX-2's VAE, not a general one — everything derived
 * from it below is only valid for the runtime in CONTEXT_WINDOW_RUNTIMES. A
 * second runtime joining that set has to bring its own stride, and the failure
 * mode if it doesn't is a wrongly-sized trim rather than an error, so make the
 * stride per-runtime at that point instead of reusing this constant.
 */
export const LATENT_FRAME_STRIDE = 8;

/**
 * Runtimes whose helper can condition on a source *video* rather than a still.
 * `ltx2` / `ltx25` route to ExtendPipeline.extend_from_video; the `minimax_h3`
 * runtimes, `wan22`,
 * `hunyuan` and `mlx_video` have no equivalent and take the 'frame' path.
 *
 * Kept here rather than in `videoGen/modeContract.js` — that module's "declare
 * every runtime gate in one table" rule is about mode/source pairings that
 * REJECT a request at two boundaries, which is what had drifted. This never
 * rejects: an unsupported runtime silently gets the 'frame' path.
 *
 * And deliberately NOT derived from the registry's `supportedModes` (#3737),
 * even though every entry now resolves one: `mlx_video` declares `'extend'`
 * too, but implements it by extracting a last frame and running i2v — there is
 * no pipeline there to hand a video to. `supportedModes.includes('extend')`
 * would therefore route mlx_video chains down a path its helper cannot honor.
 * The two questions genuinely differ: "can the user pick Extend mode?" vs "can
 * this runtime condition on a source VIDEO?", and only the latter belongs here.
 */
export const CONTEXT_WINDOW_RUNTIMES = new Set(['ltx2', 'ltx25']);

/** True when the model's runtime exposes a video-conditioned extend path. */
export const supportsContextWindow = (model) => CONTEXT_WINDOW_RUNTIMES.has(model?.runtime);

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
export const extendLatentFrames = (numFrames) => {
  const n = Number(numFrames);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n / LATENT_FRAME_STRIDE));
};

/** Pixel frames an `extendLatents`-latent extension contributes to the output. */
export const extendedPixelFrames = (extendLatents) => Math.max(0, Math.floor(Number(extendLatents) || 0)) * LATENT_FRAME_STRIDE;

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
export const contextPrefixFrames = ({ totalFrames, extendLatents }) => {
  const total = Number(totalFrames);
  const newFrames = extendedPixelFrames(extendLatents);
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
