import { mapWithConcurrency } from '../../lib/mapWithConcurrency.js';
import { isTestRunner } from '../../lib/runtimeEnv.js';
import { listAssets, countAssets, galleryFacets } from './db.js';

const escapeHatch = () => process.env.MEMORY_BACKEND === 'file' || isTestRunner();
const keyFor = ({ kind, data }) => `${kind}:${kind === 'image' ? data.filename : data.id}`;
const keyForRef = item => `${item.kind}:${item.ref}`;
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const text = value => typeof value === 'string' && value.trim() ? value : null;
const readImages = async diskReader => (diskReader || (await import('../imageGen/local.js')).listGallery)();

async function resolveScope({ collectionId, starred, mediaKeys, collectionSnapshot }) {
  let keys = mediaKeys;
  let excludeKeys;
  let orderedKeys;
  let collection;
  if (collectionId) {
    const store = collectionSnapshot ? null : await import('../mediaCollections.js');
    if (collectionId === 'unsorted') {
      excludeKeys = (collectionSnapshot || await store.listCollections()).flatMap(c => (c.items || []).map(keyForRef));
    } else {
      collection = collectionSnapshot ? collectionSnapshot.find(item => item.id === collectionId) : await store.getCollection(collectionId);
      orderedKeys = [...(collection?.items || [])]
        .sort((a, b) => time(b.addedAt) - time(a.addedAt)).map(keyForRef);
      keys = keys ? keys.filter(key => orderedKeys.includes(key)) : orderedKeys;
    }
  }
  if (starred) {
    const annotations = await (await import('../mediaAnnotations.js')).listAnnotations();
    const ownStars = Object.entries(annotations).filter(([, entry]) => entry.own?.starred).map(([key]) => key);
    keys = keys ? keys.filter(key => ownStars.includes(key)) : ownStars;
  }
  return { mediaKeys: keys, excludeKeys, orderedKeys, collection };
}

/** Bounded reads; sidecars remain the reconcile authority and test escape hatch. */
export async function listGalleryPage({
  limit = 60, offset = 0, q = '', hidden, filename, starred = false, summary = false,
  kind = 'image', media = false, cover = false, videoSnapshot, collectionSnapshot, collectionId, universeId, entryCategory, entryKind, mediaKeys,
} = {}, diskReader) {
  const mixed = media || kind !== 'image';
  const videos = mixed ? videoSnapshot ?? await (await import('../videoGen/history.js')).loadHistory() : undefined;
  const scope = await resolveScope({ collectionId, starred, mediaKeys, collectionSnapshot });
  const filters = { kind: kind === 'all' ? undefined : kind, q, hidden, filename,
    universeId, entryCategory, entryKind, mediaKeys: scope.mediaKeys, excludeKeys: scope.excludeKeys, videos };
  let items;
  let total;
  let hiddenTotal;
  let counts;
  if (escapeHatch()) {
    const images = kind === 'video' && !summary ? [] : await readImages(diskReader);
    const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const candidates = [...images.map(data => ({ kind: 'image', data })), ...(videos || []).map(data => ({ kind: 'video', data }))];
    const matching = (row, activeFilters, activeScope) =>
      (!activeFilters.kind || row.kind === activeFilters.kind)
      && (filename === undefined || ((row.kind === 'image' ? row.data.filename : row.data.id) === filename || row.data.filename === filename))
      && (activeScope.mediaKeys === undefined || activeScope.mediaKeys.includes(keyFor(row)))
      && !activeScope.excludeKeys?.includes(keyFor(row))
      && Object.entries({ universeId, entryCategory, entryKind }).every(([key, value]) => value === undefined || row.data[key] === value)
      && tokens.every(token => [JSON.stringify(row.data), row.kind,
        row.data.width && row.data.height ? `${row.data.width}x${row.data.height}` : '',
        row.data.extractedFromVideoId ? 'extracted frame' : '', row.data.stitchedFrom ? 'stitched' : '',
        row.data.upscaledFrom ? 'upscaled 2x' : ''].join(' ').toLowerCase().includes(token));
    const matches = candidates.filter(row => matching(row, filters, scope));
    const visible = matches.filter(row => hidden === undefined || !!row.data.hidden === hidden);
    visible.sort((a, b) => scope.orderedKeys
      ? scope.orderedKeys.indexOf(keyFor(a)) - scope.orderedKeys.indexOf(keyFor(b))
      : time(b.data.createdAt) - time(a.data.createdAt) || keyFor(a).localeCompare(keyFor(b)));
    items = visible.filter(row => !cover || row.kind === 'image' || row.data.thumbnail).slice(offset, offset + limit).map(row => mixed ? row : row.data);
    total = visible.length;
    hiddenTotal = matches.filter(row => !!row.data.hidden).length;
    if (summary && mixed) {
      // Kind-chip counts follow search and collection, before kind/favorites.
      const countScope = starred ? await resolveScope({ collectionId, mediaKeys, collectionSnapshot }) : scope;
      const counted = candidates.filter(row => matching(row, { ...filters, kind: undefined }, countScope)
        && (hidden === undefined || !!row.data.hidden === hidden));
      counts = { image: counted.filter(row => row.kind === 'image').length,
        video: counted.filter(row => row.kind === 'video').length, all: counted.length };
    }
  } else {
    [items, total, hiddenTotal] = await Promise.all([
      listAssets({ ...filters, limit, offset, typed: mixed, orderedKeys: scope.orderedKeys, cover }),
      countAssets(filters), summary ? countAssets({ ...filters, hidden: true }) : undefined,
    ]);
    if (summary && mixed) {
      const countScope = starred ? await resolveScope({ collectionId, mediaKeys, collectionSnapshot }) : scope;
      const base = { ...filters, mediaKeys: countScope.mediaKeys };
      const [image, video] = await Promise.all(['image', 'video'].map(kind => countAssets({ ...base, kind })));
      counts = { image, video, all: image + video };
    }
  }
  return { items, total, limit, offset, ...(summary ? { hiddenTotal, ...(counts ? { counts } : {}) } : {}) };
}

