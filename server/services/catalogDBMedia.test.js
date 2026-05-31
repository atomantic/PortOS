/**
 * Unit tests for the catalog DB layer's media-attachment functions:
 *   - attachMedia upserts a typed (ingredient_id, media_key, kind) row and
 *     revives a soft-deleted row on conflict;
 *   - detachMedia soft-deletes (tombstone) rather than hard-DELETE;
 *   - setPortraitMedia demotes any other live portrait, then attaches;
 *   - getMissingMediaForIngredient reports only keys that don't resolve against
 *     the local media library (the metadata-missing integrity surface);
 *   - upsertMediaFromPeer distinguishes "tombstone fields present" from absent.
 *
 * Postgres is mocked — we capture the SQL/params and assert on them, so the
 * suite runs without a live database. `resolveImageInputPath` is mocked so the
 * integrity helper's library-resolution branch is deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];

vi.mock('../lib/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    // Echo a media row back so rowToMedia works for the RETURNING * paths.
    return {
      rows: [{
        ingredient_id: params?.[0] ?? 'i1',
        media_key: params?.[1] ?? 'k.png',
        kind: params?.[2] ?? 'portrait',
        role: null,
        caption: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        deleted: false,
        deleted_at: null,
        sync_sequence: 1,
      }],
    };
  }),
  withTransaction: vi.fn(),
  pgvectorToArray: vi.fn(),
  arrayToPgvector: vi.fn(),
}));

// resolveImageInputPath: 'present.png' resolves; everything else is missing.
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveImageInputPath: vi.fn((key) => (key === 'present.png' ? `/data/images/${key}` : null)),
  };
});

// instances.getInstanceId is pulled in transitively by catalogDB — stub it.
vi.mock('./instances.js', () => ({ getInstanceId: vi.fn(async () => 'inst-1') }));

const catalogDB = await import('./catalogDB.js');

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe('attachMedia', () => {
  it('upserts the tuple and revives a soft-deleted row on conflict', async () => {
    await catalogDB.attachMedia('i1', 'hero.png', 'portrait', { role: 'hero', caption: 'cap' });
    const { sql, params } = calls[0];
    expect(sql).toMatch(/INSERT INTO catalog_ingredient_media/i);
    expect(sql).toMatch(/ON CONFLICT \(ingredient_id, media_key, kind\) DO UPDATE/i);
    expect(sql).toMatch(/deleted = false, deleted_at = NULL/i);
    expect(params).toEqual(['i1', 'hero.png', 'portrait', 'hero', 'cap']);
  });

  it('defaults role/caption to null when omitted', async () => {
    await catalogDB.attachMedia('i1', 'hero.png', 'reference');
    expect(calls[0].params).toEqual(['i1', 'hero.png', 'reference', null, null]);
  });
});

describe('detachMedia', () => {
  it('soft-deletes (tombstone) — never a hard DELETE', async () => {
    await catalogDB.detachMedia('i1', 'hero.png', 'portrait');
    const { sql, params } = calls[0];
    expect(sql).toMatch(/UPDATE catalog_ingredient_media SET deleted = true/i);
    expect(sql).not.toMatch(/DELETE FROM/i);
    expect(sql).toMatch(/AND deleted = false/i); // re-detach stays a no-op
    expect(params).toEqual(['i1', 'hero.png', 'portrait']);
  });
});

describe('setPortraitMedia', () => {
  it('demotes other live portraits then attaches the new one', async () => {
    await catalogDB.setPortraitMedia('i1', 'new.png', { caption: 'now' });
    // First statement: demote other portraits.
    expect(calls[0].sql).toMatch(/UPDATE catalog_ingredient_media SET deleted = true/i);
    expect(calls[0].sql).toMatch(/kind = 'portrait'/i);
    expect(calls[0].sql).toMatch(/media_key <> \$2/);
    expect(calls[0].params).toEqual(['i1', 'new.png']);
    // Second statement: attach as portrait.
    expect(calls[1].sql).toMatch(/INSERT INTO catalog_ingredient_media/i);
    expect(calls[1].params).toEqual(['i1', 'new.png', 'portrait', null, 'now']);
  });
});

describe('getMissingMediaForIngredient', () => {
  it('returns only the IMAGE keys that do not resolve against the local library', async () => {
    // listMediaForIngredient runs the SELECT; override the mock to return a mix.
    const db = await import('../lib/db.js');
    db.query.mockResolvedValueOnce({
      rows: [
        { ingredient_id: 'i1', media_key: 'present.png', kind: 'portrait', role: null, caption: null, created_at: new Date(), deleted: false, deleted_at: null, sync_sequence: 1 },
        { ingredient_id: 'i1', media_key: 'gone.png', kind: 'reference', role: null, caption: null, created_at: new Date(), deleted: false, deleted_at: null, sync_sequence: 2 },
        // A non-image kind never has a library resolver yet — it must NOT be
        // reported missing just because resolveImageInputPath returns null.
        { ingredient_id: 'i1', media_key: 'memo.wav', kind: 'audio', role: null, caption: null, created_at: new Date(), deleted: false, deleted_at: null, sync_sequence: 3 },
      ],
    });
    const missing = await catalogDB.getMissingMediaForIngredient('i1');
    expect(missing).toEqual([{ mediaKey: 'gone.png', kind: 'reference' }]);
  });
});

describe('upsertMediaFromPeer', () => {
  it('uses the tombstone-aware INSERT when deleted/deletedAt are present', async () => {
    await catalogDB.upsertMediaFromPeer({
      ingredientId: 'i1', mediaKey: 'a.png', kind: 'portrait',
      role: 'r', caption: 'c', createdAt: 't', deleted: true, deletedAt: 't2',
    });
    const { sql, params } = calls[0];
    expect(sql).toMatch(/deleted, deleted_at/i);
    expect(sql).toMatch(/SET role = EXCLUDED.role, caption = EXCLUDED.caption, deleted = EXCLUDED.deleted/i);
    expect(params).toEqual(['i1', 'a.png', 'portrait', 'r', 'c', 't', true, 't2']);
  });

  it('uses the tombstone-less INSERT (preserve local state) when the keys are absent', async () => {
    await catalogDB.upsertMediaFromPeer({
      ingredientId: 'i1', mediaKey: 'a.png', kind: 'portrait', createdAt: 't',
    });
    const { sql, params } = calls[0];
    expect(sql).not.toMatch(/deleted = EXCLUDED.deleted/i);
    expect(sql).toMatch(/SET role = EXCLUDED.role, caption = EXCLUDED.caption/i);
    expect(params).toEqual(['i1', 'a.png', 'portrait', null, null, 't']);
  });
});

describe('getMaxSequences includes the media cursor', () => {
  it('selects MAX(sync_sequence) from catalog_ingredient_media AS media', async () => {
    const db = await import('../lib/db.js');
    db.query.mockResolvedValueOnce({ rows: [{ media: '0' }] });
    await catalogDB.getMaxSequences();
    const sql = db.query.mock.calls.at(-1)[0].replace(/\s+/g, ' ');
    expect(sql).toMatch(/catalog_ingredient_media\), 0\)::text AS media/i);
  });
});
