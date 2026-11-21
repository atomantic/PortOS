/** Shared collection destinations for render completions and on-demand repair. */
import { parseKey, itemKey } from '../lib/mediaItemKey.js';
import * as collections from './mediaCollections.js';

export const imageItem = (ref) => ({ kind: 'image', ref });
export const videoItem = (ref) => ({ kind: 'video', ref });

const rules = {
  deck: {
    ownerId: job => job.params?.deckCard?.deckId,
    load: async id => (await import('./decks.js')).getDeck(id, { reconcileRenders: false }),
    collection: deck => collections.findOrCreateDeckCollection({ deckId: deck.id, deckName: deck.name }),
  },
  moodBoard: {
    ownerId: job => job.params?.moodBoardRender?.boardId || job.params?.moodBoardPoster?.boardId
      || /^mood-board-poster:([A-Za-z0-9_-]+)$/.exec(job.owner)?.[1],
    load: async id => (await import('./moodBoard/db.js')).getBoard(id),
    collection: board => collections.findOrCreateMoodBoardCollection({ boardId: board.id, boardName: board.name }),
  },
  storyboard: {
    ownerId: job => job.params?.storyboardPanelRender?.storyboardId,
    load: async id => (await import('./storyboards/index.js')).getStoryboard(id),
    collection: owner => collections.findOrCreateStoryboardCollection(owner),
  },
  fableLoom: {
    ownerId: job => job.params?.fableLoom?.loomId,
    load: async id => (await import('./fableLoom/records.js')).getLoom(id),
    collection: owner => collections.findOrCreateFableLoomCollection(owner),
  },
  musicVideo: {
    ownerId: job => job.params?.musicVideo?.projectId || job.params?.musicVideoProjectId,
    collection: project => collections.findOrCreateMusicVideoCollection({ projectId: project.id, projectName: project.name }),
  },
  timeline: { collection: owner => collections.findOrCreateTimelineCollection(owner) },
  sprite: {
    ownerId: job => job.params?.spriteRef?.recordId,
    load: async id => (await import('./sprites/records.js')).getRecord(id),
    collection: owner => collections.findOrCreateSpriteCollection(owner),
  },
  composition: { collection: () => collections.findOrCreateCompositionsCollection() },
  universeRun: {
    ownerId: job => job.params?.universeRun?.collectionId,
    collection: collection => collection,
  },
  creativeDirector: {
    ownerId: job => job.params?.creativeDirector?.projectId,
    load: async id => (await import('./creativeDirector/local.js')).getProject(id),
    collection: project => project.collectionId && { id: project.collectionId },
  },
  writersRoom: {
    ownerId: job => job.params?.writersRoom?.workId,
    collection: async work => (await import('./writersRoom/local.js')).ensureWorkMediaCollection(work.id),
  },
  external: { collection: () => collections.findOrCreateExternalCollection() },
  universe: {
    collection: universe => collections.findOrCreateUniverseCollection({ universeId: universe.id, universeName: universe.name || universe.id }),
  },
  series: {
    collection: series => collections.findOrCreateSeriesCollection({ seriesId: series.id, seriesName: series.name || series.id }),
  },
};

export function jobCollectionSources(job) {
  if (job.kind !== 'image' && job.kind !== 'video') return [];
  return Object.entries(rules).flatMap(([source, rule]) => {
    const id = rule.ownerId?.(job);
    return typeof id === 'string' && id ? [{ source, id }] : [];
  });
}

export function jobCollectionItems(job) {
  if (job.kind === 'image') return [imageItem(job.result?.filename), imageItem(job.result?.finishedVariant?.filename)];
  if (job.kind === 'video') {
    return Array.isArray(job.result?.videos) && job.result.videos.length
      ? job.result.videos.map(video => videoItem(video?.id))
      : [videoItem(job.result?.generationId || job.id)];
  }
  return [];
}

export function collectionItems(items) {
  const unique = new Map();
  for (const item of items) {
    const { ref } = item;
    if (typeof ref !== 'string' || ref !== ref.trim() || /[/\\\x00-\x1f]/.test(ref)) continue;
    const key = itemKey(item);
    if (parseKey(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

export async function fileOwnedMedia(source, owner, items, options) {
  if (!owner) return null;
  const add = collectionItems(items);
  if (!add.length) return null;
  const collection = await rules[source].collection(owner);
  if (!collection) return null;
  return collections.bulkUpdateCollectionItems(collection.id, { add }, options);
}

// Sources whose queue completions need collection filing here. Other hooks
// retain work-specific behavior such as music video clip provenance.
const queueOwnedSources = new Set(['deck', 'moodBoard', 'storyboard', 'fableLoom', 'creativeDirector', 'sprite']);

export function queueCollectionSources(job) {
  return jobCollectionSources(job).filter(({ source }) => queueOwnedSources.has(source)
    && (source !== 'moodBoard' || job.params?.moodBoardPoster));
}

export async function fileCompletedOwnedMedia(job) {
  for (const { source, id } of queueCollectionSources(job)) {
    const owner = await rules[source].load(id).catch((error) => {
      if (['NOT_FOUND', 'DECK_NOT_FOUND'].includes(error.code)) return null;
      throw error;
    });
    await fileOwnedMedia(source, owner, jobCollectionItems(job));
  }
}

/** Post-publication bookkeeping must not turn a successful export into a failed render. */
export async function fileOwnedMediaBestEffort(source, owner, items) {
  await fileOwnedMedia(source, owner, items)
    .catch(error => console.error(`❌ Collection filing failed for ${source} ${owner.id}: ${error.message}`));
}

export const fileCompositionVideos = ids =>
  fileOwnedMediaBestEffort('composition', { id: 'compositions' }, ids.map(videoItem));
