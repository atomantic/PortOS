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
 * Dependency-free apart from the error leaf and the registry's pure per-runtime
 * mode table (`lib/videoModeProfiles.js`), which keeps it importable from
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
import { VIDEO_RUNTIME_MODES, resolveVideoSupportedModes } from '../../lib/videoModeProfiles.js';
import { i2vReferenceModeViolation } from '../../lib/videoReferenceModes.js';

// H3's fl2va path conditions on up to two keyframes anchored at the first and
// last latent frame — so text, image (first only) and FFLF (first + last) all
// run, while extend / a2v / IC-remix and the ltx2 multi-keyframe array (which
// pins arbitrary frame indices H3 has no anchor for) still have no equivalent.
// Re-exported from the registry's per-runtime table (#3737) so the ceiling and
// the backfilled `supportedModes` can't drift into two different answers.
export const MINIMAX_H3_MODES = VIDEO_RUNTIME_MODES.minimax_h3;

// Message defaults, used for any rule a runtime row doesn't phrase itself. Each
// takes `{ model, requestedMode, allowedModes }` so a new runtime can adopt the
// whole table by declaring nothing but its code prefix.
const DEFAULT_MESSAGES = Object.freeze({
  modeUnsupported: ({ model, requestedMode }) => `${model.name} does not support ${requestedMode}-to-video. Choose a compatible model.`,
  textSourceConflict: ({ model }) => `${model.name} text-to-video cannot consume a conditioning image — switch to image mode or remove the source.`,
  imageRequiresFirst: ({ model }) => `${model.name} image-to-video requires a source image — choose an existing gallery image or upload one.`,
  imageLastConflict: ({ model }) => `${model.name} image-to-video takes a single first-frame image — switch to FFLF mode to use a last frame.`,
  fflfRequiresImage: ({ model }) => `${model.name} FFLF requires a first and/or last frame image.`,
  a2vRequiresFirst: ({ model }) => `${model.name} audio-to-video requires a reference image.`,
  a2vRequiresAudio: ({ model }) => `${model.name} audio-to-video requires an audio file.`,
});

// H3's text/image runtimes share ONE row: the mode rules come from the fl2va
// checkpoint partition, not from the MLX / diffusers runner in front of it, and
// the error codes are the same `MINIMAX_H3_*` contract on both — so both keys
// below reference this object rather than each carrying a copy, which is
// exactly what drifted before #3736. `modeUnsupported` names the model rather
// than the runtime for the same reason: a message that hardcoded one runtime's
// name would be wrong for whichever entry it wasn't written for.
const MINIMAX_H3_CONTRACT = Object.freeze({
  codePrefix: 'MINIMAX_H3',
  modeCeiling: MINIMAX_H3_MODES,
  extraConditioningUnsupported: true,
  messages: Object.freeze({
    modeUnsupported: ({ model, allowedModes }) => `${model.name} supports ${allowedModes.join(', ') || 'no'} modes only; remove multi-keyframe, video, audio, or reference conditioning.`,
    textSourceConflict: () => 'MiniMax H3 text-to-video cannot consume a conditioning image — switch to image or FFLF mode.',
    imageRequiresFirst: () => 'MiniMax H3 image-to-video requires a source image — choose an existing gallery image or upload one.',
    imageLastConflict: () => 'MiniMax H3 image-to-video takes a single first-frame image — switch to FFLF mode to use a last frame.',
    fflfRequiresImage: () => 'MiniMax H3 FFLF requires a first and/or last frame image.',
  }),
});

