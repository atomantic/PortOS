/**
 * Rebuild collection membership from durable project references and the
 * retained completed-job archive. Only file media still known to this install
 * (including peer-hosted assets), and honor explicitly removed memberships.
 */
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { itemKey } from '../lib/mediaItemKey.js';
import { listJobs } from './mediaJobQueue/queueState.js';
import { listCollections } from './mediaCollections.js';
import { collectionItems, fileOwnedMedia, imageItem, jobCollectionItems, jobCollectionSources, videoItem } from './mediaCollectionRules.js';

async function inventory() {
  const [decks, moodBoards, music, storyboards, fable, director, timeline, writers, external, history, sprites] = await Promise.all([
    import('./decks.js'), import('./moodBoard/db.js'), import('./musicVideo/projects.js'),
    import('./storyboards/index.js'), import('./fableLoom/records.js'), import('./creativeDirector/local.js'),
    import('./videoTimeline/local.js'), import('./writersRoom/local.js'), import('./externalMediaCollection.js'),
    import('./videoGen/history.js'), import('./sprites/records.js'),
  ]);
  const [deckRows, boards, musicProjects, storyboardSummaries, looms, directorProjects, timelines, works, downloads, videos, collections, spriteRecords] =
    await Promise.all([
      decks.listDecksForIntegrity(), moodBoards.listBoards(), music.listProjects(), storyboards.listStoryboards(),
      fable.listLooms(), director.listProjects(), timeline.listProjects(), writers.listWorks(),
      external.collectExistingExternalMedia(), history.loadHistory(), listCollections(), sprites.listRecords(),
    ]);
  const storyboardRows = await mapWithConcurrency(storyboardSummaries, 4, async ({ id }) =>
    storyboards.getStoryboard(id).catch(error => {
      if (error.code === 'NOT_FOUND') return null;
      throw error;
    }));

  return {
    sources: {
      deck: deckRows.filter(deck => !deck.deleted),
      moodBoard: boards,
      musicVideo: musicProjects,
      storyboard: storyboardRows.filter(Boolean),
      fableLoom: looms,
      creativeDirector: directorProjects.filter(project => project.collectionId),
      timeline: timelines,
      sprite: spriteRecords,
      composition: [{ id: 'compositions' }],
      writersRoom: works,
      external: [{ id: 'external' }],
      universeRun: collections,
    },
    downloads,
    videos: videos.filter(video => typeof video?.id === 'string' && video.id),
  };
}

function deckImages(deck) {
  return deck.cards.flatMap(card => [
    ...(Array.isArray(card.imageRefs) ? card.imageRefs : []), card.primaryImageRef,
  ]).map(imageItem);
}

async function boardImages(board) {
  const { boardItemLocalImage } = await import('./moodBoard/logic.js');
  return [
    board.posterImageRef, board.collageImageRef,
    ...(board.items || []).filter(item => item?.renderedAt || item?.source?.startsWith?.('frame:'))
      .map(boardItemLocalImage).filter(asset => asset?.kind === 'image').map(asset => asset.filename),
  ].map(imageItem);
}

async function musicVideoItems(project) {
  const { projectTakeAssets } = await import('./musicVideo/mediaPool.js');
  const castImages = Object.values(project.castAndSets?.images || {}).flatMap(image =>
    [image.imageId, ...(image.history || [])]);
  const kit = project.publishKit || {};
  const publishingImages = [kit.coverArt, kit.youtubeThumbnail, ...(kit.youtubeThumbnailTests || [])]
    .flatMap(asset => asset?.generated || []);
  return [
    ...projectTakeAssets(project).map(({ kind, ref }) => ({ kind, ref })),
    videoItem(project.renderHistoryId),
    ...[...castImages, ...publishingImages].map(imageItem),
  ];
}

function storyboardImages(board) {
  return board.beats.flatMap(beat => beat.panels.flatMap(panel =>
    panel.takes.filter(take => take.source === 'generated').map(take => imageItem(take.image))));
}

