import { ServerError } from './errorHandler.js';

export const TRAINING_RETIRED_MESSAGE = 'LoRA training is retired. Existing datasets, checkpoints and adapters are preserved. Use reference images for new generation; manage retained files in Settings → Data Maintenance.';

export function refuseRetiredTraining() {
  throw new ServerError(TRAINING_RETIRED_MESSAGE, { status: 410, code: 'LORA_TRAINING_RETIRED' });
}

let removingRetiredData = false;
let retainedDataUsers = 0;
export function assertRetiredDataAvailable() {
  if (removingRetiredData) throw new ServerError('Data maintenance is removing retired inputs. Retry after it finishes.', { status: 409, code: 'DATA_MAINTENANCE_ACTIVE' });
}
export async function withRetiredDataRemoval(work) {
  assertRetiredDataAvailable();
  if (retainedDataUsers > 0) throw new ServerError('Retained training data is being updated or a checkpoint is being promoted. Retry after it finishes.', { status: 409, code: 'MAINTENANCE_BUSY' });
  removingRetiredData = true;
  try { return await work(); }
  finally { removingRetiredData = false; }
}

export async function withRetiredDataAccess(work) {
  assertRetiredDataAvailable();
  retainedDataUsers += 1;
  try { return await work(); }
  finally { retainedDataUsers -= 1; }
}
