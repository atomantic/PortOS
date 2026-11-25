/**
 * Local image-runtime vocabulary — readiness verdicts, runtime ids, and the
 * remedy kinds that name the ONE action that fixes each unavailable state.
 */

import { isFlux2, usesDiffusersRunner } from './runners.js';

export const MOSS_IMAGE_MODEL_ID = 'moss-image-sft-bf16';
export const MINIMAX_H3_IMAGE_MODEL_ID = 'minimax-h3-image-bf16';

export const IMAGE_RUNTIME_READINESS = Object.freeze({
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
});

// Which runtime backs a selected local model. FLUX.2, Z-Image, ERNIE, HiDream
// and Qwen all share ONE torch+diffusers venv (isFlux2/usesDiffusersRunner in
// runners.js gate the same `isFlux2VenvHealthy` probe), so they share one
// runtime id and one install remedy. mflux models run on the configurable
// interpreter from settings.imageGen.local.pythonPath.
export const IMAGE_RUNTIME = Object.freeze({
  TORCH_VENV: 'torch-venv',
  MFLUX_PYTHON: 'mflux-python',
  MOSS_SWIFT: 'moss-swift',
  FLUX3: 'flux3',
  MINIMAX_H3_IMAGE: 'minimax-h3-image',
});

export const IMAGE_RUNTIME_LABELS = Object.freeze({
  [IMAGE_RUNTIME.TORCH_VENV]: 'Shared torch runtime (FLUX.2 · Z-Image · ERNIE · HiDream · Qwen)',
  [IMAGE_RUNTIME.MFLUX_PYTHON]: 'mflux Python interpreter',
  [IMAGE_RUNTIME.FLUX3]: 'FLUX.3 Klein / MLX (isolated mflux 0.23.0)',
  [IMAGE_RUNTIME.MOSS_SWIFT]: 'MOSS Swift / MLX (SFT bf16, text-to-image)',
  [IMAGE_RUNTIME.MINIMAX_H3_IMAGE]: 'MiniMax H3 MLX (shared with H3 video)',
});

// Which runtime a model needs. Shipping the vocabulary without the CLASSIFIER
// left `isFlux2(m) || usesDiffusersRunner(m)` hand-copied at five call sites, so
// adding a sixth diffusers family meant finding all of them — exactly the drift
// the enum exists to end. `services/imageGen/regen.js` re-exports this as
// `modelUsesFluxVenv` for its existing callers.
export const imageRuntimeFor = (model) =>
  model?.runner === IMAGE_RUNTIME.FLUX3 ? IMAGE_RUNTIME.FLUX3
    : model?.runner === IMAGE_RUNTIME.MINIMAX_H3_IMAGE ? IMAGE_RUNTIME.MINIMAX_H3_IMAGE
    : model?.runner === IMAGE_RUNTIME.MOSS_SWIFT ? IMAGE_RUNTIME.MOSS_SWIFT
    : (isFlux2(model) || usesDiffusersRunner(model)) ? IMAGE_RUNTIME.TORCH_VENV : IMAGE_RUNTIME.MFLUX_PYTHON;

// Settings can identify a shipped pin before the model catalog loads.
// Keep this browser-safe list in sync with the shipped registry via the parity test.
const SELF_MANAGED_LOCAL_IMAGE_MODEL_IDS = new Set([
  MOSS_IMAGE_MODEL_ID,
  MINIMAX_H3_IMAGE_MODEL_ID,
  'flux3-klein-q4',
  'flux3-klein-q6',
  'flux3-klein-q8',
  'flux2-klein-4b',
  'flux2-klein-9b',
  'flux2-klein-4b-int8',
  'flux2-klein-9b-bf16',
  'hidream-i1-full',
  'hidream-i1-fast',
  'qwen-image',
  'qwen-image-edit',
  'qwen-image-2.1',
  'z-image-turbo-bf16',
  'z-image-turbo-quant',
  'ernie-image',
  'ernie-image-turbo',
]);

export const isSelfManagedLocalImageModelId = (modelId) => SELF_MANAGED_LOCAL_IMAGE_MODEL_IDS.has(modelId);

export const usesFlux3 = (model) => imageRuntimeFor(model) === IMAGE_RUNTIME.FLUX3;

export const usesMinimaxH3Image = (model) => imageRuntimeFor(model) === IMAGE_RUNTIME.MINIMAX_H3_IMAGE;

export const usesMossSwift = (model) => imageRuntimeFor(model) === IMAGE_RUNTIME.MOSS_SWIFT;

export const usesTorchVenv = (model) => imageRuntimeFor(model) === IMAGE_RUNTIME.TORCH_VENV;

// The single action that resolves each unavailable state. The client maps these
// onto one button apiece — see client/src/components/imageGen/LocalRuntimeStatus.jsx.
export const IMAGE_RUNTIME_REMEDY = Object.freeze({
  INSTALL_TORCH_VENV: 'install-torch-venv',
  INSTALL_FLUX3: 'install-flux3',
  INSTALL_MINIMAX_H3: 'install-minimax-h3',
  INSTALL_MOSS_SWIFT: 'install-moss-swift',
  DOWNLOAD_MOSS_WEIGHTS: 'download-moss-weights',
  INSTALL_PACKAGES: 'install-packages',
  SET_PYTHON_PATH: 'set-python-path',
  SWITCH_PYTHON: 'switch-python',
  CHOOSE_MODEL: 'choose-model',
});
