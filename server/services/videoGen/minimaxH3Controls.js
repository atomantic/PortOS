/**
 * MiniMax H3's non-mode control gate: the knobs H3 fixes in the model itself.
 *
 * Companion to `modeContract.js`, which leaves H3's fps / negative-prompt /
 * tiling / frame-grid checks to call sites. Both the enqueue boundary
 * (`prepareParams.js`, which must clean up staged uploads before it throws) and
 * the render boundary (`local.js#buildMiniMaxH3Args`) call in here.
 *
 * Returns a ServerError to throw, or null when every control is legal, so a
 * caller with teardown to run can do it before throwing (same convention as
 * `videoModeContractError`).
 *
 * Covers every H3 runtime: 24 fps, joint video+audio, CFG-distilled, a 17n+5
 * frame grid. The legal frame WINDOW differs (diffusers 5-15 s, MLX 4-15 s), so
 * the grid check reads the entry's own `frameOptions` rather than a constant.
 */

import { ServerError } from '../../lib/errorHandler.js';

import { isTruthyMeta } from '../../lib/metadataFlags.js';
const h3Error = (message, code) => new ServerError(message, { status: 400, code });

// Canonical coercion, matching `routes/videoGen.js`: input is `true | false |
// 'true' | 'false' | undefined`, and `Boolean('false')` is true, so a plain
// truthiness check would read an explicit opt-OUT as an opt-in.

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
  if (isTruthyMeta(disableAudio)) {
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
