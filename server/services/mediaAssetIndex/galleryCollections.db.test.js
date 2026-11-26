import { afterAll, beforeAll, beforeEach, expect, it as vitestIt, vi } from 'vitest';
import pg from 'pg';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaDdl } from '../../lib/db/schema/media.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { mediaFixture } from '../../../scripts/perf/collectionFixtureData.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../../lib/mockPathsDataRoot.js';
import { listGalleryCollectionSummaries, listGalleryFacets, listGalleryPage } from './gallery.js';
import { compactGalleryRecord } from './logic.js';
import { searchImagePrompts } from './db.js';
import { searchMediaLibraryForPool } from '../musicVideo/mediaPool.js';
import { PATHS } from '../../lib/paths.js';
import { sidecarPathForImage } from '../../lib/assetHash.js';
import { createDbPhaseDiagnostics } from '../../test/dbPhaseDiagnostics.js';

const { it, drain } = ownTestBodies(vitestIt);

const state = vi.hoisted(() => ({ file: false, images: [], videos: [], collections: [], annotations: {}, query: vi.fn(),
  listGallery: vi.fn(), fullReads: 0 }));
vi.mock('../../lib/pgFileFacade.js', () => ({ isFileBackend: () => state.file }));
vi.mock('../../lib/paths.js', async original =>
  makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-gallery-location-') }));
vi.mock('../../lib/db.js', () => ({ query: (...args) => state.query(...args) }));
vi.mock('../imageGen/local.js', () => ({ listGallery: state.listGallery }));
// Stands in for history.js: compact rows that answer for their full record's
// search text, and a count of the full reads a compact search must not make.
vi.mock('../videoGen/history.js', async () => {
  const { compactSource, recordSearchText } = await import('./logic.js');
  const texts = new WeakMap();
  return {
    loadHistory: async () => { state.fullReads++; return state.videos; },
    readHistorySnapshot: async () => state.videos,
    loadCompactHistory: async () => state.videos.map((video) => {
      const row = compactSource(video);
      texts.set(row, recordSearchText('video', video));
      return row;
    }),
    videoSearchText: row => texts.get(row) ?? recordSearchText('video', row),
  };
});
vi.mock('../mediaCollections.js', () => ({ listCollections: async () => state.collections,
  musicVideoCollectionId: id => `mvc-${id}`,
  getCollection: async id => state.collections.find(collection => collection.id === id) }));
vi.mock('../peerHostedMedia.js', () => ({ resolveMediaLocations: async items => items.map(() => ({ location: 'local' })) }));
vi.mock('../mediaAnnotations.js', () => ({ listAnnotations: async () => state.annotations }));
let client;
let observer;
let diagnostics;
let available = false;
beforeAll(async () => {
  vi.stubEnv('MEMORY_BACKEND', 'db');
  if (process.env.PGDATABASE !== 'portos_test') {
    requireDbOrSkip('gallery collection batches', false, 'requires portos_test');
    return;
  }
  const connection = { database: 'portos_test', host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || 'portos',
    password: process.env.PGPASSWORD || 'portos', options: '', connectionTimeoutMillis: 2000 };
  client = new pg.Client(connection);
  await client.connect();
  if (process.env.PORTOS_DB_PHASE_DIAGNOSTICS === '1') {
    observer = new pg.Client({ ...connection, application_name: 'portos-test-diagnostics', statement_timeout: 500, query_timeout: 750 });
    observer.on('error', () => {});
    await observer.connect();
  }
  // A session-private table shadows the index, including for EXPLAIN: no live rows.
  const ddl = mediaDdl.filter(sql => /(?:TABLE IF NOT EXISTS media_assets|INDEX IF NOT EXISTS idx_media_assets_)/.test(sql));
  for (const sql of ddl) await client.query(sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
  // Production uses a pool; this fixture shares one session for its temp table.
  // Serialize that session rather than relying on pg's deprecated query queue.
  let queryTail = Promise.resolve();
  state.query.mockImplementation((...args) => {
    const result = queryTail.then(() => client.query(...args));
    queryTail = result.catch(() => {});
    return result;
  });
  available = true;
});
beforeEach(() => drain());
afterAll(async () => {
  try { await drain().finally(() => diagnostics?.drain()); }
  finally {
    try { await Promise.all([observer?.end(), client?.end()]); }
    finally { vi.unstubAllEnvs(); cleanupTempDataRoots(); }
  }
});

async function seed(images, indexedVideos = [], phase = (_name, operation) => operation()) {
  state.images = images;
  await phase('seed-truncate', () => client.query('TRUNCATE pg_temp.media_assets'));
  const rows = await phase('seed-serialize', () => JSON.stringify([...images.map(data => ({ kind: 'image', ref: data.filename, data })),
    ...indexedVideos.map(data => ({ kind: 'video', ref: data.id, data }))]));
  await phase('seed-insert', () => client.query(`INSERT INTO pg_temp.media_assets (media_key, kind, ref, data, created_at)
    SELECT kind || ':' || ref, kind, ref, data, COALESCE((data->>'createdAt')::timestamptz, 'epoch')
    FROM jsonb_to_recordset($1::jsonb) AS r(kind text, ref text, data jsonb)`, [rows]));
}
const member = (kind, ref, addedAt = '2026-01-01') => ({ kind, ref, addedAt });
const disk = async () => state.images;

it('returns the same prompt-only library page on disk and in PostgreSQL', async context => {
  if (!available) return context.skip();
  const time = index => new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
  const matching = Array.from({ length: 300 }, (_, index) => ({
    filename: `picker-${index}.png`, prompt: 'BLUE 50% Cat_Fur', createdAt: time(index),
  }));
  const filed = { filename: 'picker-filed.png', prompt: 'blue 50% cat_fur', createdAt: time(501) };
  const alsoFiled = { ...filed, filename: 'picker-also-filed.png' };
  const images = [...matching, filed, alsoFiled,
    { filename: 'picker-wildcard.png', prompt: 'blue 500 catxfur', createdAt: time(502) },
    { filename: 'picker-metadata.png', model: filed.prompt, createdAt: time(503) },
    { filename: 'picker-object.png', prompt: { text: filed.prompt }, createdAt: time(504) },
  ];
  const clip = { id: 'picker-video', prompt: filed.prompt, createdAt: time(500) };
  const project = { id: 'library-picker', scenes: [] };
  const previous = { file: state.file, videos: state.videos, collections: state.collections };
  const { listGallery } = await import('../imageGen/localGallery.js');
  state.listGallery.mockImplementation(listGallery);
  await mkdir(PATHS.images, { recursive: true });
  try {
    await Promise.all(images.flatMap(({ filename, ...metadata }) => [
      writeFile(join(PATHS.images, filename), 'synthetic image'),
      writeFile(sidecarPathForImage(filename), JSON.stringify(metadata)),
    ]));
    await seed(await listGallery(), [{ ...clip, id: 'picker-indexed-video' }]);
    state.videos = [clip];
    const excluded = [filed.filename, alsoFiled.filename];
    state.collections = [{ id: 'mvc-library-picker', items: excluded.map(ref => member('image', ref)) }];
    const words = ['blue', '50%', 'cat_fur'];
    expect(await searchImagePrompts(words, 2, excluded)).toEqual(matching.slice(-2).reverse()
      .map(({ filename, ...item }) => ({ ref: filename, ...item })));
    state.file = true;
    const filePage = await searchMediaLibraryForPool(project, 'BLUE 50% Cat_Fur');
    expect(state.listGallery).toHaveBeenCalledOnce();
    expect(filePage.items).toHaveLength(300);
    expect(filePage.more).toBe(true);
    expect(filePage.items[0]).toEqual({ kind: 'video', assetId: clip.id, prompt: clip.prompt, createdAt: clip.createdAt });
    expect(filePage.items.at(-1).assetId).toBe('picker-1.png');

    state.listGallery.mockClear();
    state.file = false;
    state.query.mockClear();
    expect(await searchMediaLibraryForPool(project, 'BLUE 50% Cat_Fur')).toEqual(filePage);
    expect(state.query).toHaveBeenCalledOnce();
    expect(state.listGallery).not.toHaveBeenCalled();
  } finally {
    Object.assign(state, previous);
    state.listGallery.mockReset();
    await Promise.all(images.flatMap(({ filename }) => [
      rm(join(PATHS.images, filename), { force: true }),
      rm(sidecarPathForImage(filename), { force: true }),
    ]));
  }
});

it('uses original files on this machine for local gallery pages and counts on both backends', async context => {
  if (!available) return context.skip();
  await Promise.all([mkdir(PATHS.images, { recursive: true }), mkdir(PATHS.videos, { recursive: true })]);
  await Promise.all([
    writeFile(join(PATHS.images, 'copied.png'), 'local image'),
    writeFile(join(PATHS.videos, 'render.mov'), 'local video'),
    writeFile(join(PATHS.videos, 'hosted-preview.png'), 'preview only'),
  ]);
  await seed([
    { filename: 'hosted.png', createdAt: '2026-01-04', prompt: 'Fox' },
    { filename: 'copied.png', createdAt: '2026-01-01', prompt: 'Fox', originInstanceId: 'example-peer' },
  ]);
  state.videos = [
    { id: 'hosted', filename: 'hosted.mp4', thumbnail: 'hosted-preview.png', createdAt: '2026-01-03', prompt: 'Fox' },
    { id: 'different-from-filename', filename: 'render.mov', createdAt: '2026-01-02', prompt: 'Fox' },
  ];
  const options = { media: true, kind: 'all', summary: true, hidden: false, compact: true, localOnly: true, limit: 1 };
  for (const file of [false, true]) {
    state.file = file;
    try {
      const first = await listGalleryPage(options, disk);
      expect(first).toMatchObject({ items: [{ kind: 'video', data: { filename: 'render.mov' } }],
        total: 2, counts: { all: 2, image: 1, video: 1 } });
      const second = await listGalleryPage({ ...options, offset: 1, q: 'fox' }, disk);
      expect(second).toMatchObject({ items: [{ kind: 'image', data: { filename: 'copied.png' } }], total: 2 });
      const images = await listGalleryPage({ ...options, kind: 'image' }, disk);
      expect(images).toMatchObject({ total: 1, counts: { all: 2, image: 1, video: 1 } });
      expect((await listGalleryPage({ localOnly: true }, disk)).items.map(row => row.filename)).toEqual(['copied.png']);
      expect((await listGalleryPage({ ...options, localOnly: false }, disk)).total).toBe(4);
    } finally {
      state.file = false;
    }
  }
});

it('combines actual video size and full prompt search before indexed paging and counts', async context => {
  if (!available) return context.skip();
  await mkdir(PATHS.videos, { recursive: true });
  await Promise.all([
    writeFile(join(PATHS.videos, 'size-small.mp4'), '3 B'),
    writeFile(join(PATHS.videos, 'size-large.mp4'), 'much more than 3 bytes'),
  ]);
  await seed([{ filename: 'size-image.png', createdAt: '2026-01-01', prompt: 'private search needle' }]);
  state.videos = [
    { id: 'small', filename: 'size-small.mp4', createdAt: '2026-01-04', sentPrompt: 'private search needle', fileSizeBytes: 1000 },
    { id: 'remote', filename: 'size-missing.mp4', createdAt: '2026-01-03', sentPrompt: 'private search needle', fileSizeBytes: 1000 },
    { id: 'large', filename: 'size-large.mp4', createdAt: '2026-01-02', sentPrompt: 'private search needle', prompt: 'short title' },
  ];
  state.fullReads = 0;
  const page = await listGalleryPage({ media: true, kind: 'all', summary: true, compact: true, hidden: false,
    q: 'private search needle', videoSizeOverBytes: 3, limit: 1 }, disk);
  expect(page).toMatchObject({ total: 1, counts: { all: 1, image: 0, video: 1 },
    items: [{ kind: 'video', data: { id: 'large', fileSizeBytes: 22 } }] });
  expect(state.fullReads).toBe(0);
});

it('preserves cover fallback, stable membership order, visibility and stale-reference contracts at the public boundary', async context => {
  if (!available) return context.skip();
  await seed([
    { filename: 'a.png', createdAt: '2026-01-01', universeId: 'example', entryKind: 'canon' },
    { filename: 'z.png', path: '/custom/z.png', hidden: true, createdAt: '2026-01-01' },
    { filename: 'loose.png', hidden: true, createdAt: '2026-01-03' },
  ], [{ id: 'stale-index', thumbnail: 'stale.png' }]);
  state.videos = [{ id: 'v', filename: 'v.mp4', thumbnail: 'current.png', hidden: true, createdAt: 'bad-date' },
    { id: 'no-thumb', createdAt: '2026-01-04' }, { id: 'loose', createdAt: '2026-01-05' }];
  const items = [member('image', 'z.png'), member('image', 'a.png'), member('video', 'v'), member('image', 'missing.png')];
  state.collections = [
    { id: 'equal-time', name: 'Equal', items },
    { id: 'pin-image', name: 'Image', items, coverKey: 'image:a.png' },
    { id: 'pin-video', name: 'Video', items, coverKey: 'video:v' },
    { id: 'pin-filename', name: 'Filename', items, coverKey: 'video:v.mp4' },
    { id: 'missing-pin', items, coverKey: 'image:missing.png' },
    { id: 'outside-pin', items, coverKey: 'image:loose.png' },
    { id: 'no-thumbnail', items: [member('video', 'no-thumb'), ...items], coverKey: 'video:no-thumb' },
    { id: 'empty', items: [] }, { id: 'stale', items: [member('image', 'gone.png')] },
    { id: 'hidden-only', items: [member('image', 'z.png')] },
    { id: 'video-only', items: [member('video', 'v')] },
  ];
  state.file = true;
  const expected = await listGalleryCollectionSummaries(disk);
  const facets = await listGalleryFacets(disk);
  expect(expected[0]).toEqual({ id: 'unsorted', cover: '/data/image-thumbnails/loose.webp', total: 2, counts: { image: 1, video: 1, all: 2 } });
  expect(expected[1]).toMatchObject({ cover: '/custom/z.png', total: 4 });
  state.file = false;
  state.query.mockClear();
  expect(await listGalleryCollectionSummaries(disk)).toEqual(expected);
  expect(state.query).toHaveBeenCalledTimes(1);
  state.query.mockClear();
  expect(await listGalleryFacets(disk)).toEqual(facets);
  expect(state.query).toHaveBeenCalledTimes(2);
  // Empty collection list and no authoritative videos still yield Unsorted.
  state.collections = []; state.videos = [];
  expect((await listGalleryCollectionSummaries(disk))[0]).toMatchObject({ total: 3, counts: { image: 3, video: 0, all: 3 } });
  await seed([]);
  state.videos = [{ id: 'loose-video', thumbnail: 'loose.png', hidden: true, createdAt: '2026-01-01' }];
  expect((await listGalleryCollectionSummaries(disk))[0]).toEqual({ id: 'unsorted', total: 1,
    counts: { image: 0, video: 1, all: 1 }, cover: '/data/video-thumbnails/loose.png' });
  state.videos = [];
  expect((await listGalleryCollectionSummaries(disk))[0]).toEqual({ id: 'unsorted', total: 0,
    counts: { image: 0, video: 0, all: 0 }, cover: null });
});

it('keeps summary and picker query counts constant for the synthetic 2400-image/1200-video fixture', async context => {
  if (!available) return context.skip();
  await seed(Array.from({ length: 2400 }, (_, i) => mediaFixture('image', i)));
  state.videos = Array.from({ length: 1200 }, (_, i) => mediaFixture('video', i));
  for (const count of [0, 10, 30]) {
    state.collections = Array.from({ length: count }, (_, i) => ({ id: `collection-${i}`, name: `Collection ${i}`,
      items: state.images.slice(i * 20, i * 20 + 20).map(image => member('image', image.filename)),
    }));
    state.query.mockClear();
    const started = performance.now();
    const summaries = await listGalleryCollectionSummaries(disk);
    const elapsed = performance.now() - started;
    expect(summaries).toHaveLength(count + 1);
    expect(state.query).toHaveBeenCalledTimes(1);
    const [sql, params] = state.query.mock.calls[0];
    const projected = JSON.parse(params[1]);
    expect(projected).toHaveLength(1200);
    expect(projected.every(video => !('prompt' in video) && !('metadata' in video))).toBe(true);
    const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0].Plan;
    if (process.env.PORTOS_COLLECTION_BENCHMARK === '1') process.stdout.write(JSON.stringify({ collections: count, queries: 1, videoBytes: Buffer.byteLength(params[1]),
      elapsedMs: Math.round(elapsed), responseBytes: Buffer.byteLength(JSON.stringify(summaries)),
      tempReadBlocks: plan['Temp Read Blocks'], tempWrittenBlocks: plan['Temp Written Blocks'] }) + '\n');
    for (let i = 0; i < count; i++) state.collections[i].coverKey = `image:${state.images[i * 20 + 19].filename}`;
    state.query.mockClear();
    const pinned = await listGalleryCollectionSummaries(disk);
    expect(state.query).toHaveBeenCalledTimes(1);
    for (let i = 0; i < count; i++) expect(pinned[i + 1].cover).toBe(state.images[i * 20 + 19].path.replace('/data/images/', '/data/image-thumbnails/').replace(/\.png$/, '.webp'));
    state.query.mockClear();
    expect((await listGalleryFacets(disk)).collections).toHaveLength(count);
    expect(state.query).toHaveBeenCalledTimes(2);
  }
});

// The pre-#9676 contract: full records through SQL, compacted afterwards.
const compactedFull = page => ({ ...page, items: page.items.map(item => item.kind && item.data
  ? { kind: item.kind, data: compactGalleryRecord(item.data) } : compactGalleryRecord(item)) });
const planNodes = plan => [plan, ...(plan.Plans || []).flatMap(planNodes)];

it('projects compact no-search pages before SQL with identical rows, previews and counts', async context => {
  if (!available) return context.skip();
  const beyond = 'needle-beyond-preview';
  const images = [
    { filename: 'nested.png', createdAt: '2026-02-01', prompt: null, metadata: { prompt: 'nested fallback' }, seed: null,
      universeId: 'u1', entryCategory: 'places', entryKind: 'canon', negativePrompt: 'x'.repeat(500) },
    { filename: 'blank.png', createdAt: '2026-02-02', prompt: ' \t\u3000\ufeff', metadata: { prompt: '🦊'.repeat(300) },
      hidden: true, cleanedFrom: 'nested.png', universeId: 'u1' },
    { filename: 'long.png', createdAt: '2026-02-03', prompt: `${'x'.repeat(238)}   ${beyond}`, upscaledFrom: 'nested.png',
      autoCleaned: false, regenerated: true, watermarkRemoved: null },
    { filename: 'short.png', createdAt: '2026-02-04', prompt: 'short ✓ é', width: 0, loraPaths: [], extractedFromVideoId: 'v1' },
    { filename: 'odd.png', createdAt: '2026-02-05', metadata: 'not-an-object', universeId: 'u2', entryCategory: null },
    { filename: 'spaces.png', createdAt: '2026-02-06', prompt: `${'\u00a0'.repeat(300)}late`, stitchedFrom: ['a.png', 'b.png'] },
  ];
  await seed(images, [{ id: 'v1', prompt: 'stale indexed video' }]);
  state.videos = [
    { id: 'v1', filename: 'v1.mp4', thumbnail: 'v1.png', createdAt: '2026-02-07', prompt: `${'é'.repeat(300)} ${beyond}`,
      stitchedFrom: ['a', 'b'], guidanceScale: 3, settings: { steps: 9 } },
    { id: 'v2', filename: 'v2.mp4', thumbnail: null, createdAt: 'invalid', hidden: true, metadata: { prompt: 'video nested' } },
    { id: 'v3', createdAt: '2026-02-08', prompt: `${'\u2028'.repeat(300)}late`, upscaledFrom: 'v1', entryKind: 'canon' },
  ];
  state.collections = [{ id: 'col', name: 'Example', items: [member('video', 'v1', '2026-03-01'),
    member('image', 'short.png', '2026-03-03'), member('image', 'blank.png', '2026-03-02')] }];
  state.annotations = { 'image:long.png': { own: { starred: true } }, 'video:v3': { own: { starred: true } } };
  const cases = [
    {}, { kind: 'image' }, { kind: 'video' }, { hidden: false }, { hidden: true }, { starred: true },
    { starred: true, kind: 'video' }, { collectionId: 'col' }, { collectionId: 'unsorted' }, { filename: 'long.png' },
    { filename: 'v1.mp4', kind: 'video' }, { universeId: 'u1' }, { entryCategory: 'places', entryKind: 'canon' },
    { entryKind: 'canon', kind: 'all' }, { offset: 2, limit: 3 }, { cover: true }, { q: '   ' },
  ];
  const surfaces = [{ media: true, kind: 'all', summary: true }, { media: true, kind: 'all' }, { kind: 'image', summary: true }];
  for (const surface of surfaces) {
    for (const options of cases) {
      const input = { limit: 60, ...surface, ...options };
      const expected = compactedFull(await listGalleryPage({ ...input, compact: false }));
      state.query.mockClear();
      expect(await listGalleryPage({ ...input, compact: true }), JSON.stringify(input)).toEqual(expected);
      for (const [sql, params] of state.query.mock.calls) {
        // Image-only counts read no record payload at all.
        if (sql.includes('gallery_page AS')) {
          expect(sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+[\s\S]+jsonb_each\(ma\.data\)/);
        } else if (!sql.startsWith('SELECT COUNT(*)')) {
          expect(sql).toContain('jsonb_each(data)');
        }
        expect(JSON.stringify(params)).not.toContain(beyond);
      }
    }
  }
  const all = await listGalleryPage({ media: true, kind: 'all', summary: true, compact: true });
  const card = key => all.items.find(item => (item.data.id || item.data.filename) === key).data;
  expect(card('nested.png')).toEqual({ compact: true, filename: 'nested.png', createdAt: '2026-02-01', seed: null,
    prompt: 'nested fallback' });
  expect(card('blank.png').prompt).toBe('🦊'.repeat(120) + '…');
  expect(card('long.png')).toMatchObject({ prompt: 'x'.repeat(238) + '…', watermarkRemoved: null });
  expect(card('spaces.png').prompt).toBe('…');
  expect(card('v1')).toEqual({ compact: true, id: 'v1', filename: 'v1.mp4', thumbnail: 'v1.png', createdAt: '2026-02-07',
    stitchedFrom: ['a', 'b'], prompt: 'é'.repeat(240) + '…' });
  expect(card('v2')).toMatchObject({ thumbnail: null, prompt: 'video nested' });
  expect(card('v3').prompt).toBe('…');

  // Search keeps full-metadata matching beyond the preview, in both kinds,
  // without binding the matched text (#18631).
  state.query.mockClear();
  const found = await listGalleryPage({ media: true, kind: 'all', summary: true, compact: true, q: beyond });
  expect(found.items.map(item => item.data.id || item.data.filename)).toEqual(['v1', 'long.png']);
  expect(found.items.every(item => item.data.compact)).toBe(true);
  expect(JSON.parse(state.query.mock.calls[0][1][0]).map(row => Object.keys(row.data))).toEqual([expect.not.arrayContaining(['prompt'])]);
  // Non-compact and lookup callers still receive full records with saved prompts/settings.
  const full = await listGalleryPage({ media: true, kind: 'video', filename: 'v1.mp4' });
  expect(full.items).toEqual([{ kind: 'video', data: state.videos[0] }]);
  expect((await listGalleryPage({ limit: 200, mediaKeys: ['image:nested.png'] })).items).toEqual([images[0]]);
});

// The pre-#18631 search, verbatim: every token against the decoded record plus
// the derived kind / WxH / lineage words, over index images and FULL video records.
const LEGACY_HAYSTACK = `lower(concat_ws(' ', data::text, kind,
  (data->>'width') || 'x' || (data->>'height'),
  CASE WHEN data->>'extractedFromVideoId' IS NOT NULL THEN 'extracted frame' END,
  CASE WHEN data->>'stitchedFrom' IS NOT NULL THEN 'stitched' END,
  CASE WHEN data->>'upscaledFrom' IS NOT NULL THEN 'upscaled 2x' END))`;
async function legacySearch(q, { kind } = {}) {
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const { rows } = await client.query(`WITH assets AS (
      SELECT media_key, kind, data, created_at FROM pg_temp.media_assets WHERE kind = 'image'
      UNION ALL
      SELECT 'video:' || (value->>'id'), 'video', value, (value->>'createdAt')::timestamptz
      FROM jsonb_array_elements($1::jsonb))
    SELECT media_key, kind, COALESCE(data->>'hidden', 'false') = 'true' AS hidden FROM assets
    WHERE ${tokens.map((_, i) => `strpos(${LEGACY_HAYSTACK}, $${i + 2}) > 0`).join(' AND ') || 'TRUE'}
    ORDER BY created_at DESC, media_key ASC`, [JSON.stringify(state.videos), ...tokens]);
  const visible = rows.filter(row => !row.hidden);
  const count = of => visible.filter(row => row.kind === of).length;
  const paged = visible.filter(row => !kind || row.kind === kind);
  return { keys: paged.map(row => row.media_key), total: paged.length,
    matchedVideos: rows.filter(row => row.kind === 'video').map(row => row.media_key).sort(),
    hiddenTotal: rows.filter(row => row.hidden && (!kind || row.kind === kind)).length,
    counts: { image: count('image'), video: count('video'), all: visible.length } };
}
const pageKeys = page => page.items.map(item => item.kind ? `${item.kind}:${item.kind === 'image' ? item.data.filename : item.data.id}` : `image:${item.filename}`);

it('searches stored columns and the cached video text with the results the decoded-record search gave', async context => {
  if (!available) return context.skip();
  await seed([
    { filename: 'fox.png', createdAt: '2026-03-01', prompt: 'A Red FOX at dusk', width: 1024, height: 768 },
    { filename: 'key.png', createdAt: '2026-03-02', prompt: 'plain', customFieldZeta: 1, negativePrompt: 'Gloomy 100% fo_ggy' },
    { filename: 'lineage.png', createdAt: '2026-03-03', prompt: 'red barn', upscaledFrom: 'fox.png', extractedFromVideoId: 'v-fox', width: 0, height: 0 },
    { filename: 'hidden.png', createdAt: '2026-03-04', prompt: 'red fox hidden', hidden: true, stitchedFrom: ['a.png'] },
    { filename: 'null.png', createdAt: '2026-03-05', prompt: null, width: 512, height: null, upscaledFrom: null, hidden: 'true' },
    { filename: 'facet.png', createdAt: '2026-03-06', prompt: 'fox', universeId: 'u1', entryCategory: 'places', entryKind: 7 },
  ], [{ id: 'v-fox', prompt: 'stale index row that must never match: zebra' }]);
  state.videos = [
    { id: 'v-fox', filename: 'v-fox.mp4', createdAt: '2026-03-07', prompt: 'card text', sentPrompt: 'a RED fox beyond the card',
      promptAdditions: [{ label: 'style', text: 'needle addition' }], width: 1024, height: 768 },
    { id: 'v-up', filename: 'v-up.mp4', createdAt: '2026-03-08', prompt: 'barn', upscaledFrom: 'v-fox', settings: { customFieldZeta: true } },
    { id: 'v-hidden', filename: 'v-hidden.mp4', createdAt: '2026-03-09', prompt: 'red fox', hidden: true, stitchedFrom: ['v-fox', 'v-up'] },
    { id: 'v-plain', filename: 'v-plain.mp4', createdAt: '2026-03-10', prompt: 'nothing', universeId: 'u1', entryCategory: 'places' },
  ];
  state.collections = []; state.annotations = {};
  const queries = ['fox', 'FOX', 'red fox', 'fox red', '1024x768', '0x0', '512x', 'image', 'video', 'video fox', 'upscaled 2x',
    'extracted frame', 'stitched', 'customfieldzeta', '"customfieldzeta":', 'gloomy', 'needle', '"sentprompt":', '100%', 'fo_',
    'f_x', 'true', 'zebra', 'zzz-no-match', '2026-03-0', 'v-fox'];
  const mixed = { media: true, kind: 'all', summary: true, hidden: false, limit: 200 };
  for (const q of queries) {
    const expected = await legacySearch(q);
    for (const compact of [true, false]) {
      state.query.mockClear();
      state.fullReads = 0;
      const page = await listGalleryPage({ ...mixed, compact, q });
      expect({ keys: pageKeys(page), total: page.total, hiddenTotal: page.hiddenTotal, counts: page.counts }, `${q} compact=${compact}`)
        .toEqual({ keys: expected.keys, total: expected.total, hiddenTotal: expected.hiddenTotal, counts: expected.counts });
      if (!compact) continue;
      // One query; the full history is never read, and no full video body is bound.
      expect(state.fullReads).toBe(0);
      expect(state.query).toHaveBeenCalledTimes(1);
      const [sql, params] = state.query.mock.calls[0];
      const bound = JSON.parse(params[0]).map(row => row.data);
      expect(bound.map(video => `video:${video.id}`).sort(), q).toEqual(expected.matchedVideos);
      for (const video of bound) for (const field of ['prompt', 'sentPrompt', 'promptAdditions', 'settings']) expect(video).not.toHaveProperty(field);
      // The plan decodes no record to filter it: no JSON-to-text cast, no lower().
      const plan = (await client.query(`EXPLAIN (VERBOSE) ${sql}`, params)).rows.map(row => row['QUERY PLAN']).join('\n');
      expect(plan, q).not.toMatch(/\bdata\)?::text|lower\(/);
    }
    // Video-only and image-only surfaces share the predicate.
    const videoOnly = await legacySearch(q, { kind: 'video' });
    const videos = await listGalleryPage({ ...mixed, kind: 'video', summary: false, compact: true, q });
    expect({ keys: pageKeys(videos), total: videos.total }, `${q} video`).toEqual({ keys: videoOnly.keys, total: videoOnly.total });
    const imageOnly = await legacySearch(q, { kind: 'image' });
    const images = await listGalleryPage({ hidden: false, summary: true, limit: 200, q });
    expect({ keys: pageKeys(images), total: images.total, hiddenTotal: images.hiddenTotal }, `${q} image`)
      .toEqual({ keys: imageOnly.keys, total: imageOnly.total, hiddenTotal: imageOnly.hiddenTotal });
  }
  // Facet filters read their columns for both kinds, alongside a search.
  const scoped = await listGalleryPage({ ...mixed, compact: true, universeId: 'u1', entryCategory: 'places' });
  expect(pageKeys(scoped)).toEqual(['video:v-plain', 'image:facet.png']);
  expect(pageKeys(await listGalleryPage({ ...mixed, compact: true, universeId: 'u1', q: 'fox' }))).toEqual(['image:facet.png']);
  // The facet picker reads columns only; a non-string facet value stays out, as before.
  state.query.mockClear();
  const facets = await listGalleryFacets(disk);
  expect(facets).toMatchObject({ universes: [{ id: 'u1', name: 'u1' }], categories: ['places'], kinds: [] });
  for (const [sql, params] of state.query.mock.calls) {
    const plan = (await client.query(`EXPLAIN (VERBOSE) ${sql}`, params)).rows.map(row => row['QUERY PLAN']).join('\n');
    expect(plan).not.toMatch(/\bdata ->|\bdata\)?::text/);
  }
});

