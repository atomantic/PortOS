import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import pg from 'pg';
import { mediaDdl } from '../../lib/db/schema/media.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { mediaFixture } from '../../../scripts/perf/collectionFixtureData.js';
import { listGalleryCollectionSummaries, listGalleryFacets, listGalleryPage } from './gallery.js';
import { compactGalleryRecord } from './logic.js';

const state = vi.hoisted(() => ({ file: false, images: [], videos: [], collections: [], annotations: {}, query: vi.fn() }));
vi.mock('../../lib/runtimeEnv.js', () => ({ isTestRunner: () => state.file }));
vi.mock('../../lib/db.js', () => ({ query: (...args) => state.query(...args) }));
vi.mock('../videoGen/history.js', () => ({ loadHistory: async () => state.videos }));
vi.mock('../mediaCollections.js', () => ({ listCollections: async () => state.collections,
  getCollection: async id => state.collections.find(collection => collection.id === id) }));
vi.mock('../mediaAnnotations.js', () => ({ listAnnotations: async () => state.annotations }));
let client;
let available = false;
beforeAll(async () => {
  vi.stubEnv('MEMORY_BACKEND', 'db');
  if (process.env.PGDATABASE !== 'portos_test') {
    requireDbOrSkip('gallery collection batches', false, 'requires portos_test');
    return;
  }
  client = new pg.Client({ database: 'portos_test', host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || 'portos',
    password: process.env.PGPASSWORD || 'portos', options: '', connectionTimeoutMillis: 2000 });
  await client.connect();
  // A session-private table shadows the index, including for EXPLAIN: no live rows.
  const ddl = mediaDdl.filter(sql => /(?:TABLE IF NOT EXISTS media_assets|INDEX IF NOT EXISTS idx_media_assets_)/.test(sql));
  for (const sql of ddl) await client.query(sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
  state.query.mockImplementation((...args) => client.query(...args));
  available = true;
});
afterAll(async () => { await client?.end(); vi.unstubAllEnvs(); });

async function seed(images, indexedVideos = []) {
  state.images = images;
  await client.query('TRUNCATE pg_temp.media_assets');
  const rows = [...images.map(data => ({ kind: 'image', ref: data.filename, data })),
    ...indexedVideos.map(data => ({ kind: 'video', ref: data.id, data }))];
  await client.query(`INSERT INTO pg_temp.media_assets (media_key, kind, ref, data, created_at)
    SELECT kind || ':' || ref, kind, ref, data, COALESCE((data->>'createdAt')::timestamptz, 'epoch')
    FROM jsonb_to_recordset($1::jsonb) AS r(kind text, ref text, data jsonb)`, [JSON.stringify(rows)]);
}
const member = (kind, ref, addedAt = '2026-01-01') => ({ kind, ref, addedAt });
const disk = async () => state.images;

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
  expect(expected[0]).toEqual({ id: 'unsorted', cover: '/data/images/loose.png', total: 2, counts: { image: 1, video: 1, all: 2 } });
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
    for (let i = 0; i < count; i++) expect(pinned[i + 1].cover).toBe(state.images[i * 20 + 19].path);
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
        if (!sql.startsWith('SELECT COUNT(*)')) expect(sql).toContain('jsonb_each(data)');
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

  // Search keeps full-metadata matching beyond the preview, in both kinds.
  const found = await listGalleryPage({ media: true, kind: 'all', summary: true, compact: true, q: beyond });
  expect(found.items.map(item => item.data.id || item.data.filename)).toEqual(['v1', 'long.png']);
  expect(found.items.every(item => item.data.compact)).toBe(true);
  // Non-compact and lookup callers still receive full records with saved prompts/settings.
  const full = await listGalleryPage({ media: true, kind: 'video', filename: 'v1.mp4' });
  expect(full.items).toEqual([{ kind: 'video', data: state.videos[0] }]);
  expect((await listGalleryPage({ limit: 200, mediaKeys: ['image:nested.png'] })).items).toEqual([images[0]]);
});

it('sends no full video detail to SQL and does not spill for the synthetic 2400-image/1200-video page', async context => {
  if (!available) return context.skip();
  await seed(Array.from({ length: 2400 }, (_, i) => mediaFixture('image', i)));
  state.videos = Array.from({ length: 1200 }, (_, i) => mediaFixture('video', i));
  state.collections = [];
  await client.query('RESET work_mem');
  const measure = async compact => {
    state.query.mockClear();
    const page = await listGalleryPage({ media: true, kind: 'all', summary: true, hidden: false, compact, limit: 60 });
    expect(state.query).toHaveBeenCalledTimes(1);
    const [sql, params] = state.query.mock.calls[0];
    const result = await client.query(sql, params);
    const explained = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const nodes = planNodes(explained.rows[0]['QUERY PLAN'][0].Plan);
    return { page, params, videoBytes: Buffer.byteLength(params[0]), resultBytes: Buffer.byteLength(JSON.stringify(result.rows)),
      responseBytes: Buffer.byteLength(JSON.stringify(page)),
      tempReadBlocks: Math.max(...nodes.map(node => node['Temp Read Blocks'] || 0)),
      tempWrittenBlocks: Math.max(...nodes.map(node => node['Temp Written Blocks'] || 0)),
      executionMs: explained.rows[0]['QUERY PLAN'][0]['Execution Time'] };
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
