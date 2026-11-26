/**
 * Retirement response and media admission gate during retired data removal.
 */

import { ServerError } from './errorHandler.js';

export const TRAINING_RETIRED_MESSAGE = 'LoRA training is retired. Any remaining datasets, checkpoints and adapters are kept on disk. Use reference images for new generation; delete retained files from the LoRAs page.';

export function refuseRetiredTraining() {
  throw new ServerError(TRAINING_RETIRED_MESSAGE, { status: 410, code: 'LORA_TRAINING_RETIRED' });
}

let removingRetiredData = false;
export function assertRetiredDataAvailable() {
  if (removingRetiredData) throw new ServerError('Data maintenance is removing retired inputs. Retry after it finishes.', { status: 409, code: 'DATA_MAINTENANCE_ACTIVE' });
}
export async function withRetiredDataRemoval(work) {
  assertRetiredDataAvailable();
  removingRetiredData = true;
  try { return await work(); }
  finally { removingRetiredData = false; }
}
