/**
 * Postgres-backed round-trip for the media asset index.
 *
 * Like projectsDB.test.js, this needs a live PostgreSQL with the schema applied.
 * If no DB is reachable (CI, fresh checkout), it SKIPS cleanly rather than
 * failing red. When a DB IS reachable it exercises upsert/list/remove and the
 * full reconcile (upsert-everything + prune-stale), using INJECTED disk readers
 * so it never touches the real media-gen stack, and cleaning its rows up after.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';

vi.mock('../../lib/db.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, query: vi.fn(actual.query) };
});

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'media_assets') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'media_assets table not present';
  }
}

const runDb = requireDbOrSkip('services/mediaAssetIndex/db.test', dbReady, skipReason);

// Test rows use a recognizable prefix so cleanup can target them without
// touching any real indexed assets that happen to share the dev DB.
const PFX = 'test-mai-';

describe.skipIf(!runDb)('media asset index DB round-trip', () => {
  let db;
  // reconcile is a GLOBAL sweep (it prunes every row not on disk), so it would
  // wipe any real index rows on a shared dev DB. Snapshot the table up front and
  // restore it after, leaving the developer's index exactly as we found it.
  let snapshot = [];
  beforeAll(async () => {
    db = await import('./db.js');
    const res = await query(`SELECT media_key, kind, ref, data, created_at FROM media_assets`);
    snapshot = res.rows;
  });

  afterAll(async () => {
    await query(`DELETE FROM media_assets WHERE ref LIKE $1`, [`${PFX}%`]).catch(() => {});
    // Restore any pre-existing rows the global reconcile prune removed.
    for (const r of snapshot) {
      await query(
        `INSERT INTO media_assets (media_key, kind, ref, data, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (media_key) DO NOTHING`,
        [r.media_key, r.kind, r.ref, JSON.stringify(r.data), r.created_at],
      ).catch(() => {});
    }
    await close();
  });

  it('upserts, lists, and removes an asset (lossless data)', async () => {
    const data = { filename: `${PFX}a.png`, prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z' };
    await db.upsertAsset({ mediaKey: `image:${PFX}a.png`, kind: 'image', ref: `${PFX}a.png`, data, createdAt: data.createdAt });

    const imgs = await db.listAssets({ kind: 'image' });
    const found = imgs.find((x) => x.filename === `${PFX}a.png`);
    expect(found).toEqual(data);

    await db.removeAsset(`image:${PFX}a.png`);
    const after = await db.listAssets({ kind: 'image' });
    expect(after.some((x) => x.filename === `${PFX}a.png`)).toBe(false);
  });

  it('countAssets matches listAssets().length without materializing rows', async () => {
    // countAssets is the cheap COUNT(*) the character skill registry reads on every
    // GET /api/character. Pin it against listAssets so the two can never disagree.
    const keys = [`image:${PFX}c1.png`, `image:${PFX}c2.png`, `video:${PFX}c3.mp4`];
    const before = await db.countAssets({ kind: 'image' });
    expect(before).toBe((await db.listAssets({ kind: 'image' })).length);

    await db.upsertAsset({ mediaKey: keys[0], kind: 'image', ref: `${PFX}c1.png`, data: { filename: `${PFX}c1.png` }, createdAt: '2026-01-01T00:00:00.000Z' });
    await db.upsertAsset({ mediaKey: keys[1], kind: 'image', ref: `${PFX}c2.png`, data: { filename: `${PFX}c2.png` }, createdAt: '2026-01-02T00:00:00.000Z' });
    await db.upsertAsset({ mediaKey: keys[2], kind: 'video', ref: `${PFX}c3.mp4`, data: { filename: `${PFX}c3.mp4` }, createdAt: '2026-01-03T00:00:00.000Z' });

    // The `kind` filter must actually filter — the video must not land in the image tally.
    expect(await db.countAssets({ kind: 'image' })).toBe(before + 2);
    expect(await db.countAssets({ kind: 'image' })).toBe((await db.listAssets({ kind: 'image' })).length);
    // Unfiltered counts every kind, and is what the Auteur skill reads.
    expect(await db.countAssets()).toBe((await db.listAssets()).length);

    for (const key of keys) await db.removeAsset(key);
    expect(await db.countAssets({ kind: 'image' })).toBe(before);
  });

  it('pages mixed authoritative videos and indexed images with search and scopes before LIMIT', async () => {
    const image = { filename: `${PFX}paged.png`, prompt: 'fox', universeId: 'example-u', entryCategory: 'places', entryKind: 'canon', width: 1024, height: 768, createdAt: '2026-01-03T00:00:00Z' };
    await db.upsertAsset({ mediaKey: `image:${image.filename}`, kind: 'image', ref: image.filename, data: image, createdAt: image.createdAt });
    const video = { id: `${PFX}paged-video`, filename: 'clip.mp4', prompt: 'fox', upscaledFrom: 'source', createdAt: '2026-01-02T00:00:00Z' };
    // Stale derived video is deliberately ignored in favor of the live snapshot.
    await db.upsertAsset({ mediaKey: `video:${video.id}`, kind: 'video', ref: video.id, data: { ...video, prompt: 'outdated' }, createdAt: video.createdAt });
    const options = { videos: [video], mediaKeys: [`image:${image.filename}`, `video:${video.id}`], q: 'fox' };
    expect(await db.listAssets({ ...options, typed: true, limit: 1, offset: 1 })).toEqual([{ kind: 'video', data: video }]);
    expect(await db.countAssets(options)).toBe(2);
    expect(await db.listAssets({ ...options, limit: 1, offset: 5 })).toEqual([]);
    expect(await db.countAssets({ ...options, excludeKeys: [`image:${image.filename}`] })).toBe(1);
    expect(await db.listAssets({ ...options, kind: 'image', universeId: 'example-u', entryCategory: 'places', entryKind: 'canon', q: '1024x768 image', limit: 1 })).toEqual([image]);
    expect(await db.listAssets({ ...options, q: 'upscaled 2x', limit: 1 })).toEqual([video]);
    expect(await db.listAssets({ ...options, filename: 'clip.mp4', limit: 1 })).toEqual([video]);
    expect(await db.listAssets({ ...options, orderedKeys: [`video:${video.id}`, `image:${image.filename}`], typed: true, limit: 1 })).toEqual([{ kind: 'video', data: video }]);
    await db.removeAsset(`image:${image.filename}`);
    await db.removeAsset(`video:${video.id}`);
  });

  it('matches legacy mixed summary semantics and expands the snapshot once, including empty pages', async () => {
    const images = [
      { filename: `${PFX}summary-a.png`, prompt: '100% fox', createdAt: '2026-01-03', universeId: 'example-u' },
      { filename: `${PFX}summary-b.png`, prompt: '100% fox', createdAt: '2026-01-02', hidden: true },
    ];
    const videos = [
      { id: `${PFX}summary-v`, prompt: '100% fox', createdAt: '2026-01-01', thumbnail: 'example.jpg' },
      { id: `${PFX}summary-hidden`, prompt: 'fox', createdAt: 'invalid', hidden: true },
    ];
    for (const image of images) await db.upsertAsset({ mediaKey: `image:${image.filename}`,
      kind: 'image', ref: image.filename, data: image, createdAt: image.createdAt });
    const keys = [...images.map(image => `image:${image.filename}`), ...videos.map(video => `video:${video.id}`)];
    const cases = [
      {}, { offset: 1 }, { offset: 99 }, { hidden: false }, { hidden: true },
      { kind: 'video', hidden: false, q: '100% fox' },
      { mediaKeys: [keys[2]], countMediaKeys: keys, kind: 'video' }, // starred within collection
      { mediaKeys: [], countMediaKeys: keys }, // no favorites; chips still populated
      { excludeKeys: [keys[0], keys[2]] }, // unsorted
      { orderedKeys: [...keys].reverse() },
      { cover: true }, { universeId: 'example-u' }, { filename: images[0].filename },
      { videos: [], mediaKeys: [], countMediaKeys: [] }, // entirely empty
      { videos: [] }, // images only
      { mediaKeys: keys.slice(2), countMediaKeys: keys.slice(2) }, // videos only
    ];
    for (const options of cases) {
      const input = { videos, limit: 1, offset: 0, mediaKeys: keys, countMediaKeys: keys, ...options };
      const { limit, offset, orderedKeys, cover, countMediaKeys, ...filters } = input;
      const items = await db.listAssets({ ...filters, limit, offset, orderedKeys, cover, typed: true });
      const total = await db.countAssets(filters);
      const hiddenTotal = await db.countAssets({ ...filters, hidden: true });
      const image = await db.countAssets({ ...filters, kind: 'image', mediaKeys: countMediaKeys });
      const video = await db.countAssets({ ...filters, kind: 'video', mediaKeys: countMediaKeys });
      query.mockClear();
      expect(await db.listMixedGalleryPage(input)).toEqual({ items, total, hiddenTotal,
        counts: { image, video, all: image + video } });
      expect(query).toHaveBeenCalledTimes(1);
    }
    // Actual PostgreSQL plan: even with every summary field, the JSONB function
    // executes once. Synthetic records keep this deterministic, with no timing gate.
    const syntheticVideos = Array.from({ length: 200 }, (_, i) => ({
      id: `${PFX}synthetic-${i}`, createdAt: '2026-01-01',
    }));
    query.mockClear();
    await db.listMixedGalleryPage({ videos: syntheticVideos, limit: 1 });
    const [sql, params] = query.mock.calls[0];
    const explained = await query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
    const nodes = [];
    const visit = node => { nodes.push(node); (node.Plans || []).forEach(visit); };
    visit(explained.rows[0]['QUERY PLAN'][0].Plan);
    const expansions = nodes.filter(node => node['Function Name'] === 'jsonb_array_elements');
    expect(expansions).toHaveLength(1);
    expect(expansions[0]['Actual Loops']).toBe(1);
    expect(expansions[0]['Actual Rows']).toBe(200);
    for (const image of images) await db.removeAsset(`image:${image.filename}`);
  });

  it('upsert refreshes data + created_at on conflict', async () => {
    const key = `image:${PFX}b.png`;
    await db.upsertAsset({ mediaKey: key, kind: 'image', ref: `${PFX}b.png`, data: { filename: `${PFX}b.png`, v: 1 }, createdAt: '2026-01-01T00:00:00.000Z' });
    await db.upsertAsset({ mediaKey: key, kind: 'image', ref: `${PFX}b.png`, data: { filename: `${PFX}b.png`, v: 2 }, createdAt: '2026-02-02T00:00:00.000Z' });
    const imgs = await db.listAssets({ kind: 'image' });
    const found = imgs.find((x) => x.filename === `${PFX}b.png`);
    expect(found.v).toBe(2);
    await db.removeAsset(key);
  });

  it('a delete-hook removal drops the count immediately, with no reconcile (#2738)', async () => {
    // The acceptance criterion for the delete hooks, end-to-end against a real
    // table: index an asset exactly as the completed-hook does (imageToRow /
    // videoToRow), then remove it by the key the DELETE path derives
    // (imageMediaKey / videoMediaKey). If those two derivations ever diverge the
    // DELETE misses and the count stays high — which is the bug #2738 fixed.
    const { imageToRow, videoToRow, imageMediaKey, videoMediaKey } = await import('./logic.js');
    const before = await db.countAssets();

    await db.upsertAsset(imageToRow({ filename: `${PFX}del.png`, createdAt: '2026-01-01T00:00:00.000Z' }));
    await db.upsertAsset(videoToRow({ id: `${PFX}delvid`, filename: `${PFX}delvid.mp4`, createdAt: '2026-01-02T00:00:00.000Z' }));
    expect(await db.countAssets()).toBe(before + 2);

    await db.removeAsset(imageMediaKey(`${PFX}del.png`));
    expect(await db.countAssets()).toBe(before + 1);
    // Keyed by job id, not filename — deleting by the filename must NOT be what works.
    await db.removeAsset(videoMediaKey(`${PFX}delvid`));
    expect(await db.countAssets()).toBe(before);
  });

  it('reconcile upserts on-disk assets and prunes stale rows (injected readers)', async () => {
    // Pre-seed a stale row that won't be in the injected "disk" set.
    await db.upsertAsset({ mediaKey: `image:${PFX}stale.png`, kind: 'image', ref: `${PFX}stale.png`, data: { filename: `${PFX}stale.png` }, createdAt: '2026-01-01T00:00:00.000Z' });

    const listGallery = async () => [
      { filename: `${PFX}live1.png`, prompt: 'one', createdAt: '2026-03-01T00:00:00.000Z' },
      { filename: `${PFX}live2.png`, prompt: 'two', createdAt: '2026-03-02T00:00:00.000Z' },
    ];
    const loadHistory = async () => [
      { id: `${PFX}vid1`, filename: `${PFX}vid1.mp4`, createdAt: '2026-03-03T00:00:00.000Z' },
    ];

    const res = await db.reconcileMediaAssets({ listGallery, loadHistory });
    expect(res.indexed).toBe(3);

    const imgs = await db.listAssets({ kind: 'image' });
    const refs = imgs.map((x) => x.filename);
    expect(refs).toContain(`${PFX}live1.png`);
    expect(refs).toContain(`${PFX}live2.png`);
    // The stale row whose backing file isn't in the disk set is pruned.
    expect(refs).not.toContain(`${PFX}stale.png`);

    const vids = await db.listAssets({ kind: 'video' });
    expect(vids.some((x) => x.id === `${PFX}vid1`)).toBe(true);
  });

  it('survives duplicate refs on disk (multi-row upsert must not self-conflict)', async () => {
    // Catches the multi-row upsert self-conflicting on a repeated media_key —
    // a Postgres-level constraint no unit test can pin. See the dedupe comment
    // in db.js for why disk can hand us the same ref twice.
    const listGallery = async () => [
      { filename: `${PFX}dup.png`, prompt: 'first', createdAt: '2026-04-01T00:00:00.000Z' },
      { filename: `${PFX}dup.png`, prompt: 'second', createdAt: '2026-04-02T00:00:00.000Z' },
    ];
    const loadHistory = async () => [
      { id: `${PFX}dupvid`, filename: `${PFX}dupvid.mp4`, createdAt: '2026-04-03T00:00:00.000Z' },
      { id: `${PFX}dupvid`, filename: `${PFX}dupvid.mp4`, createdAt: '2026-04-04T00:00:00.000Z' },
    ];

    const res = await db.reconcileMediaAssets({ listGallery, loadHistory });
    // `indexed` counts rows written, so the collapsed pair counts once each.
    expect(res.indexed).toBe(2);

    // Last occurrence wins — the same row a sequential upsert loop would leave.
    const imgs = await db.listAssets({ kind: 'image' });
    const dup = imgs.filter((x) => x.filename === `${PFX}dup.png`);
    expect(dup).toHaveLength(1);
    expect(dup[0].prompt).toBe('second');

    const vids = await db.listAssets({ kind: 'video' });
    expect(vids.filter((x) => x.id === `${PFX}dupvid`)).toHaveLength(1);
  });

  it('does NOT prune a kind whose disk read failed — skips, keeps live rows', async () => {
    // Seed an image row that a healthy reconcile would normally prune (its file
    // is not in the "disk" set), and a video row that the healthy video read
    // SHOULD prune.
    await db.upsertAsset({ mediaKey: `image:${PFX}keep.png`, kind: 'image', ref: `${PFX}keep.png`, data: { filename: `${PFX}keep.png` }, createdAt: '2026-01-01T00:00:00.000Z' });
    await db.upsertAsset({ mediaKey: `video:${PFX}vidstale`, kind: 'video', ref: `${PFX}vidstale`, data: { id: `${PFX}vidstale` }, createdAt: '2026-01-01T00:00:00.000Z' });

    // Image reader THROWS (simulated transient I/O fault); video reader is fine.
    const listGallery = async () => { throw new Error('EIO: simulated disk fault'); };
    const loadHistory = async () => []; // videos read fine, empty
    const res = await db.reconcileMediaAssets({ listGallery, loadHistory });
    expect(res.skippedPrune).toContain('images');
    expect(res.skippedPrune).not.toContain('videos');

    // The image row survives (its kind's read failed → prune skipped)...
    const imgs = await db.listAssets({ kind: 'image' });
    expect(imgs.some((x) => x.filename === `${PFX}keep.png`)).toBe(true);
    // ...while the video kind, which read cleanly-empty, IS pruned.
    const vids = await db.listAssets({ kind: 'video' });
    expect(vids.some((x) => x.id === `${PFX}vidstale`)).toBe(false);

    await db.removeAsset(`image:${PFX}keep.png`);
  });
});
