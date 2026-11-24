import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { mediaJobEvents } from './mediaJobQueue/state.js';
import { fileOwnedMedia, jobCollectionItems, jobCollectionSources } from './mediaCollectionRules.js';

// Sources whose queue completions need collection filing here. Other hooks
// retain work-specific behavior such as music video clip provenance.
const queueOwnerLoaders = {
  deck: async id => (await import('./decks.js')).getDeck(id, { reconcileRenders: false }),
  moodBoard: async id => (await import('./moodBoard/db.js')).getBoard(id),
  storyboard: async id => (await import('./storyboards/index.js')).getStoryboard(id),
  fableLoom: async id => (await import('./fableLoom/records.js')).getLoom(id),
  sprite: async id => (await import('./sprites/records.js')).getRecord(id),
  creativeDirector: async id => (await import('./creativeDirector/local.js')).getProject(id),
};

function queueCollectionSources(job) {
  return jobCollectionSources(job).filter(({ source }) => Object.hasOwn(queueOwnerLoaders, source)
    && (source !== 'moodBoard' || job.params?.moodBoardPoster));
}

async function fileCompletedOwnedMedia(job, sources) {
  const items = jobCollectionItems(job);
  for (const { source, id } of sources) {
    const owner = await queueOwnerLoaders[source](id).catch((error) => {
      if (['NOT_FOUND', 'DECK_NOT_FOUND'].includes(error.code)) return null;
      throw error;
    });
    await fileOwnedMedia(source, owner, items);
  }
}

let initialized = false;

export function initMediaCollectionCompletionHook() {
  if (initialized) return;
  initialized = true;
  mediaJobEvents.on('completed', (job) => {
    const sources = queueCollectionSources(job);
    if (!sources.length) return;
    withBackupAssetPublication(() => fileCompletedOwnedMedia(job, sources))
      .catch(error => console.error(`❌ Filing media for completed job ${job.id} failed: ${error.message}`));
  });
}
