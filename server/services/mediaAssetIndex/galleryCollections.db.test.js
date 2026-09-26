import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import pg from 'pg';
import { mediaDdl } from '../../lib/db/schema/media.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { mediaFixture } from '../../../scripts/perf/collectionFixtureData.js';
import { listGalleryCollectionSummaries, listGalleryFacets } from './gallery.js';

const state = vi.hoisted(() => ({ file: false, images: [], videos: [], collections: [], query: vi.fn() }));
vi.mock('../../lib/runtimeEnv.js', () => ({ isTestRunner: () => state.file }));
vi.mock('../../lib/db.js', () => ({ query: (...args) => state.query(...args) }));
vi.mock('../videoGen/history.js', () => ({ loadHistory: async () => state.videos }));
vi.mock('../mediaCollections.js', () => ({ listCollections: async () => state.collections }));
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
