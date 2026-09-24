import { describe, it, expect, vi, afterEach } from 'vitest';
import { listGalleryPage, listGalleryFacets, listGalleryCollectionSummaries, listImageVariants } from './gallery.js';
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

  it('binds and serializes the synthetic video snapshot once for a mixed summary page', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('MEMORY_BACKEND', 'db');
    const serialize = vi.fn(function () { return { id: this.id, createdAt: this.createdAt }; });
    const videos = Array.from({ length: 200 }, (_, i) => ({
      id: `example-${i}`, createdAt: '2026-01-01', toJSON: serialize,
    }));
    loadHistory.mockResolvedValue(videos);
    listAnnotations.mockResolvedValue({ 'video:example-1': { own: { starred: true } } });
    query.mockResolvedValue({ rows: [{ items: [], total: '1', hiddenTotal: '0', image: '0', video: '200' }] });
    expect(await listGalleryPage({ kind: 'video', summary: true, starred: true, limit: 1, offset: 1 }))
      .toEqual({ items: [], total: 1, hiddenTotal: 0, counts: { image: 0, video: 200, all: 200 }, limit: 1, offset: 1 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledTimes(200);
    const [sql, params] = query.mock.calls[0];
    expect(sql.match(/jsonb_array_elements/g)).toHaveLength(1);
    expect(sql).toContain('gallery_assets AS MATERIALIZED');
    expect(JSON.parse(params[0])).toHaveLength(200);
    expect(params.slice(-2)).toEqual([1, 1]);
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

// The route test (routes/imageGen.clean.test.js) owns the both-directions
// contract end to end against a real clean. What only lives here: the SQL the
// indexed path emits, and the disk path the route test cannot reach because
// the test runner always takes the escape hatch.
describe('image variant lookup', () => {
  const original = { filename: 'fox.png', path: '/data/images/fox.png', prompt: 'a fox' };
  const cleaned = { filename: 'fox_clean-resize-squeeze.png', path: '/data/images/fox_clean-resize-squeeze.png', cleanedFrom: 'fox.png', cleanLevel: 'resize-squeeze' };

  it.each([
    ['the original', 'fox.png'],
    ['a cleaned copy', 'fox_clean-resize-squeeze.png'],
  ])('reads the whole gallery once per call when opened from %s', async (_label, opened) => {
    const disk = vi.fn(async () => [original, cleaned, { filename: 'unrelated.png' }]);
    expect(await listImageVariants(opened, disk)).toEqual([original, cleaned]);
    // Each read is a directory scan plus a sidecar read per image.
    expect(disk).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  // An auto-cleaned image replaced its source in place and carries no
  // `cleanedFrom`, so it IS the group root, never a sibling of itself.
  it('returns just the group root for an auto-cleaned image', async () => {
    const auto = { filename: 'owl.png', autoCleaned: true };
    expect(await listImageVariants('owl.png', vi.fn(async () => [auto]))).toEqual([auto]);
  });

  it('binds the reverse lookup to the group root and scopes it to images', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('MEMORY_BACKEND', 'db');
    query.mockImplementation(async sql => sql.includes("data->>'cleanedFrom'")
      ? { rows: [imageToRow(cleaned)] } : { rows: [imageToRow(original)] });
    // Opened from the CLEANED copy, so the root is reached via its cleanedFrom.
    expect(await listImageVariants(cleaned.filename, vi.fn())).toEqual([original, cleaned]);
    const [sql, params] = query.mock.calls.find(([sql]) => sql.includes("data->>'cleanedFrom'"));
    expect(sql).toContain('kind = $1');
    expect(params).toEqual(['image', 'fox.png']);
  });
});
