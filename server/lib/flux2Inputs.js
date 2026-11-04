import { ServerError } from './errorHandler.js';
import { isFlux2 } from './runners.js';

/** Reject selected inputs before staging or normalization can discard them. */
export function assertFlux2InputsCompatible(model, { hasInitImage = false, referenceCount = 0, loraCount = 0 } = {}) {
  if (!isFlux2(model) || !referenceCount) return;
  if (hasInitImage) {
    throw new ServerError('FLUX.2 cannot combine an init image with reference images. Remove the init image or the references; init-image strength cannot be applied in reference mode.', {
      status: 400, code: 'IMAGE_GEN_FLUX2_INPUTS_INCOMPATIBLE',
    });
  }
  if (loraCount && (model.quantization || 'sdnq') !== 'none') {
    throw new ServerError('This quantized FLUX.2 model cannot combine LoRAs with reference images. Remove the LoRAs or references, or choose a compatible unquantized model.', {
      status: 400, code: 'IMAGE_GEN_FLUX2_INPUTS_INCOMPATIBLE',
    });
  }
}