const MINIMAX_H3_REF2VA_CONTRACT = Object.freeze({
  codePrefix: 'MINIMAX_H3_REF2VA',
  modeCeiling: VIDEO_RUNTIME_MODES.minimax_h3_ref2va,
  extraConditioningUnsupported: false,
  a2vRequiresFirst: true,
  a2vRequiresAudio: true,
  messages: Object.freeze({
    modeUnsupported: ({ model }) => `${model.name} supports image-and-audio to video only.`,
    a2vRequiresFirst: () => 'MiniMax H3 Ref2VA audio-to-video requires a reference image — choose an existing gallery image or upload one.',
    a2vRequiresAudio: () => 'MiniMax H3 Ref2VA audio-to-video requires an audio file.',
  }),
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
    // No ceiling: MLX-Gen's Wan CLI takes whatever the profile declares, and
    // resolveVideoSupportedModes narrows an entry that declares nothing to the
    // wan22 row (text + image) rather than leaving it unconstrained.
    modeCeiling: null,
    // The wan22 lane rejects multi-keyframe / extend / audio / IC inputs by
    // runtime elsewhere, so folding them in here would double-report.
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
  fastvideo: {
    codePrefix: 'FASTVIDEO',
    chainCode: 'FASTVIDEO_CHAIN_REQUIRES_IMAGE_MODE',
    modeCeiling: null,
    extraConditioningUnsupported: false,
    messages: {
      modeUnsupported: ({ model, requestedMode }) => `${model.name} does not support ${requestedMode}-to-video. Choose a compatible FastVideo model.`,
      textSourceConflict: () => 'FastVideo text-to-video cannot consume a source image — switch to image mode or remove the source.',
      imageRequiresFirst: ({ sourceResolved }) => (sourceResolved
        ? 'FastVideo image-to-video requires a resolvable source image — choose an existing gallery image or upload one.'
        : 'FastVideo image-to-video requires a source image — upload one before running this model.'),
    },
  },
  minimax_h3: MINIMAX_H3_CONTRACT,
  minimax_h3_cuda: MINIMAX_H3_CONTRACT,
  minimax_h3_ref2va: MINIMAX_H3_REF2VA_CONTRACT,
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
 * runtime that declares no row — ltx2 and mlx_video gate their modes through
 * their own helpers).
 *
 * `supportedModes` comes off the registry entry (resolved from the runtime table
 * when the entry declares none) so the picker and the API agree even on an
 * install whose `data/media-models.json` was hand-edited or narrowed; a row's
 * `modeCeiling` stays the ceiling, because an entry can't declare a mode the
 * helper has no arguments for.
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
  const {
    codePrefix,
    modeCeiling,
    extraConditioningUnsupported,
    a2vRequiresFirst,
    a2vRequiresAudio,
  } = contract;
  const messages = { ...DEFAULT_MESSAGES, ...contract.messages };
  const requestedMode = mode || (hasFirstImage ? 'image' : 'text');
  const declaredModes = resolveVideoSupportedModes(model);
  const allowedModes = modeCeiling
    ? declaredModes.filter((m) => modeCeiling.includes(m))
    : declaredModes;
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
  if (requestedMode === 'a2v' && a2vRequiresFirst && !hasFirstImage) {
    return fail('a2vRequiresFirst', `${codePrefix}_A2V_REQUIRES_IMAGE`);
  }
  if (requestedMode === 'a2v' && a2vRequiresAudio && !isPresent(audioFile)) {
    return fail('a2vRequiresAudio', `${codePrefix}_A2V_REQUIRES_AUDIO`);
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
 * An entry that declares no `supportedModes` resolves them from its runtime
 * (lib/videoModeProfiles.js) rather than being waved through as unconstrained,
 * so both boundaries and the client's picker read one answer — which is why this
 * is one function rather than a rule re-typed per runtime.
 */
export const videoChainUnsupportedError = (model) => {
  if (resolveVideoSupportedModes(model).includes('image')) return null;
  return new ServerError(
    `${model.name} cannot generate chunks > 1 because continuation requires image-to-video support.`,
    {
      status: 400,
      code: VIDEO_MODE_CONTRACTS[model.runtime]?.chainCode || 'VIDEO_CHAIN_REQUIRES_IMAGE_MODE',
    },
  );
};

/**
 * The i2v reference-mode gate (#4874) — is the promise this request makes about
 * its conditioning image one the selected model can actually keep?
 *
 * Deliberately a SEPARATE rule from `videoModeContractError` above: that one is
 * per-runtime mode/source pairing (which is why it returns null for a runtime
 * with no row), while this axis is orthogonal and applies to EVERY runtime —
 * `anchor` is the universal default, and any other value has to be earned. The
 * rule itself is stated once, purely, in `lib/videoReferenceModes.js` so the
 * client can preview the same verdict; this only wraps the verdict in the
 * ServerError the route and the render boundary throw.
 *
 * @param {object} opts - see `i2vReferenceModeViolation`
 * @returns {ServerError|null}
 */
export const videoReferenceModeError = (opts) => {
  const violation = i2vReferenceModeViolation(opts);
  if (!violation) return null;
  return new ServerError(violation.message, { status: 400, code: violation.code });
};
