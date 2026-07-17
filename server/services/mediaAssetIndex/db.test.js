/**
 * Postgres-backed round-trip for the media asset index.
 *
 * Like projectsDB.test.js, this needs a live PostgreSQL with the schema applied.
 * If no DB is reachable (CI, fresh checkout), it SKIPS cleanly rather than
 * failing red. When a DB IS reachable it exercises upsert/list/remove and the
 * full reconcile (upsert-everything + prune-stale), using INJECTED disk readers
 * so it never touches the real media-gen stack, and cleaning its rows up after.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../../lib/db.js';

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

if (!dbReady) console.log(`⏭️  mediaAssetIndex/db.test.js skipped: ${skipReason}`);

// Test rows use a recognizable prefix so cleanup can target them without
// touching any real indexed assets that happen to share the dev DB.
const PFX = 'test-mai-';

describe.skipIf(!dbReady)('media asset index DB round-trip', () => {
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

  it('upsert refreshes data + created_at on conflict', async () => {
    const key = `image:${PFX}b.png`;
    await db.upsertAsset({ mediaKey: key, kind: 'image', ref: `${PFX}b.png`, data: { filename: `${PFX}b.png`, v: 1 }, createdAt: '2026-01-01T00:00:00.000Z' });
    await db.upsertAsset({ mediaKey: key, kind: 'image', ref: `${PFX}b.png`, data: { filename: `${PFX}b.png`, v: 2 }, createdAt: '2026-02-02T00:00:00.000Z' });
    const imgs = await db.listAssets({ kind: 'image' });
    const found = imgs.find((x) => x.filename === `${PFX}b.png`);
    expect(found.v).toBe(2);
    await db.removeAsset(key);
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
