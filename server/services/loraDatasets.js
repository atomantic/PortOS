import { withRetiredDataAccess } from '../lib/retiredLoraTraining.js';
/**
 * Retained LoRA training datasets (`data/lora-datasets/<id>/index.json`).
 *
 * Training is retired (#13536): no code creates, captions or renders datasets
 * any more. What remains is the store (verified at boot so retained records
 * keep loading across upgrades) and `updateDataset`, which the surviving-trainer
 * observer in `loraTraining/` uses to flip a retained dataset's status when an
 * outstanding run finishes or its adapter is deleted. Data Maintenance removes
 * the directory itself.
 *
 * Storage: `file-primary` — machine-local, never federated, backed up in full.
 */

import { PATHS } from '../lib/fileUtils.js';
import { createCollectionStore } from '../lib/collectionStore.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { LORA_DATASET_SCHEMA_VERSION, sanitizeLoraDataset } from '../lib/loraDataset.js';
import { ServerError } from '../lib/errorHandler.js';
import { trainingEvents } from './loraTraining/events.js';

export const loraDatasetStore = createCollectionStore({
  dir: PATHS.loraDatasets,
  type: 'lora-datasets',
  schemaVersion: LORA_DATASET_SCHEMA_VERSION,
  sanitizeRecord: sanitizeLoraDataset,
});

/**
 * Read-modify-write a dataset inside its per-id write queue so concurrent
 * mutations merge against the freshest persisted record. `mutate` receives the
 * sanitized record and returns the next record (or null to abort without
 * writing). Backup admission begins before entering the queue.
 */
export async function updateDataset(id, mutate) {
  return withRetiredDataAccess(() => withBackupAssetPublication(() => loraDatasetStore.queueRecordWrite(id, async () => {
    const current = await loraDatasetStore.loadOne(id);
    if (!current) {
      throw new ServerError(`LoRA dataset not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
    }
    const next = await mutate(current);
    if (!next) return current;
    next.updatedAt = new Date().toISOString();
    await loraDatasetStore.saveOneNow(id, next);
    trainingEvents.emit('dataset:changed', { datasetId: id });
    return next;
  })));
}
