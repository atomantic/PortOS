/** Validate inputs shared by local image request admission and runtime argument construction. */

import { ServerError } from './errorHandler.js';
import { assertFlux2InputsCompatible } from './flux2Inputs.js';
import { usesFlux3, usesMinimaxH3Image, usesMossSwift } from './imageRuntimeRemedies.js';

export const DEFAULT_LOCAL_IMAGE_DIMENSION = 1024;

export const MINIMAX_H3_IMAGE_MAX_REFERENCES = 16;
export const MINIMAX_H3_IMAGE_STEPS = 6;
// The adapter renders on a 32px-aligned same-aspect canvas (enlarged below
// 2048x2048) and resizes back, so any size inside the image route's own pixel
// cap works; only the release's 1:3 to 3:1 aspect range is a real limit.
export const MINIMAX_H3_IMAGE_MAX_ASPECT = 3;

export function assertFlux3Inputs({ negativePrompt, width, height, initImagePath, referenceImagePaths = [], referenceImageStrengths = [], loraPaths = [], hasInitImage = Boolean(initImagePath), referenceCount = referenceImagePaths.length, loraCount = loraPaths.length }) {
  const reject = message => { throw new ServerError(message, { status: 400, code: 'FLUX3_INPUT_UNSUPPORTED' }); };
  if (negativePrompt) reject('FLUX.3 Klein has no negative prompt. Describe the desired scene in the prompt.');
  if (hasInitImage) reject('FLUX.3 edits use reference images. Move the init image into a reference slot; image strength is unavailable.');
  if (loraCount) reject('This FLUX.3 integration does not support LoRAs. Remove them before rendering.');
  if (referenceCount > 10) reject('FLUX.3 accepts at most 10 reference images.');
  if (referenceImageStrengths.some(value => Number(value) !== 1)) reject('FLUX.3 reference strength is fixed. Remove per-reference strength overrides.');
  if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 1024 && n % 16 === 0)) {
    reject('FLUX.3 dimensions must be multiples of 16 between 256 and 1024.');
  }
}

export function assertMinimaxH3ImageInputs({ negativePrompt, width, height, steps = null, hasInitImage = false, referenceCount = 0, loraCount = 0, referenceImageStrengths = [] }) {
  const reject = message => { throw new ServerError(message, { status: 400, code: 'MINIMAX_H3_IMAGE_INPUT_UNSUPPORTED' }); };
  if (negativePrompt) reject('MiniMax H3-Image is CFG-distilled and has no negative prompt. Describe the desired scene in the prompt.');
  if (hasInitImage) reject('MiniMax H3-Image edits use reference images. Move the init image into a reference slot; image strength is unavailable.');
  if (loraCount) reject('MiniMax H3-Image does not support LoRAs. Remove them before rendering.');
  if (referenceCount > MINIMAX_H3_IMAGE_MAX_REFERENCES) reject(`MiniMax H3-Image accepts at most ${MINIMAX_H3_IMAGE_MAX_REFERENCES} reference images.`);
  if (referenceImageStrengths.some(value => Number(value) !== 1)) reject('MiniMax H3-Image reference strength is fixed. Remove per-reference strength overrides.');
  const w = Number(width);
  const h = Number(height);
  if (![w, h].every(n => Number.isInteger(n) && n > 0)) reject('MiniMax H3-Image needs a whole-pixel width and height.');
  if (Math.max(w, h) > MINIMAX_H3_IMAGE_MAX_ASPECT * Math.min(w, h)) reject('MiniMax H3-Image supports aspect ratios from 1:3 to 3:1.');
  if (steps != null && Number(steps) !== MINIMAX_H3_IMAGE_STEPS) reject(`MiniMax H3-Image is distilled for exactly ${MINIMAX_H3_IMAGE_STEPS} steps.`);
}

export function assertMossInputs({ negativePrompt, width, height, steps, guidance, seed, hasInitImage, referenceCount, loraCount }) {
  const reject = message => { throw new ServerError(message, { status: 400, code: 'MOSS_INPUT_UNSUPPORTED' }); };
  if (loraCount || hasInitImage || referenceCount) reject('MOSS SFT supports text-to-image only; remove LoRAs and input images.');
  if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 1024 && n % 16 === 0)) {
    reject('MOSS dimensions must be multiples of 16 between 256 and 1024.');
  }
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) reject('MOSS steps must be an integer between 1 and 100.');
  if (!Number.isFinite(guidance) || guidance < 0 || guidance > 10) reject('MOSS guidance must be between 0 and 10.');
  if (guidance === 1 && negativePrompt) reject('MOSS negative prompts require guidance other than 1.');
  if (!Number.isSafeInteger(seed) || seed < 0) reject('MOSS seed must be a nonnegative safe integer.');
}

/**
 * Validate prepared job params; compose callers can supply counts for inputs
 * whose paths are still unstaged. Dimensions and sampler defaults mirror generateImage.
 */
export function assertLocalImageModelInputs(model, params, {
  hasInitImage = Boolean(params.initImagePath),
  referenceCount = params.referenceImagePaths?.length ?? 0,
  loraCount = (params.loraFilenames?.length ?? 0) + (params.loraPaths?.length ?? 0),
} = {}) {
  if (!model) return;
  const inputs = {
    negativePrompt: params.negativePrompt,
    hasInitImage,
    referenceCount,
    loraCount,
    referenceImageStrengths: params.referenceImageStrengths ?? [],
  };
  const width = Number(params.width === undefined ? DEFAULT_LOCAL_IMAGE_DIMENSION : params.width);
  const height = Number(params.height === undefined ? DEFAULT_LOCAL_IMAGE_DIMENSION : params.height);
  const steps = params.steps || model.steps;
  if (usesFlux3(model)) assertFlux3Inputs({ ...inputs, width, height });
  if (usesMinimaxH3Image(model)) assertMinimaxH3ImageInputs({ ...inputs, width, height, steps });
  if (usesMossSwift(model)) {
    assertMossInputs({
      ...inputs, width, height, steps: Number(steps),
      guidance: Number(params.guidance != null && params.guidance !== '' ? params.guidance : model.guidance),
      seed: Number(params.seed ?? 0),
    });
  }
  assertFlux2InputsCompatible(model, inputs);
}
