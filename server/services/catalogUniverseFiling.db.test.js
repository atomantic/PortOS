import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toPgJson } from '../lib/pgJson.js';

const { checkHealth, ensureSchema, close, query } = await import('../lib/db.js');
const { requireDbOrSkip } = await import('../lib/dbTestGate.js');
const { attachMedia } = await import('./catalogDB/media.js');
const filing = await import('./catalogUniverseFiling.js');
const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('services/catalogUniverseFiling.db.test', health.connected, health.error);
if (ready) await ensureSchema();

const key = `uvf-${randomUUID().slice(0, 8)}`;
const ids = {
  world: `${key}-world`, other: `${key}-other`,
  owned: `cat-chr-${key}-owned`, cast: `cat-chr-${key}-cast`, set: `cat-plc-${key}-set`, loose: `cat-obj-${key}-loose`,
  video: `mv-${key}`, board: `sb-${key}`,
};
const records = [ids.owned, ids.cast, ids.set, ids.loose];
const img = (name) => `${key}-${name}.png`;

// In-memory stand-in for the universe collections (data/media-collections is
// covered by mediaCollections.test.js); the placement SQL runs for real.
let collections;
const missingFiles = new Set();
const collectionDeps = {
  isGalleryImage: (mediaKey) => !missingFiles.has(mediaKey),
  findCollectionByUniverseId: async (universeId) => collections.get(universeId) || null,
  findOrCreateUniverseCollection: async ({ universeId, universeName }) => {
    if (!collections.has(universeId)) collections.set(universeId, { id: `uc-${universeId}`, name: `Universe: ${universeName}`, items: [], removedItems: {} });
    return collections.get(universeId);
  },
  bulkUpdateCollectionItems: async (id, { add }) => {
    const collection = [...collections.values()].find((c) => c.id === id);
    const fresh = add.filter(({ ref }) => !collection.items.some((item) => item.ref === ref));
    collection.items.push(...fresh);
    return { collection, added: fresh.length, removed: 0 };
  },
};
const refsIn = (universeId) => (collections.get(universeId)?.items || []).map((item) => item.ref).sort();
const ours = (report) => report.universes.filter((u) => u.universeId.startsWith(key));

beforeAll(async () => {
  if (!ready) return;
  filing.__setUniverseFilingDepsForTests(collectionDeps);
  await query('INSERT INTO universes (id, name) VALUES ($1, $2), ($3, $4)', [ids.world, 'Example World', ids.other, 'Other World']);
  await query(`INSERT INTO catalog_ingredients (id, type, name, payload) VALUES
    ($1, 'character', 'Example Owned', '{}'::jsonb), ($2, 'character', 'Example Cast', '{}'::jsonb),
    ($3, 'place', 'Example Set', '{}'::jsonb), ($4, 'object', 'Example Loose', '{}'::jsonb)`, records);
  await query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role) VALUES
    ($1, 'universe', $3, 'owner'), ($2, 'music-video', $4, 'cast')`, [ids.owned, ids.cast, ids.world, ids.video]);
  await query('INSERT INTO music_video_projects (id, data) VALUES ($1, $2::jsonb)', [ids.video, toPgJson({ name: 'Example Video', concept: { universeId: ids.world } })]);
  const board = { id: ids.board, name: 'Example Board', beats: [{ id: 'b1', panels: [{ id: 'p1', castIds: [], environmentIds: [ids.set], objectIds: [] }] }] };
  await query('INSERT INTO storyboards (id, name, universe_id, data) VALUES ($1, $2, $3, $4::jsonb)', [ids.board, board.name, ids.other, toPgJson(board)]);
  await query(`INSERT INTO catalog_ingredient_media (ingredient_id, media_key, kind, role, deleted) VALUES
    ($1, $5, 'portrait', NULL, false), ($1, $6, 'reference', NULL, false), ($1, $7, 'reference', 'archive:old', false),
    ($1, $8, 'reference', NULL, true), ($2, $9, 'reference', 'sheet:front', false), ($3, $10, 'reference', NULL, false),
    ($4, $11, 'reference', NULL, false), ($1, $12, 'audio', NULL, false)`,
  [...records, img('owned-portrait'), img('owned-remix'), img('owned-archived'), img('owned-detached'),
    img('cast-sheet'), img('set-plate'), img('loose'), `${key}-memo.wav`]);
});

beforeEach(() => {
  collections = new Map();
  missingFiles.clear();
});

afterAll(async () => {
  if (!ready) return;
  filing.__testing.reset();
  await query('DELETE FROM catalog_ingredient_media WHERE ingredient_id = ANY($1)', [records]);
  await query('DELETE FROM catalog_ingredient_refs WHERE ingredient_id = ANY($1)', [records]);
  await query('DELETE FROM catalog_ingredients WHERE id = ANY($1)', [records]);
  await query('DELETE FROM music_video_projects WHERE id = $1', [ids.video]);
  await query('DELETE FROM storyboards WHERE id = $1', [ids.board]);
  await query('DELETE FROM universes WHERE id = ANY($1)', [[ids.world, ids.other]]);
  await close();
});

describe.skipIf(!ready)('catalog universe filing', () => {
  it('files images of records owned by a universe or cast in its stories, and nothing else', async () => {
    const report = await filing.fileCatalogImagesIntoUniverses();
    expect(refsIn(ids.world)).toEqual([img('cast-sheet'), img('owned-portrait'), img('owned-remix')]);
    expect(refsIn(ids.other)).toEqual([img('set-plate')]);
    expect(ours(report).map((u) => [u.universeId, u.added]).sort()).toEqual([[ids.other, 1], [ids.world, 3]]);
  });

  it('reports without writing on a dry run, and skips filed, user-removed and missing images', async () => {
    collections.set(ids.world, { id: 'uc-world', items: [{ kind: 'image', ref: img('owned-portrait') }],
      removedItems: { [`image:${img('owned-remix')}`]: '2026-01-01T00:00:00.000Z' } });
    missingFiles.add(img('cast-sheet'));
    const report = await filing.fileCatalogImagesIntoUniverses({ dryRun: true });
    const world = ours(report).find((u) => u.universeId === ids.world);
    expect(world).toMatchObject({ alreadyFiled: 1, toAdd: [], userRemoved: [img('owned-remix')], missingFile: [img('cast-sheet')], added: 0 });
    const other = ours(report).find((u) => u.universeId === ids.other);
    expect(other).toMatchObject({ collectionId: null, toAdd: [{ mediaKey: img('set-plate'), records: ['Example Set'] }], added: 0 });
    expect(collections.has(ids.other)).toBe(false);
  });

  it('files a newly attached reference into the universe after the attach announces it', async () => {
    filing.__testing.reset();
    filing.initCatalogUniverseFiling();
    await attachMedia(ids.cast, img('cast-new'), 'reference');
    await filing.__testing.flushNow();
    // Only the changed record files; the owned record's images wait for the pass.
    expect(refsIn(ids.world)).toEqual([img('cast-new'), img('cast-sheet')]);
    expect(collections.has(ids.other)).toBe(false);
  });
});
