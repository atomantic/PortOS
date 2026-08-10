/**
 * Video Gen — per-model input contracts, as pure rule tables.
 *
 * Every one of these rules has to hold at TWO boundaries: `prepareParams.js`
 * rejects before the request is persisted to the media job queue, and
 * `local.js` rejects again at the render boundary (internal producers,
 * persisted-queue replays and retries all reach `generateVideo` directly).
 * Checking twice is deliberate — see the a2v and wan22 precedents in
 * `prepareParams.js` — but *stating* the rule twice is how the two ends drift
 * into different messages and different error codes for the same request.
 *
 * So the rules live here, return a `ServerError` (or null) rather than throwing,
 * and each caller decides only what to do first: the route unlinks its staged
 * uploads, the render path just throws.
 *
 * Dependency-free apart from the error leaf, which keeps it importable from
 * `prepareParams.js` without dragging in `local.js` — the module suites mock
 * `local.js` wholesale, and a mocked rule table is no rule table at all.
 *
 * Careful: `mode` here is the t2v/i2v *semantic* ('text' | 'image' | 'fflf' |
 * 'a2v' | 'extend' | an IC-LoRA remix id), not the local/grok render backend
 * that `modes.js` enumerates.
 *
 * HARD RULE — DO NOT add a third runtime's mode gate anywhere else. Every
 * runtime whose mode/source pairing needs gating declares a row in
 * `VIDEO_MODE_CONTRACTS` below and resolves through `videoModeContractError`;
 * the shape of the gate (which modes are legal, text-forbids-an-image,
 * image-requires-a-source, the FFLF pair rules) is the same on every runtime and
 * is stated exactly once, here. Only genuinely runtime-specific extras stay at
 * their call site — H3's fps / negative-prompt / tiling / frame-grid checks and
 * wan22's `frameStride`, none of which are mode rules. wan22 and minimax_h3 each
 * carried a near-copy of this gate at two boundaries before #3736 collapsed
 * them, and the copies had already drifted into different rules.
 */

import { ServerError } from '../../lib/errorHandler.js';

// H3's fl2va path conditions on up to two keyframes anchored at the first and
// last latent frame — so text, image (first only) and FFLF (first + last) all
// run, while extend / a2v / IC-remix and the ltx2 multi-keyframe array (which
// pins arbitrary frame indices H3 has no anchor for) still have no equivalent.
export const MINIMAX_H3_MODES = Object.freeze(['text', 'image', 'fflf']);

// Message defaults, used for any rule a runtime row doesn't phrase itself. Each
// takes `{ model, requestedMode, allowedModes }` so a new runtime can adopt the
// whole table by declaring nothing but its code prefix.
const DEFAULT_MESSAGES = Object.freeze({
  modeUnsupported: ({ model, requestedMode }) => `${model.name} does not support ${requestedMode}-to-video. Choose a compatible model.`,
  textSourceConflict: ({ model }) => `${model.name} text-to-video cannot consume a conditioning image — switch to image mode or remove the source.`,
  imageRequiresFirst: ({ model }) => `${model.name} image-to-video requires a source image — choose an existing gallery image or upload one.`,
  imageLastConflict: ({ model }) => `${model.name} image-to-video takes a single first-frame image — switch to FFLF mode to use a last frame.`,
  fflfRequiresImage: ({ model }) => `${model.name} FFLF requires a first and/or last frame image.`,
});

/**
 * The per-runtime rows. `modeCeiling` is the set of modes the *helper* has
 * arguments for — a `null` ceiling means the registry entry's `supportedModes`
 * is the only authority. A row's `codePrefix` is what keeps the pre-existing
 * per-runtime error codes (`WAN22_*`, `MINIMAX_H3_*`) intact: no client reads
 * them, but they are the server's API contract and this refactor doesn't move
 * them.
 */
const VIDEO_MODE_CONTRACTS = Object.freeze({
  wan22: {
    codePrefix: 'WAN22',
    chainCode: 'WAN22_CHAIN_REQUIRES_IMAGE_MODE',
    // No ceiling: MLX-Gen's Wan CLI takes whatever the profile declares, and an
    // entry with no `supportedModes` at all declares nothing — so it renders
    // nothing, which is how both wan22 boundaries have always read it.
    modeCeiling: null,
    // The wan22 lane rejects multi-keyframe / extend / audio / IC inputs by
    // runtime elsewhere (KEYFRAMES_REQUIRE_LTX2, A2V_REQUIRES_LTX2,
    // IC_LORA_REQUIRES_LTX2), so folding them in here would double-report.
    extraConditioningUnsupported: false,
    messages: {
      modeUnsupported: ({ model, requestedMode }) => `${model.name} does not support ${requestedMode}-to-video. Choose a compatible Wan model.`,
      textSourceConflict: () => 'Wan 2.2 text-to-video cannot consume a source image — switch to image mode or remove the source.',
      // Two phrasings, one rule: before staging, the caller can still supply an
      // upload; after resolution, the gallery pick they *did* supply didn't
      // resolve, and "upload one" would be misleading advice.
      imageRequiresFirst: ({ sourceResolved }) => (sourceResolved
        ? 'Wan 2.2 image-to-video requires a resolvable source image — choose an existing gallery image or upload one.'
        : 'Wan 2.2 image-to-video requires a source image — upload one before running this model.'),
    },
  },
  minimax_h3: {
    codePrefix: 'MINIMAX_H3',
    modeCeiling: MINIMAX_H3_MODES,
    extraConditioningUnsupported: true,
    messages: {
      modeUnsupported: ({ allowedModes }) => `MiniMax H3 MLX supports ${allowedModes.join(', ') || 'no'} modes only; remove multi-keyframe, video, audio, or reference conditioning.`,
      textSourceConflict: () => 'MiniMax H3 text-to-video cannot consume a conditioning image — switch to image or FFLF mode.',
      imageRequiresFirst: () => 'MiniMax H3 image-to-video requires a source image — choose an existing gallery image or upload one.',
      imageLastConflict: () => 'MiniMax H3 image-to-video takes a single first-frame image — switch to FFLF mode to use a last frame.',
      fflfRequiresImage: () => 'MiniMax H3 FFLF requires a first and/or last frame image.',
    },
  },
});

