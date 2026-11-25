import { ServerError } from '../../lib/errorHandler.js';
import { VIDEO_GEN_MODE } from '../../lib/generationModes.js';

export function assertReactorNegativePromptSupported(backend, negativePrompt) {
  if (backend === VIDEO_GEN_MODE.REACTOR && negativePrompt?.trim()) {
    throw new ServerError('Reactor does not support a negative prompt. Put the exclusions in the main prompt or choose a compatible video backend.', {
      status: 400, code: 'VIDEO_BACKEND_INPUT_UNSUPPORTED',
    });
  }
}