it('sends no full video detail to SQL and does not spill for the synthetic 2400-image/1200-video page', async context => {
  if (!available) return context.skip();
  diagnostics = createDbPhaseDiagnostics({ onTestFailed: callback => context.onTestFailed(callback), observer, fixturePid: client.processID,
    enabled: process.env.PORTOS_DB_PHASE_DIAGNOSTICS === '1' });
  const { phase } = diagnostics;
  const images = await phase('fixture-images', () => Array.from({ length: 2400 }, (_, i) => mediaFixture('image', i)));
  await seed(images, [], phase);
  state.videos = await phase('fixture-videos', () => Array.from({ length: 1200 }, (_, i) => mediaFixture('video', i)));
  state.collections = [];
  await phase('reset-work-mem', () => client.query('RESET work_mem'));
  const measure = async compact => {
    const label = compact ? 'compact' : 'full';
    state.query.mockClear();
    const page = await phase(`${label}-public-query`, () => listGalleryPage({ media: true, kind: 'all', summary: true, hidden: false, compact, limit: 60 }));
    expect(state.query).toHaveBeenCalledTimes(1);
    const [sql, params] = state.query.mock.calls[0];
    // Measure the actual public-boundary result without executing the same query again.
    const result = await state.query.mock.results[0].value;
    const explained = await phase(`${label}-explain`, () => client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params));
    const nodes = planNodes(explained.rows[0]['QUERY PLAN'][0].Plan);
    return phase(`${label}-result-sizes`, () => ({ page, params, videoBytes: Buffer.byteLength(params[0]), resultBytes: Buffer.byteLength(JSON.stringify(result.rows)),
      responseBytes: Buffer.byteLength(JSON.stringify(page)),
      tempReadBlocks: Math.max(...nodes.map(node => node['Temp Read Blocks'] || 0)),
      tempWrittenBlocks: Math.max(...nodes.map(node => node['Temp Written Blocks'] || 0)),
      executionMs: explained.rows[0]['QUERY PLAN'][0]['Execution Time'] }));
  };
  const before = await measure(false);
  const after = await measure(true);
  expect(after.page).toEqual(compactedFull(before.page));
  expect(after.page.items).toHaveLength(60);
  const videos = JSON.parse(after.params[0]);
  expect(videos).toHaveLength(1200);
  for (const { data } of videos) {
    expect(data).not.toHaveProperty('prompt');
    expect(data._promptPreviewSource.length).toBeLessThanOrEqual(241);
  }
  expect(after.tempReadBlocks).toBe(0);
  expect(after.tempWrittenBlocks).toBe(0);
  expect(after.videoBytes).toBeLessThan(before.videoBytes / 10);
  expect(after.resultBytes).toBeLessThan(before.resultBytes / 10);
  if (process.env.PORTOS_COLLECTION_BENCHMARK === '1') {
    for (const [label, run] of [['full', before], ['compact', after]]) {
      const { page: _page, params: _params, ...metrics } = run;
      process.stdout.write(JSON.stringify({ label, ...metrics }) + '\n');
    }
  }
});
