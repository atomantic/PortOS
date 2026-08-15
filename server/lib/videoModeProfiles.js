/**
 * Video mode capability — the shipped `supportedModes` fact per video runtime
 * (issue #3737), so "which modes does this model support?" is answered by the
 * registry entry rather than re-derived from `runtime` comparisons at 25+ sites.
 *
 * `applyVideoSupportedModes` is a read-time decoration, not a stored field:
 * `getVideoModels()` runs it over the platform list the same way
 * `listVideoModels()` decorates `lastFrameAnchored`. Deriving on read (rather
 * than in `normalizeRegistry`, alongside the `disclosure` / `finishModelId`
 * backfills) keeps it out of `data/media-models.json` — a persisted copy would
 * become a "declared" list that no later correction to the table below could
 * reach, on every install that ever added a model.
 *
 * Careful: `mode` here is the t2v/i2v *semantic*, not the local/grok render
 * backend `videoGen/modes.js` enumerates.
 */

// The base semantic modes a registry entry can enumerate, and the fallback for
// an unknown (user-added, or peer-synced from a newer build) runtime: we can't
// narrow it, and narrowing to text-only would drop a user's own model out of
// every picker.
//
// `a2v` and the IC-LoRA remix ids are deliberately absent: they're ltx2
// *pipeline* capabilities, gated by runtime at both boundaries
// (A2V_REQUIRES_LTX2 / IC_LORA_REQUIRES_LTX2), and the remix ids are enumerated
// from the IC-LoRA weight registry rather than per model entry.
export const VIDEO_BASE_MODES = Object.freeze(['text', 'image', 'fflf', 'extend']);

/**
 * Modes each shipped runtime can render, as facts about its helper's argv:
 *
 *   - `mlx_video` — `mlx_video.generate_av` takes a single `--image` plus an
 *     `--image-frame-idx`, so text / image / extend (last-frame → i2v) all run.
 *     FFLF is offered but *degraded*: the helper conditions on one frame and
 *     drops the other. That caveat rides on `lastFrameAnchored: false`
 *     (videoGen/runtimes.js), which the client renders as "last frame is
 *     advisory" — the honest shape is "the mode runs", not "the mode is absent".
 *   - `ltx2` — dgrauet's KeyframeInterpolationPipeline anchors both frames and
 *     has a native ExtendPipeline.
 *   - `wan22` — MLX-Gen's Wan CLI is t2v or i2v depending on the checkpoint, so
 *     each shipped profile narrows this itself; the pair is the widest any Wan
 *     checkpoint reaches (no keyframe interpolation, no extend).
 *   - `minimax_h3` / `minimax_h3_cuda` — fl2va conditioning anchored at the
 *     first / last latent frame: 'image' anchors one, 'fflf' anchors both. The
 *     MLX port and the diffusers CUDA path expose the same three, because the
 *     capability is the checkpoint partition's, not the runner's. Doubles as
 *     the mode ceiling in videoGen/modeContract.js.
 *   - `hunyuan` — the MLX port's `hyvideo.inference` helper takes a prompt and
 *     nothing else (see buildHunyuanArgs); text-to-video only. This replaces the
 *     legacy `mode: 't2v'` field, which no reader ever consulted.
 */
// One array, referenced by both H3 runtimes: the modes are the fl2va
// checkpoint partition's, so a second literal would be a copy the comment above
// says must never differ — with nothing enforcing it.
const MINIMAX_H3_MODE_SET = Object.freeze(['text', 'image', 'fflf']);

export const VIDEO_RUNTIME_MODES = Object.freeze({
  mlx_video: Object.freeze(['text', 'image', 'fflf', 'extend']),
  ltx2: Object.freeze(['text', 'image', 'fflf', 'extend']),
  ltx25: Object.freeze(['text', 'image', 'fflf', 'extend']),
  wan22: Object.freeze(['text', 'image']),
  minimax_h3: MINIMAX_H3_MODE_SET,
  minimax_h3_cuda: MINIMAX_H3_MODE_SET,
  hunyuan: Object.freeze(['text']),
});

/**
 * The modes one entry supports. A declared non-empty array always wins — a
 * hand-edited or peer-synced registry is the authority on its own entries. An
 * absent, non-array or empty list is "not declared", not "supports nothing":
 * an empty list would strand the entry in every picker with no way back.
 */
export const resolveVideoSupportedModes = (entry) => {
  const declared = entry?.supportedModes;
  if (Array.isArray(declared) && declared.length > 0) return declared;
  return VIDEO_RUNTIME_MODES[entry?.runtime] || VIDEO_BASE_MODES;
};

/**
 * Decorate every entry in one platform's video list with a resolved
 * `supportedModes`. Pure; never mutates the inputs, and hands out a copy rather
 * than the frozen shared table so a caller can't freeze-error on it.
 */
export const applyVideoSupportedModes = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    if (Array.isArray(entry.supportedModes) && entry.supportedModes.length > 0) return entry;
    return { ...entry, supportedModes: [...resolveVideoSupportedModes(entry)] };
  });
};
