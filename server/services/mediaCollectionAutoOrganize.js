/**
 * Rebuild collection membership from durable project references, catalog
 * records and the retained completed-job archive. Only file media still known to this install
 * (including peer-hosted assets), and honor explicitly removed memberships.
 */
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { itemKey } from '../lib/mediaItemKey.js';
import { listJobs } from './mediaJobQueue/queueState.js';
import { listCollections } from './mediaCollections.js';
import { collectionItems, fileOwnedMedia, imageItem, jobCollectionItems, jobCollectionSources, videoItem } from './mediaCollectionRules.js';

async function inventory() {
  const [decks, moodBoards, music, storyboards, fable, director, timeline, writers, external, history, sprites, universeCrud, seriesStore, issueCrud] = await Promise.all([
    import('./decks.js'), import('./moodBoard/db.js'), import('./musicVideo/projects.js'),
    import('./storyboards/index.js'), import('./fableLoom/records.js'), import('./creativeDirector/local.js'),
    import('./videoTimeline/local.js'), import('./writersRoom/local.js'), import('./externalMediaCollection.js'),
    import('./videoGen/history.js'), import('./sprites/records.js'), import('./universeBuilder/crud.js'),
    import('./pipeline/series.js'), import('./pipeline/issueCrud.js'),
  ]);
  const [deckRows, boards, musicProjects, storyboardSummaries, looms, directorProjects, timelines, works, downloads, videos, collections, spriteRecords, universes, seriesList, issues] =
    await Promise.all([
      decks.listDecksForIntegrity(), moodBoards.listBoards(), music.listProjects(), storyboards.listStoryboards(),
      fable.listLooms(), director.listProjects(), timeline.listProjects(), writers.listWorks(),
      external.collectExistingExternalMedia(), history.loadHistory(), listCollections(), sprites.listRecords(),
      universeCrud.listUniverses(), seriesStore.listSeries(), issueCrud.listAllIssues({ withHistory: false }),
    ]);
  const issuesBySeries = Map.groupBy(issues.filter(issue => issue?.seriesId), issue => issue.seriesId);
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
      universe: universes,
      // A series files its issues' renders (comic page proofs and finals).
      series: seriesList.map(series => ({ ...series, issues: issuesBySeries.get(series.id) || [] })),
    },
    downloads,
    videos: videos.filter(video => typeof video?.id === 'string' && video.id),
  };
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

// Every media file an owner record references, wherever in the record it
// sits: gallery images by basename (bare names and /data/images/… paths) and
// videos by history id. Owner records hold their renders, takes, plates,
// references and history in many shapes; walking them keeps filing complete as
// those shapes grow. Unavailable names are dropped by the availability check.
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
function referencedMedia(value, videoIds, out = []) {
  if (typeof value === 'string') {
    // `image:<file>` / `video:<id>` media keys and served paths both resolve.
    const bare = value.replace(/^(image|video):/, '');
    const name = bare.split('?')[0].split(/[/\\]/).pop();
    if (IMAGE_FILE.test(name) && !name.includes(':')) out.push(imageItem(name));
    else if (videoIds.has(bare)) out.push(videoItem(bare));
  } else if (Array.isArray(value)) {
    for (const entry of value) referencedMedia(entry, videoIds, out);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) referencedMedia(entry, videoIds, out);
  }
  return out;
}
// A sprite's reference candidates record their gallery source render in a
// `<name>.generation.json` beside the copied candidate.
async function spriteItems(record) {
  const [{ readdir, readFile }, { join }, { resolveSpriteAssetPath }] = await Promise.all([import('fs/promises'), import('path'), import('./sprites/paths.js')]);
  const dir = resolveSpriteAssetPath(record.id, 'reference/candidates');
  const names = await readdir(dir).catch(() => []);
  const generations = await Promise.all(names.filter(name => name.endsWith('.generation.json'))
    .map(name => readFile(join(dir, name), 'utf8').then(JSON.parse).catch(() => null)));
  return generations.filter(Boolean).map(generation => imageItem(generation.sourceFilename));
}

const WALKED_SOURCES = new Set(['deck', 'moodBoard', 'musicVideo', 'storyboard', 'fableLoom', 'creativeDirector', 'sprite', 'universe', 'series']);

async function writerImages(work) {
  const { listAnalysisIds, loadAnalysis } = await import('./writersRoom/analysisSnapshots.js');
  const analyses = await Promise.all((await listAnalysisIds(work.id)).map(id => loadAnalysis(work.id, id)));
  return analyses.flatMap(analysis => Object.values(analysis?.sceneImages || {}).map(image => imageItem(image.filename)));
}

const recordItems = { moodBoard: boardImages, musicVideo: musicVideoItems, writersRoom: writerImages, sprite: spriteItems };

const ownerKey = (source, id) => `${source}:${id}`;

async function organize() {
  // Fold each Creative Commission job's per-run collections into one first, so
  // the filing pass below routes every run's renders into the job collection.
  const { consolidateCommissionCollections } = await import('./creativeCommissions/collections.js');
  const consolidated = await consolidateCommissionCollections();
  const { sources, downloads, videos } = await inventory();
  const buckets = new Map();
  for (const [source, owners] of Object.entries(sources)) {
    for (const owner of owners) buckets.set(ownerKey(source, owner.id), { source, owner, items: [] });
  }

  const videoIds = new Set(videos.map(video => video.id));
  await mapWithConcurrency([...buckets.values()], 4, async bucket => {
    const extractor = recordItems[bucket.source];
    if (extractor) bucket.items.push(...await extractor(bucket.owner));
    if (WALKED_SOURCES.has(bucket.source)) bucket.items.push(...referencedMedia(bucket.owner, videoIds));
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
  const result = {
    added: 0, updatedCollections: 0, missingAssets: refs.size - available.size, failedCollections: 0,
    mergedCollections: consolidated.mergedCollections,
  };

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
  // Catalog references: each record's images go to its universes' collections
  // and to its type's library collection (Cast, Environments, Objects).
  const { fileCatalogImagesIntoUniverses, fileCatalogImagesIntoTypeCollections } = await import('./catalog/catalogUniverseFiling.js');
  const { universes } = await fileCatalogImagesIntoUniverses();
  for (const { added } of universes) {
    if (!added) continue;
    result.added += added;
    result.updatedCollections += 1;
  }
  const typed = await fileCatalogImagesIntoTypeCollections();
  result.added += typed.added;
  if (typed.added) result.updatedCollections += typed.types;
  return result;
}

let active = null;

export function autoOrganizeMediaCollections() {
  // Single in-process run shared by overlapping operator requests. Collection
  // writes still use the same per-record queue as edits and live render hooks.
  return active ??= withBackupAssetPublication(organize).finally(() => { active = null; });
}