/** Global options contain descriptors and ids, never image metadata payloads. */
export async function listGalleryFacets(diskReader) {
  const rows = escapeHatch() ? (await readImages(diskReader)).filter(item => !item.hidden) : await galleryFacets();
  const universes = new Map();
  const categories = new Set();
  const kinds = new Set();
  for (const row of rows) {
    if (text(row.universeId)) universes.set(row.universeId, text(row.universeName) || row.universeId);
    if (text(row.entryCategory)) categories.add(row.entryCategory);
    if (text(row.entryKind)) kinds.add(row.entryKind);
  }
  const collections = await (await import('../mediaCollections.js')).listCollections();
  const populated = await mapWithConcurrency(collections, 4, async collection => {
    const page = await listGalleryPage({ collectionId: collection.id, collectionSnapshot: collections, hidden: false, limit: 1 }, diskReader);
    return page.total ? { id: collection.id, name: collection.name } : null;
  });
  return { universes: [...universes].map(([id, name]) => ({ id, name })),
    categories: [...categories], kinds: [...kinds], collections: populated.filter(Boolean) };
}

/** Collection grid covers and counts, without downloading all image sidecars. */
export async function listGalleryCollectionSummaries(diskReader) {
  const collections = await (await import('../mediaCollections.js')).listCollections();
  const videoSnapshot = await (await import('../videoGen/history.js')).loadHistory();
  const summaries = await mapWithConcurrency([{ id: 'unsorted' }, ...collections], 4, async collection => {
    const page = await listGalleryPage({ collectionId: collection.id, media: true, kind: 'all', limit: 1, summary: collection.id === 'unsorted', cover: true, videoSnapshot, collectionSnapshot: collections }, diskReader);
    let cover = page.items[0];
    if (collection.coverKey) {
      const kind = collection.coverKey.startsWith('image:') ? 'image' : 'video';
      const filename = collection.coverKey.slice(kind.length + 1);
      const pinned = await listGalleryPage({ collectionId: collection.id, kind, media: true, filename, limit: 1, cover: true, videoSnapshot, collectionSnapshot: collections }, diskReader);
      if (pinned.items[0]) cover = pinned.items[0];
    }
    const counts = collection.id === 'unsorted' ? page.counts : (collection.items || []).reduce((result, item) => {
      result[item.kind]++; return result;
    }, { image: 0, video: 0 });
    return { id: collection.id, counts, total: counts.image + counts.video,
      cover: cover?.kind === 'image' ? cover.data.path || `/data/images/${cover.data.filename}`
        : cover?.data.thumbnail ? `/data/video-thumbnails/${cover.data.thumbnail}` : null };
  });
  return summaries;
}
