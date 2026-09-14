/**
 * Local image-runtime vocabulary — readiness verdicts, runtime ids, and the
 * remedy kinds that name the ONE action that fixes each unavailable state.
 *
 * Lives in `lib/` rather than beside the image-gen service because several
 * layers have to agree and none can afford the others' import closure: the
 * diagnosis (`services/imageGen/localRuntime.js`), the renderer
 * (`services/imageGen/local.js`), `services/imageGen/regen.js`, and the client,
 * which re-exports this through `client/src/lib/imageGenModes.js` so a remedy
 * kind is never hand-copied into a component. Naming is `IMAGE_RUNTIME_*`, not
 * `LOCAL_RUNTIME_*`, so nothing here reads as a sibling of
 * `localProviderRuntime.js`'s `LOCAL_RUNTIMES` — that is the local-LLM provider
 * roster, an unrelated domain.
 */

import { isFlux2, usesDiffusersRunner } from './runners.js';

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
});

export const IMAGE_RUNTIME_LABELS = Object.freeze({
  [IMAGE_RUNTIME.TORCH_VENV]: 'Shared torch runtime (FLUX.2 · Z-Image · ERNIE · HiDream · Qwen)',
  [IMAGE_RUNTIME.MFLUX_PYTHON]: 'mflux Python interpreter',
});

// Which runtime a model needs. Shipping the vocabulary without the CLASSIFIER
// left `isFlux2(m) || usesDiffusersRunner(m)` hand-copied at five call sites, so
// adding a sixth diffusers family meant finding all of them — exactly the drift
// the enum exists to end. `services/imageGen/regen.js` re-exports this as
// `modelUsesFluxVenv` for its existing callers.
export const imageRuntimeFor = (model) =>
  (isFlux2(model) || usesDiffusersRunner(model)) ? IMAGE_RUNTIME.TORCH_VENV : IMAGE_RUNTIME.MFLUX_PYTHON;

export const usesTorchVenv = (model) => imageRuntimeFor(model) === IMAGE_RUNTIME.TORCH_VENV;

// The single action that resolves each unavailable state. The client maps these
// onto one button apiece — see client/src/components/imageGen/LocalRuntimeStatus.jsx.
export const IMAGE_RUNTIME_REMEDY = Object.freeze({
  INSTALL_TORCH_VENV: 'install-torch-venv',
  INSTALL_PACKAGES: 'install-packages',
  SET_PYTHON_PATH: 'set-python-path',
  SWITCH_PYTHON: 'switch-python',
  CHOOSE_MODEL: 'choose-model',
});
