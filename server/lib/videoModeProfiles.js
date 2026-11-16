/**
 * The shipped `supportedModes` fact per video runtime (#3737), so "which modes does this model support?" has one answer on the registry entry instead of 25+ runtime comparisons.
 *
 * `VIDEO_RUNTIME_MODES` maps each runtime to the semantic modes its helper can render (`minimax_h3_ref2va` a2v-only); `VIDEO_BASE_MODES` is the non-audio fallback for an unknown runtime. `resolveVideoSupportedModes(entry)` and `applyVideoSupportedModes(list)`
 * are a read-time decoration used by `mediaModels.js#getVideoModels` (as `listVideoModels()` decorates `lastFrameAnchored`), not a stored field: persisting it in `data/media-models.json` would become a "declared" list no later correction to the table could reach.
 * Careful: `mode` is the t2v/i2v *semantic*, not the local/grok render backend `videoGen/modes.js` enumerates.
 */

// The base semantic modes an entry can enumerate and the fallback for an unknown (user-added or newer-peer-synced) runtime: narrowing to text-only would drop a user's own model from every picker. `a2v` and the IC-LoRA remix ids are absent from the generic fallback
// (audio-to-video only for runtimes with an actual audio conditioning path; IC-LoRA is an LTX-only pipeline capability).
export const VIDEO_BASE_MODES = Object.freeze(['text', 'image', 'fflf', 'extend']);

/**
 * Modes each shipped runtime can render, as facts about its helper's argv:
 *   - `mlx_video`: `generate_av` takes one `--image` plus `--image-frame-idx`, so text / image / extend all run; FFLF is offered but *degraded* (one frame conditioned, the other dropped), a caveat riding on `lastFrameAnchored: false` (videoGen/runtimes.js) the client renders as "last frame is advisory".
 *   - `ltx2`: dgrauet's KeyframeInterpolationPipeline anchors both frames and has a native ExtendPipeline.
 *   - `wan22`: MLX-Gen's Wan CLI is t2v or i2v by checkpoint, so each shipped profile narrows this; the pair is the widest any Wan checkpoint reaches.
 *   - `minimax_h3` / `minimax_h3_cuda`: fl2va conditioning at the first / last latent frame ('image' anchors one, 'fflf' both); the same three on the MLX port and the CUDA path, since the capability is the checkpoint partition's. Also the mode ceiling in videoGen/modeContract.js.
 *   - `minimax_h3_ref2va`: mere.run's Ref2VA path needs one image and one audio reference; PortOS windows long audio internally but exposes one duration-driven a2v job.
 *   - `hunyuan`: compatibility-only for user-repointed or peer-synced historical entries (retired runtime, renderArgs rejects it); text-only keeps them from advertising modes the old implementation never supported.
 */
// One array referenced by both H3 runtimes (the modes are the fl2va checkpoint partition's, so a second literal would be an unenforced copy).
const MINIMAX_H3_MODE_SET = Object.freeze(['text', 'image', 'fflf']);

export const VIDEO_RUNTIME_MODES = Object.freeze({
  cuda_video: Object.freeze(['text', 'image']),
  mlx_video: Object.freeze(['text', 'image', 'fflf', 'extend']),
  ltx2: Object.freeze(['text', 'image', 'fflf', 'extend', 'a2v']),
  ltx25: Object.freeze(['text', 'image', 'fflf', 'extend', 'a2v']),
  ltx25_cuda: Object.freeze(['text', 'image']),
  wan22: Object.freeze(['text', 'image']),
  wan22_cuda: Object.freeze(['text']),
  fastvideo: Object.freeze(['text', 'image']),
  minimax_h3: MINIMAX_H3_MODE_SET,
  minimax_h3_cuda: MINIMAX_H3_MODE_SET,
  minimax_h3_ref2va: Object.freeze(['a2v']),
  hunyuan: Object.freeze(['text']),
});

/** The modes one entry supports. A declared non-empty array always wins (a hand-edited or peer-synced registry is the authority on its entries); an absent, non-array or empty list is "not declared", not "supports nothing" (an empty list would strand the entry in every picker). */
export const resolveVideoSupportedModes = (entry) => {
  const declared = entry?.supportedModes;
  if (Array.isArray(declared) && declared.length > 0) return declared;
  return VIDEO_RUNTIME_MODES[entry?.runtime] || VIDEO_BASE_MODES;
};

/** Decorate every entry in a platform's video list with a resolved `supportedModes`. Pure; never mutates inputs and hands out a copy, not the frozen shared table. */
export const applyVideoSupportedModes = (list) => {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    if (Array.isArray(entry.supportedModes) && entry.supportedModes.length > 0) return entry;
    return { ...entry, supportedModes: [...resolveVideoSupportedModes(entry)] };
  });
};