// An empty array is "no references", not "references present" — and an empty
// string path is no path. Everything else non-nullish counts.
/**
 * The runtimes whose mode/source pairing this contract gates. Callers that need
 * to do gate-adjacent work (the render path promotes a legacy upload field into
 * `sourceImagePath` before checking) read the set rather than re-listing names.
 */
export const VIDEO_MODE_GATED_RUNTIMES = new Set(Object.keys(VIDEO_MODE_CONTRACTS));

const isPresent = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value));

/**
 * The one video mode/source contract, driven by `model.supportedModes`. Returns
 * a ServerError to throw, or null when the request is legal (including for a
 * runtime that declares no row — ltx2, mlx_video and hunyuan gate their modes
 * through their own helpers).
 *
 * `supportedModes` comes off the registry entry so the picker and the API agree
 * even on an install whose `data/media-models.json` was hand-edited or narrowed;
 * a row's `modeCeiling` stays the ceiling, because an entry can't declare a mode
 * the helper has no arguments for.
 *
 * @param {object} opts
 * @param {object} opts.model - registry entry (`runtime`, `name`, `supportedModes`)
 * @param {string} [opts.mode] - requested semantic mode; unset resolves from the images
 * @param {boolean} [opts.hasFirstImage] - a first-frame image is present
 * @param {boolean} [opts.hasLastImage] - a last-frame image is present
 * @param {boolean} [opts.sourceResolved] - the caller has already resolved the
 *   source to a real path (post-staging boundary), which picks the phrasing that
 *   doesn't tell the user to upload a file they already supplied
 * @returns {ServerError|null}
 */
export const videoModeContractError = ({
  model,
  mode,
  hasFirstImage = false,
  hasLastImage = false,
  sourceResolved = false,
  keyframes = null,
  extendFromVideo = null,
  audioFile = null,
  audioStartSec = null,
  icReferences = null,
}) => {
  const contract = VIDEO_MODE_CONTRACTS[model?.runtime];
  if (!contract) return null;
  const { codePrefix, modeCeiling, extraConditioningUnsupported } = contract;
  const messages = { ...DEFAULT_MESSAGES, ...contract.messages };
  const requestedMode = mode || (hasFirstImage ? 'image' : 'text');
  const declaredModes = model?.supportedModes;
  const allowedModes = Array.isArray(declaredModes)
    ? (modeCeiling ? declaredModes.filter((m) => modeCeiling.includes(m)) : declaredModes)
    : (modeCeiling ?? []);
  const ctx = { model, requestedMode, allowedModes, sourceResolved };
  const fail = (key, code) => new ServerError(messages[key](ctx), { status: 400, code });

  const extraConditioning = extraConditioningUnsupported && (
    isPresent(keyframes) || isPresent(extendFromVideo) || isPresent(audioFile)
    || audioStartSec != null || isPresent(icReferences)
  );
  if (!allowedModes.includes(requestedMode) || extraConditioning) {
    return fail('modeUnsupported', `${codePrefix}_MODE_UNSUPPORTED`);
  }
  // Each mode has exactly one legal image shape. Silently dropping (or silently
  // adding) a keyframe would render a materially different clip than asked for.
  if (requestedMode === 'text' && (hasFirstImage || hasLastImage)) {
    return fail('textSourceConflict', `${codePrefix}_TEXT_MODE_SOURCE_CONFLICT`);
  }
  if (requestedMode === 'image' && !hasFirstImage) {
    return fail('imageRequiresFirst', `${codePrefix}_I2V_REQUIRES_IMAGE`);
  }
  // The last-frame pair rules only mean something on a runtime that can anchor
  // one, so they key off the resolved mode set rather than the runtime name — a
  // profile that never declares 'fflf' (every wan22 profile today) keeps its
  // historical indifference to a stray last frame instead of gaining a new
  // rejection in a refactor.
  if (allowedModes.includes('fflf')) {
    if (requestedMode === 'image' && hasLastImage) {
      return fail('imageLastConflict', `${codePrefix}_I2V_LAST_IMAGE_CONFLICT`);
    }
    if (requestedMode === 'fflf' && !hasFirstImage && !hasLastImage) {
      return fail('fflfRequiresImage', `${codePrefix}_FFLF_REQUIRES_IMAGE`);
    }
  }
  return null;
};

/**
 * Chunk chaining seeds chunk N+1 from chunk N's extracted last frame, so it
 * needs image-to-video on any runtime. Returns a ServerError for a model that
 * lacks it, else null.
 *
 * An entry with no declared `supportedModes` is permitted — unset means
 * "unconstrained", not "text-only" — and both boundaries must read it that way,
 * which is why this is one function rather than a rule re-typed per runtime.
 */
export const videoChainUnsupportedError = (model) => {
  if (!Array.isArray(model?.supportedModes) || model.supportedModes.includes('image')) return null;
  return new ServerError(
    `${model.name} cannot generate chunks > 1 because continuation requires image-to-video support.`,
    {
      status: 400,
      code: VIDEO_MODE_CONTRACTS[model.runtime]?.chainCode || 'VIDEO_CHAIN_REQUIRES_IMAGE_MODE',
    },
  );
};
