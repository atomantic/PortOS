/**
 * MiniMax H3's non-mode control gate — the knobs H3 fixes in the model itself
 * rather than exposing to the caller.
 *
 * Companion to `modeContract.js`, which owns the mode/source rules and
 * explicitly leaves "H3's fps / negative-prompt / tiling / frame-grid checks"
 * to their call sites. There are TWO such call sites — the enqueue boundary
 * (`prepareParams.js`, which must clean up staged uploads before it throws) and
 * the render boundary (`local.js#buildMiniMaxH3Args`) — and they carried
 * near-identical copies of all five checks. That is the same shape that had
 * already drifted once before #3736 collapsed the mode gates, so the checks
 * live here and both boundaries call in.
 *
 * Returns a ServerError to throw, or null when every control is legal, so a
 * caller with teardown to run (`await cleanupStaged()`) can do it before
 * throwing. Same convention as `videoModeContractError`.
 *
 * Covers every H3 runtime. The controls are facts about the checkpoint — 24
 * fps, joint video+audio, CFG-distilled, a 17n+5 frame grid — so the MLX port
 * and the diffusers CUDA path enforce the identical set. The one thing that
 * genuinely differs is the legal frame WINDOW (diffusers requires the snapped
 * duration to land in 5-15 s where the MLX port accepts 4-15 s), so the grid
 * check reads the entry's own `frameOptions` rather than a hardcoded range.
 */

import { ServerError } from '../../lib/errorHandler.js';

const h3Error = (message, code) => new ServerError(message, { status: 400, code });

// The canonical coercion, matching `routes/videoGen.js`. The route's schema
// types this field as `z.union([z.boolean(), z.literal('true'), z.literal('false')])`
// and every internal producer passes a real boolean, so `true | false | 'true' |
// 'false' | undefined` is the whole input space — and `'false'` is why a plain
// truthiness check is wrong (`Boolean('false')` is true, which would read an
// explicit opt-OUT as an opt-in).
const isRequestedTrue = (value) => value === true || value === 'true';

/**
 * @param {object} opts
 * @param {object} opts.model - registry entry (`frameOptions`, `runtime`)
 * @param {string} [opts.negativePrompt]
 * @param {boolean|string} [opts.disableAudio]
 * @param {string} [opts.tiling]
 * @param {number|string} [opts.numFrames]
 * @param {number|string} [opts.fps]
 * @returns {ServerError|null}
 */
export const minimaxH3ControlError = ({ model, negativePrompt, disableAudio, tiling, numFrames, fps }) => {
  if (typeof negativePrompt === 'string' && negativePrompt.trim()) {
    return h3Error(
      'MiniMax H3 is CFG-distilled and does not accept a negative prompt.',
      'MINIMAX_H3_NEGATIVE_PROMPT_UNSUPPORTED',
    );
  }
  if (isRequestedTrue(disableAudio)) {
    return h3Error(
      'MiniMax H3 jointly generates video and audio; its audio track cannot be disabled.',
      'MINIMAX_H3_AUDIO_REQUIRED',
    );
  }
  if (tiling && tiling !== 'auto') {
    return h3Error(
      'MiniMax H3 does not expose a tiling mode.',
      'MINIMAX_H3_TILING_UNSUPPORTED',
    );
  }
  const options = Array.isArray(model?.frameOptions) ? model.frameOptions : [];
  const frames = Number(numFrames);
  if (!options.includes(frames)) {
    // Quote the entry's own window rather than a constant: the two runtimes
    // ship different grids, and an install that narrowed its own frameOptions
    // would otherwise be told to use a frame count this build rejects.
    const window = options.length > 0
      ? `between ${options[0]} and ${options[options.length - 1]}`
      : 'from this model\'s frame options';
    return h3Error(
      `MiniMax H3 requires a 17n+5 frame count ${window}; got ${numFrames}.`,
      'MINIMAX_H3_INVALID_FRAME_COUNT',
    );
  }
  if (Number(fps) !== 24) {
    return h3Error(
      `MiniMax H3 runs at a fixed 24 fps; got ${fps}.`,
      'MINIMAX_H3_INVALID_FPS',
    );
  }
  return null;
};
