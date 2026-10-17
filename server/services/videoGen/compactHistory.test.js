import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rename, rm, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mediaFixture, CARDINALITIES } from '../../../scripts/perf/collectionFixtureData.js';
import { compactGalleryRecord } from '../mediaAssetIndex/logic.js';

const io = vi.hoisted(() => ({ root: '', reads: 0, afterRead: null, accessError: null }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal();
  return { ...real, access: async (...args) => {
    if (io.accessError) throw io.accessError;
    return real.access(...args);
  } };
});
vi.mock('../../lib/fileUtils.js', async () => {
  const { readJSONFile } = await import('../../lib/jsonIo.js');
  const { atomicWrite } = await import('../../lib/fileCore.js');
  return { PATHS: { get data() { return io.root; } }, atomicWrite,
    readJSONFile: async (...args) => {
      io.reads++;
      const result = await readJSONFile(...args);
      if (io.afterRead) await io.afterRead();
      return result;
    } };
});
vi.mock('../mediaCollections.js', () => ({ listCollections: async () => [], getCollection: async () => null }));
vi.mock('../mediaAnnotations.js', () => ({ listAnnotations: async () => ({ 'video:synthetic-video-00001': { own: { starred: true } } }) }));

let history;
let file;
let listGalleryPage;
let listGalleryCollectionSummaries;
beforeEach(async () => {
  vi.resetModules();
  if (io.root) await rm(io.root, { recursive: true, force: true });
  io.root = await mkdtemp(join(tmpdir(), 'compact-history-'));
  io.reads = 0;
  io.afterRead = null;
  io.accessError = null;
  file = join(io.root, 'video-history.json');
  history = await import('./history.js');
  ({ listGalleryPage, listGalleryCollectionSummaries } = await import('../mediaAssetIndex/gallery.js'));
});
afterAll(async () => { await rm(io.root, { recursive: true, force: true }); });
const persist = rows => writeFile(file, JSON.stringify(rows));

