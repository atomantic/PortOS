import { describe, it, expect, vi, afterEach } from 'vitest';
import { listGalleryPage, listGalleryFacets, listGalleryCollectionSummaries } from './gallery.js';
import { imageToRow } from './logic.js';
import { query } from '../../lib/db.js';

const { listAnnotations, loadHistory, listCollections, getCollection } = vi.hoisted(() => ({ listAnnotations: vi.fn(), loadHistory: vi.fn(), listCollections: vi.fn(), getCollection: vi.fn() }));
vi.mock('../videoGen/history.js', () => ({ loadHistory }));
vi.mock('../mediaCollections.js', () => ({ listCollections, getCollection }));
vi.mock('../mediaAnnotations.js', () => ({ listAnnotations }));

vi.mock('../../lib/db.js', () => ({ query: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe('indexed gallery page', () => {
  it('bounds production SQL reads and preserves metadata without invoking disk', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('MEMORY_BACKEND', 'db');
    const item = { filename: 'fox.png', path: '/data/images/fox.png', prompt: '100% fox', seed: 8, hidden: false, loraNames: ['portrait'] };
    query.mockImplementation(async sql => sql.includes('COUNT(*)')
      ? { rows: [{ count: '27' }] } : { rows: [imageToRow(item)] });
    const disk = vi.fn();
    expect(await listGalleryPage({ limit: 5, offset: 10, q: '100% fox', hidden: false }, disk))
      .toEqual({ items: [item], total: 27, limit: 5, offset: 10 });
    const [sql, params] = query.mock.calls.find(([sql]) => sql.startsWith('SELECT data'));
    expect(sql).toContain('ORDER BY created_at DESC, media_key ASC LIMIT $4 OFFSET $5');
    expect(params).toEqual(['image', '100%', 'fox', 5, 10]);
    expect(sql).toContain("strpos(lower(concat_ws(' ', data::text, kind");
    expect(sql).toContain("COALESCE(data->>'hidden', 'false') <> 'true'");
    expect(disk).not.toHaveBeenCalled();
  });

  it('does not turn an index failure into a full disk scan', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('MEMORY_BACKEND', 'db');
    query.mockRejectedValue(new Error('database unavailable'));
    const disk = vi.fn();
    await expect(listGalleryPage({}, disk)).rejects.toThrow('database unavailable');
    expect(disk).not.toHaveBeenCalled();
  });
});


describe('recent image filters', () => {
  it('filters by the local author before paging and counts hidden matches without loading rows', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('MEMORY_BACKEND', 'db');
    listAnnotations.mockResolvedValue({
      'image:own.png': { own: { starred: true } },
      'image:peer.png': { own: null, others: [{ starred: true }] },
    });
    query.mockImplementation(async sql => sql.includes('COUNT(*)')
      ? { rows: [{ count: sql.includes("data->>'hidden' = 'true'") ? '2' : '12' }] }
      : { rows: [{ data: { filename: 'own.png' } }] });
    const disk = vi.fn();
    const page = await listGalleryPage({ limit: 5, starred: true, hidden: false, summary: true }, disk);
    expect(page).toEqual({ items: [{ filename: 'own.png' }], total: 12, hiddenTotal: 2, limit: 5, offset: 0 });
    expect(query).toHaveBeenCalledTimes(3);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain('media_key = ANY($2::text[])');
      expect(params[1]).toEqual(['image:own.png']);
    }
    expect(disk).not.toHaveBeenCalled();
  });

  it('uses exact filename lookup for older deep links and handles empty own favorites in the file escape hatch', async () => {
    const disk = vi.fn(async () => [
      { filename: 'new.png' }, { filename: 'older.png', hidden: true },
    ]);
    expect(await listGalleryPage({ limit: 1, filename: 'older.png' }, disk))
      .toEqual({ items: [{ filename: 'older.png', hidden: true }], total: 1, limit: 1, offset: 0 });
    listAnnotations.mockResolvedValue({ 'image:older.png': { others: [{ starred: true }] } });
    expect(await listGalleryPage({ limit: 5, starred: true, summary: true }, disk))
      .toEqual({ items: [], total: 0, hiddenTotal: 0, limit: 5, offset: 0 });

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('MEMORY_BACKEND', 'db');
    query.mockImplementation(async sql => sql.includes('COUNT(*)') ? { rows: [{ count: '0' }] } : { rows: [] });
    await listGalleryPage({ limit: 1, filename: 'older.png' }, disk);
    expect(query.mock.calls[0][0]).toContain('ref = $2');
    expect(query.mock.calls[0][1]).toEqual(['image', 'older.png', 1, 0]);
  });
});

describe('scoped browsing compatibility', () => {
  it('keeps search tokens, global counts, collection order and unfiled membership before paging', async () => {
    const images = [
      { filename: 'a.png', universeId: 'u', universeName: 'Example', width: 1024, height: 768, entryCategory: 'places', entryKind: 'canon', createdAt: '2026-01-03' },
      { filename: 'b.png', prompt: 'loose', hidden: true, createdAt: '2026-01-01' },
    ];
    const video = { id: 'v', filename: 'v.mp4', upscaledFrom: 'source', createdAt: '2026-01-02' };
    loadHistory.mockResolvedValue([video]);
    const collection = { id: 'col', name: 'Example collection', items: [
      { kind: 'image', ref: 'a.png', addedAt: '2026-01-01' },
      { kind: 'video', ref: 'v', addedAt: '2026-01-04' },
    ] };
    listCollections.mockResolvedValue([collection]); getCollection.mockResolvedValue(collection);
    const disk = async () => images;
    expect((await listGalleryPage({ q: '1024x768 image', universeId: 'u', entryCategory: 'places', entryKind: 'canon', limit: 1 }, disk)).items).toEqual([images[0]]);
    const videos = await listGalleryPage({ kind: 'video', summary: true }, disk);
    expect(videos.counts).toEqual({ image: 2, video: 1, all: 3 });
    expect(videos.items).toEqual([{ kind: 'video', data: video }]);
    expect((await listGalleryPage({ kind: 'all', collectionId: 'col', limit: 1 }, disk)).items).toEqual([{ kind: 'video', data: video }]);
    expect((await listGalleryPage({ kind: 'all', collectionId: 'unsorted', limit: 1 }, disk)).items).toEqual([{ kind: 'image', data: images[1] }]);
    expect(await listGalleryFacets(disk)).toEqual({ universes: [{ id: 'u', name: 'Example' }], categories: ['places'], kinds: ['canon'], collections: [{ id: 'col', name: 'Example collection' }] });
    const summaries = await listGalleryCollectionSummaries(disk);
    expect(summaries.find(s => s.id === 'col')).toMatchObject({ total: 2, cover: '/data/images/a.png' });
    expect(summaries.find(s => s.id === 'unsorted')).toMatchObject({ total: 1, counts: { image: 1, video: 0, all: 1 } });
  });
});
