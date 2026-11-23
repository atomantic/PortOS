import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { mediaJobEvents } from './mediaJobQueue/state.js';
import { fileCompletedOwnedMedia, queueCollectionSources } from './mediaCollectionRules.js';

let initialized = false;

export function initMediaCollectionCompletionHook() {
  if (initialized) return;
  initialized = true;
  mediaJobEvents.on('completed', (job) => {
    if (!queueCollectionSources(job).length) return;
    withBackupAssetPublication(() => fileCompletedOwnedMedia(job))
      .catch(error => console.error(`❌ Filing media for completed job ${job.id} failed: ${error.message}`));
  });
}
