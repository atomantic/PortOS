/**
 * Tests for the boot-time friendly-universe-tag repair.
 *
 * catalogDB + universeBuilder + the marker file are mocked, so this exercises
 * the walk/rewrite orchestration (the pure transform is unit-tested in
 * server/lib/catalogUniverseTags.test.js):
 *   - rewrites rows carrying legacy machine tags to the friendly name;
 *   - leaves clean rows untouched (no PATCH);
 *   - paginates through more than one page;
 *   - marker high-water skip on an already-repaired install.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsState = { marker: null, written: null };
const dbState = { ingredients: [], updates: [] };

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => (fsState.marker == null
    ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    : JSON.stringify(fsState.marker))),
  writeFile: vi.fn(async (_p, data) => { fsState.written = JSON.parse(data); }),
}));

vi.mock('../lib/fileUtils.js', () => ({ PATHS: { data: '/tmp/portos-data' } }));

vi.mock('../services/universeBuilder.js', () => ({
  listUniverses: vi.fn(async () => [
    { id: 'u-1', name: 'My Cool Universe' },
    { id: 'u-2', name: 'Neon City' },
  ]),
}));

vi.mock('../services/catalogDB.js', () => ({
  // Mirror the REAL contract: listIngredients returns `{ items, nextOffset }`,
  // not a bare array. (A bare-array mock is what let the original no-op bug pass.)
  listIngredients: vi.fn(async ({ limit, offset }) => {
    const items = dbState.ingredients.slice(offset, offset + limit);
    return { items, nextOffset: offset + items.length };
  }),
  updateIngredient: vi.fn(async (id, patch, ctx) => {
    dbState.updates.push({ id, patch, ctx });
    const row = dbState.ingredients.find((r) => r.id === id);
    if (row) row.tags = patch.tags;
    return row;
  }),
}));

const { repairUniverseTags } = await import('./repairUniverseTags.js');

beforeEach(() => {
  fsState.marker = null;
  fsState.written = null;
  dbState.ingredients = [];
  dbState.updates = [];
});

describe('repairUniverseTags', () => {
  it('rewrites machine tags to the friendly universe name and leaves clean rows alone', async () => {
    dbState.ingredients = [
      { id: 'cat-chr-1', tags: ['mentor', 'from-universe', 'universe:u-1'] },
      { id: 'cat-plc-2', tags: ['from-universe', 'universe:u-2', 'noir'] },
      { id: 'cat-idea-3', tags: ['standalone-idea'] }, // no legacy tags
    ];

    const result = await repairUniverseTags();

    expect(result.skipped).toBe(false);
    expect(result.stats.scanned).toBe(3);
    expect(result.stats.rewritten).toBe(2);
    expect(dbState.updates).toHaveLength(2);

    const byId = Object.fromEntries(dbState.updates.map((u) => [u.id, u.patch.tags]));
    expect(byId['cat-chr-1']).toEqual(['mentor', 'My Cool Universe']);
    expect(byId['cat-plc-2']).toEqual(['noir', 'Neon City']);
    // The clean idea row was never PATCHed.
    expect(dbState.updates.some((u) => u.id === 'cat-idea-3')).toBe(false);
    // Repair edits are tagged as a system 'sync' source, not a user edit.
    expect(dbState.updates[0].ctx.source).toBe('sync');
    // Marker written for idempotent skip next boot.
    expect(fsState.written.version).toBe(2);
  });

  it('skips entirely when the marker is already at the current version', async () => {
    fsState.marker = { version: 2, completedAt: '2026-01-01T00:00:00Z' };
    dbState.ingredients = [{ id: 'cat-chr-1', tags: ['from-universe', 'universe:u-1'] }];

    const result = await repairUniverseTags();

    expect(result.skipped).toBe(true);
    expect(dbState.updates).toHaveLength(0);
  });

  it('re-runs when the marker is at the older (broken-no-op) version', async () => {
    // v1 shipped a no-op pass; an install that recorded the v1 marker must
    // re-run the fixed repair, not skip forever.
    fsState.marker = { version: 1, completedAt: '2026-01-01T00:00:00Z' };
    dbState.ingredients = [{ id: 'cat-chr-1', tags: ['from-universe', 'universe:u-1', 'mentor'] }];

    const result = await repairUniverseTags();

    expect(result.skipped).toBe(false);
    expect(result.stats.rewritten).toBe(1);
    expect(dbState.ingredients[0].tags).toEqual(['mentor', 'My Cool Universe']);
    expect(fsState.written.version).toBe(2);
  });

  it('withholds the completion marker when a row has an unresolved universe tag (retries next boot)', async () => {
    // u-999 isn't in the universe name map — its universe hasn't arrived locally
    // yet. The legacy tag is preserved, the row counts as unresolved, and the
    // marker is NOT written so a future boot retries once the universe lands.
    dbState.ingredients = [{ id: 'cat-chr-1', tags: ['from-universe', 'universe:u-999', 'mentor'] }];

    const result = await repairUniverseTags();

    expect(result.skipped).toBe(false);
    expect(result.stats.unresolved).toBe(1);
    expect(result.markerWritten).toBe(false);
    expect(fsState.written).toBeNull();
    // Legacy tag preserved untouched for the retry.
    expect(dbState.ingredients[0].tags).toEqual(['from-universe', 'universe:u-999', 'mentor']);
  });

  it('re-runs the walk when forced even with a marker present', async () => {
    fsState.marker = { version: 1 };
    dbState.ingredients = [{ id: 'cat-chr-1', tags: ['from-universe', 'universe:u-1'] }];

    const result = await repairUniverseTags({ force: true });

    expect(result.skipped).toBe(false);
    expect(dbState.updates).toHaveLength(1);
  });

  it('paginates through more than one page', async () => {
    // 250 rows, each carrying a legacy tag — page size is 200, so two pages.
    dbState.ingredients = Array.from({ length: 250 }, (_, i) => ({
      id: `cat-chr-${i}`,
      tags: ['from-universe', 'universe:u-1'],
    }));

    const result = await repairUniverseTags();

    expect(result.stats.scanned).toBe(250);
    expect(result.stats.rewritten).toBe(250);
  });
});
