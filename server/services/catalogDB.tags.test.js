/**
 * Unit tests for the catalog tag-taxonomy DB helpers (`normalizeTags`,
 * `upsertTagFromPeer`). Postgres is mocked with an in-memory `catalog_tags`
 * map so the suite runs without a live database — we assert on the canonical
 * dedup behavior + first-write-wins casing + the peer parent-less retry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory tag store keyed by id. The mock interprets the three SQL shapes
// normalizeTags / upsertTagFromPeer issue: the batched multi-row INSERT …
// ON CONFLICT DO NOTHING RETURNING id, label, the batched SELECT id, label
// WHERE id = ANY(...), and the peer LWW upsert.
const tagStore = new Map();
let failParentFkOnce = false;

vi.mock('../lib/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (/INSERT INTO catalog_tags[\s\S]*ON CONFLICT \(id\) DO NOTHING/.test(sql)) {
      const rows = [];
      for (let i = 0; i < params.length; i += 2) {
        const [id, label] = [params[i], params[i + 1]];
        if (tagStore.has(id)) continue; // conflict → DO NOTHING
        tagStore.set(id, { id, label });
        rows.push({ id, label });
      }
      return { rows };
    }
    if (/^SELECT id, label FROM catalog_tags WHERE id = ANY/.test(sql.trim())) {
      const [ids] = params;
      return {
        rows: ids.filter((id) => tagStore.has(id)).map((id) => ({ id, label: tagStore.get(id).label })),
      };
    }
    if (/INSERT INTO catalog_tags[\s\S]*ON CONFLICT \(id\) DO UPDATE/.test(sql)) {
      const [id, label, description, color, parentId] = params;
      if (failParentFkOnce && parentId) {
        failParentFkOnce = false;
        const err = new Error('insert or update violates foreign key constraint');
        err.code = '23503';
        throw err;
      }
      const isInsert = !tagStore.has(id);
      tagStore.set(id, { id, label, description, color, parentId });
      return { rows: [{ is_insert: isInsert }] };
    }
    return { rows: [] };
  }),
  withTransaction: vi.fn(),
  pgvectorToArray: vi.fn(() => null),
  arrayToPgvector: vi.fn((a) => a),
}));

vi.mock('./instances.js', () => ({ getInstanceId: vi.fn(async () => 'inst-test') }));

import { query } from '../lib/db.js';
import { normalizeTags, upsertTagFromPeer } from './catalogDB.js';

beforeEach(() => {
  tagStore.clear();
  failParentFkOnce = false;
  vi.clearAllMocks();
});

describe('normalizeTags', () => {
  it('returns [] for empty / non-array input', async () => {
    expect(await normalizeTags([])).toEqual([]);
    expect(await normalizeTags(undefined)).toEqual([]);
    expect(await normalizeTags(null)).toEqual([]);
  });

  it('dedups casing/whitespace variants within one call (first wins)', async () => {
    const out = await normalizeTags(['Noir', 'noir', '  NOIR ']);
    expect(out).toEqual(['Noir']);
    // One canonical row created.
    expect(tagStore.has('cat-tag-noir')).toBe(true);
    expect(tagStore.get('cat-tag-noir').label).toBe('Noir');
  });

  it('reuses the existing canonical label across calls (stored casing wins)', async () => {
    await normalizeTags(['Noir']);
    const out = await normalizeTags(['NOIR', 'pulp']);
    // The pre-existing `Noir` row's casing is returned, not the new `NOIR`.
    expect(out).toEqual(['Noir', 'pulp']);
  });

  it('drops blank tags and collapses internal whitespace in the stored label', async () => {
    const out = await normalizeTags(['', '   ', 'Film   Noir']);
    expect(out).toEqual(['Film Noir']);
    expect(tagStore.has('cat-tag-film noir')).toBe(true);
  });

  it('preserves order of first appearance', async () => {
    const out = await normalizeTags(['beta', 'alpha', 'beta', 'gamma']);
    expect(out).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('issues at most two queries regardless of tag count (no per-label N+1)', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag-${i}`);
    const out = await normalizeTags(many);
    expect(out).toEqual(many);
    // 1 batched SELECT + 1 batched INSERT.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('skips the insert entirely when every tag already exists', async () => {
    await normalizeTags(['Noir', 'Pulp']);
    vi.clearAllMocks();
    const out = await normalizeTags(['noir', 'PULP']);
    expect(out).toEqual(['Noir', 'Pulp']);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('runs the batch on the caller transaction client when one is passed', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    const out = await normalizeTags(['Noir', 'Pulp'], { client });
    expect(out).toEqual(['Noir', 'Pulp']);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('upsertTagFromPeer', () => {
  it('inserts a new tag and reports isInsert', async () => {
    const res = await upsertTagFromPeer({ id: 'cat-tag-noir', label: 'Noir', createdAt: 't', updatedAt: 't' });
    expect(res).toEqual({ applied: true, isInsert: true });
    expect(tagStore.get('cat-tag-noir').label).toBe('Noir');
  });

  it('retries parent-less on an FK violation so the child row still lands', async () => {
    failParentFkOnce = true; // first attempt (with parent) throws 23503
    const res = await upsertTagFromPeer({
      id: 'cat-tag-child', label: 'Child', parentId: 'cat-tag-missing',
      createdAt: 't', updatedAt: 't',
    });
    expect(res.applied).toBe(true);
    // Row landed with a null parent (the parent can re-link on a later page).
    expect(tagStore.get('cat-tag-child').parentId).toBeNull();
  });
});