function loomItems(loom) {
  return loom.episodes.flatMap(episode => episode.nodes.flatMap(node => [
    imageItem(node.image), videoItem(node.videoHistoryId), videoItem(node.playbackAssets?.entryVideoHistoryId),
    ...(node.playbackAssets?.holdLoopVideoHistoryIds || []).map(videoItem),
    ...Object.values(node.playbackAssets?.exitByTransition || {}).map(videoItem),
  ]));
}

function directorItems(project) {
  return [
    videoItem(project.finalVideoId),
    ...(project.scenes || []).flatMap(scene => [imageItem(scene.sourceImageFile), videoItem(scene.renderedJobId)]),
  ];
}

async function writerImages(work) {
  const { listAnalysisIds, loadAnalysis } = await import('./writersRoom/analysisSnapshots.js');
  const analyses = await Promise.all((await listAnalysisIds(work.id)).map(id => loadAnalysis(work.id, id)));
  return analyses.flatMap(analysis => Object.values(analysis?.sceneImages || {}).map(image => imageItem(image.filename)));
}

const recordItems = {
  deck: deckImages, moodBoard: boardImages, musicVideo: musicVideoItems, storyboard: storyboardImages,
  fableLoom: loomItems, creativeDirector: directorItems, writersRoom: writerImages,
};

const ownerKey = (source, id) => `${source}:${id}`;

async function organize() {
  const { sources, downloads, videos } = await inventory();
  const buckets = new Map();
  for (const [source, owners] of Object.entries(sources)) {
    for (const owner of owners) buckets.set(ownerKey(source, owner.id), { source, owner, items: [] });
  }

  await mapWithConcurrency([...buckets.values()], 4, async bucket => {
    const extractor = recordItems[bucket.source];
    if (extractor) bucket.items.push(...await extractor(bucket.owner));
  });
  for (const job of listJobs({ status: 'completed' })) {
    if (job.durabilityPending) continue;
    for (const { source, id } of jobCollectionSources(job)) {
      buckets.get(ownerKey(source, id))?.items.push(...jobCollectionItems(job));
    }
  }

  const compositions = buckets.get(ownerKey('composition', 'compositions'));
  for (const video of videos) {
    const musicId = video.musicVideo?.projectId || video.musicVideoProjectId;
    buckets.get(ownerKey('musicVideo', musicId))?.items.push(videoItem(video.id));
    buckets.get(ownerKey('timeline', video.timelineProjectId))?.items.push(videoItem(video.id));
    if (video.modelId === 'html-composition' || video.codeAnimation) compositions.items.push(videoItem(video.id));
  }
  buckets.get(ownerKey('external', 'external')).items.push(...downloads);

  const refs = new Map();
  for (const bucket of buckets.values()) {
    bucket.items = collectionItems(bucket.items);
    for (const item of bucket.items) refs.set(itemKey(item), item);
  }

  const { resolveMediaLocations } = await import('./peerHostedMedia.js');
  const locations = await resolveMediaLocations([...refs.values()]);
  const available = new Set([...refs.keys()].filter((_, index) => locations[index].location !== 'missing' && !locations[index].pendingDelete));
  const result = { added: 0, updatedCollections: 0, missingAssets: refs.size - available.size, failedCollections: 0 };

  for (const { source, owner, items } of buckets.values()) {
    try {
      const filed = await fileOwnedMedia(source, owner, items.filter(item => available.has(itemKey(item))), { preserveRemovals: true });
      if (!filed?.added) continue;
      result.added += filed.added;
      result.updatedCollections += 1;
    } catch (error) {
      result.failedCollections += 1;
      console.error(`❌ Auto-organize collection for ${source} ${owner.id} failed: ${error.message}`);
    }
  }
  return result;
}

let active = null;

export function autoOrganizeMediaCollections() {
  // Single in-process run shared by overlapping operator requests. Collection
  // writes still use the same per-record queue as edits and live render hooks.
  return active ??= withBackupAssetPublication(organize).finally(() => { active = null; });
}