describe('compact history through gallery reads', () => {
  it('reuses one immutable bounded projection for concurrent and repeated 1,200-video pages and covers', async () => {
    const rows = Array.from({ length: CARDINALITIES.videos }, (_, i) => mediaFixture('video', i));
    await persist(rows);
    const fullTimings = [];
    for (let index = 0; index < 5; index++) {
      const started = performance.now();
      await history.loadHistory();
      fullTimings.push(performance.now() - started);
    }
    expect(io.reads).toBe(5);
    io.reads = 0;
    const options = { media: true, kind: 'all', summary: true, compact: true, hidden: false, limit: 60, videoSnapshot: null };
    const start = performance.now();
    const pages = await Promise.all(Array.from({ length: 5 }, (_, i) => listGalleryPage({ ...options, offset: i * 60 }, async () => [])));
    const coldMs = performance.now() - start;
    const warmStart = performance.now();
    await listGalleryPage(options, async () => []);
    const warmMs = performance.now() - warmStart;
    for (let index = 0; index < 2; index++) {
      expect(await listGalleryCollectionSummaries(async () => [])).toEqual([{
        id: 'unsorted', counts: { image: 0, video: 1200, all: 1200 }, total: 1200,
        cover: '/data/video-thumbnails/synthetic-video-01199.png',
      }]);
    }
    expect(io.reads).toBe(1);
    expect(pages.every(page => page.items.length === 60 && page.total === 1080)).toBe(true);
    const snapshot = await history.loadCompactHistory();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(snapshot[0]._promptPreviewSource).toHaveLength(241);
    expect(snapshot[0]).not.toHaveProperty('status');
    expect(compactGalleryRecord(snapshot[0])).toEqual(compactGalleryRecord(rows[0]));
    console.log(`📊 Compact video fixture: fileBytes=${(await stat(file)).size}, compactBytes=${Buffer.byteLength(JSON.stringify(snapshot))}, fullReads=5, fullMedianMs=${fullTimings.sort((a, b) => a - b)[2].toFixed(2)}, compactReads=${io.reads}, concurrentMs=${coldMs.toFixed(2)}, warmPageMs=${warmMs.toFixed(2)}`);
  });

  it('preserves page/count filters and full search/detail beyond the preview', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ ...mediaFixture('video', i),
      prompt: ' '.repeat(300) + 'tailneedle', universeId: i % 2 ? 'one' : 'two', stitchedFrom: ['original'] }));
    await persist(rows);
    const collectionSnapshot = [{ id: 'set', items: rows.slice(0, 7).map(row => ({ kind: 'video', ref: row.id })) }];
    for (const filters of [{}, { kind: 'video' }, { hidden: true }, { collectionId: 'set' },
      { collectionId: 'unsorted' }, { starred: true }, { universeId: 'one' }, { offset: 3 }]) {
      const options = { media: true, kind: 'all', summary: true, hidden: false, limit: 3, collectionSnapshot, ...filters };
      const full = await listGalleryPage({ ...options, videoSnapshot: rows }, async () => []);
      const compact = await listGalleryPage({ ...options, compact: true }, async () => []);
      expect(compact).toEqual({ ...full, items: full.items.map(item => ({ ...item, data: compactGalleryRecord(item.data) })) });
    }
    expect(io.reads).toBe(1);
    expect((await listGalleryPage({ media: true, kind: 'video', compact: true, q: 'tailneedle' }, async () => [])).total).toBe(12);
    expect(await history.getHistoryItem(rows[0].id)).toEqual(rows[0]);
    const snapshot = await history.loadCompactHistory();
    expect(() => snapshot[0].stitchedFrom.push('mutated')).toThrow();
    expect(io.reads).toBe(3);
  });

  it('refreshes after local create/update/delete and external same-size or atomic replacement', async () => {
    await history.saveHistory([{ id: 'a', prompt: 'old' }]);
    expect((await history.loadCompactHistory())[0]._promptPreviewSource).toBe('old');
    await history.mutateVideoHistory(rows => [...rows, { id: 'b' }]);
    expect(await history.loadCompactHistory()).toHaveLength(2);
    await history.mutateVideoHistory(rows => rows.map(row => ({ ...row, hidden: true })));
    expect((await history.loadCompactHistory())[0].hidden).toBe(true);
    await history.mutateVideoHistory(rows => rows.filter(row => row.id === 'a'));
    expect(await history.loadCompactHistory()).toHaveLength(1);
    const before = await stat(file);
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('old', 'new'));
    await utimes(file, before.atime, before.mtime);
    expect((await history.loadCompactHistory())[0]._promptPreviewSource).toBe('new');
    await writeFile(file + '.restore', JSON.stringify([{ id: 'restored' }]));
    await rename(file + '.restore', file);
    expect(await history.loadCompactHistory()).toEqual([{ id: 'restored' }]);
  });

  it('does not publish a read overtaken by a save or external replacement', async () => {
    await persist([{ id: 'old' }]);
    io.afterRead = async () => {
      io.afterRead = null;
      await history.saveHistory([{ id: 'new' }]);
    };
    expect(await history.loadCompactHistory()).toEqual([{ id: 'new' }]);
    await persist([{ id: 'external-old' }]);
    io.afterRead = async () => {
      io.afterRead = null;
      await writeFile(file + '.restore', JSON.stringify([{ id: 'external-new' }]));
      await rename(file + '.restore', file);
    };
    const results = await Promise.all([history.loadCompactHistory(), history.loadCompactHistory()]);
    expect(results).toEqual([[{ id: 'external-new' }], [{ id: 'external-new' }]]);
    expect(io.reads).toBe(4);
  });

  it('never serves a cached value over corrupt, unreadable, empty or missing history', async () => {
    await persist([{ id: 'cached' }]);
    await history.loadCompactHistory();
    io.accessError = Object.assign(new Error('unreadable'), { code: 'EACCES' });
    await expect(history.loadCompactHistory()).rejects.toThrow('unreadable');
    io.accessError = null;
    await writeFile(file, 'invalid');
    await expect(history.loadCompactHistory()).rejects.toThrow();
    await writeFile(file, '');
    await expect(history.loadCompactHistory()).rejects.toThrow();
    await persist([]);
    expect(await history.loadCompactHistory()).toEqual([]);
    await rm(file);
    expect(await history.loadCompactHistory()).toEqual([]);
    await persist([{ id: 'returned' }]);
    expect(await history.loadCompactHistory()).toEqual([{ id: 'returned' }]);
  });
});
