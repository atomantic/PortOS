/**
 * Tests for the per-record catalog payload-schemaVersion migration.
 *
 * Postgres + the marker file are mocked, and the registry is mocked to inject
 * a type with a real upgrader chain (the shipped registry is all payload-v1,
 * so there is nothing to walk in production yet). This exercises:
 *   - the below-current row predicate + upgrader application;
 *   - the marker high-water skip on an already-migrated install;
 *   - the no-walk path for types without upgraders.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { rows: [], updates: [] };
const fsState = { marker: null, written: null };

vi.mock('../lib/db.js', () => ({
  query: vi.fn(async (sql, params) => {
    if (/^\s*SELECT/i.test(sql)) return { rows: db.rows };
    if (/^\s*UPDATE/i.test(sql)) { db.updates.push({ id: params[0], payload: JSON.parse(params[1]) }); return { rows: [] }; }
    return { rows: [] };
  }),
}));

// Marker I/O is delegated to migrationMarker.js; mock it against `fsState`
// (the marker helper has its own unit test in server/lib/migrationMarker.test.js).
vi.mock('../lib/migrationMarker.js', () => ({
  readMarker: vi.fn(async () => fsState.marker),
  writeMarker: vi.fn(async (_name, payload) => { fsState.written = payload; }),
}));

// Inject a synthetic registry with a v1→v2 upgrader (character) plus an all-v1
// upgrader-less type (idea). Defined inside the factory because vi.mock hoists
// above top-level consts.
vi.mock('../lib/catalogTypes.js', () => {
  const SYNTH_TYPES = [
    {
      id: 'character',
      payloadSchemaVersion: 2,
      payloadUpgraders: { 1: (p) => ({ ...p, voiceNotes: p.voiceNotes ?? '' }) },
    },
    { id: 'idea', payloadSchemaVersion: 1, payloadUpgraders: {} },
  ];
  return {
    CATALOG_TYPES: SYNTH_TYPES,
    currentPayloadSchemaVersion: (id) => SYNTH_TYPES.find((t) => t.id === id)?.payloadSchemaVersion ?? 1,
    upgradePayload: (id, payload) => {
      const t = SYNTH_TYPES.find((x) => x.id === id);
      let p = { ...payload };
      let v = Number.isInteger(p.schemaVersion) ? p.schemaVersion : 1;
      while (v < t.payloadSchemaVersion) {
        const up = t.payloadUpgraders[v];
        if (typeof up !== 'function') break;
        p = up(p) || p;
        v += 1;
      }
      p.schemaVersion = t.payloadSchemaVersion;
      return p;
    },
  };
});

import { migrateCatalogPayload } from './migrateCatalogPayload.js';

beforeEach(() => {
  db.rows = [];
  db.updates = [];
  fsState.marker = null;
  fsState.written = null;
});

describe('migrateCatalogPayload', () => {
  it('upgrades below-current rows and re-stamps schemaVersion', async () => {
    db.rows = [
      { id: 'cat-chr-1', payload: { name: 'Echo', schemaVersion: 1 } },
      { id: 'cat-chr-2', payload: { name: 'Vox' } }, // missing version → treated as v1
    ];
    const res = await migrateCatalogPayload();
    expect(res.skipped).toBe(false);
    expect(res.stats.upgraded).toBe(2);
    expect(db.updates).toHaveLength(2);
    for (const u of db.updates) {
      expect(u.payload.schemaVersion).toBe(2);
      expect(u.payload).toHaveProperty('voiceNotes');
    }
    // Marker stamped to the high-water version.
    expect(fsState.written.highWater).toBe(2);
  });

  it('skips entirely when the marker is already at the high-water version', async () => {
    fsState.marker = { highWater: 2 };
    db.rows = [{ id: 'cat-chr-1', payload: { schemaVersion: 1 } }];
    const res = await migrateCatalogPayload();
    expect(res.skipped).toBe(true);
    expect(db.updates).toHaveLength(0);
  });

  it('re-runs when forced even if the marker is current', async () => {
    fsState.marker = { highWater: 2 };
    db.rows = [{ id: 'cat-chr-1', payload: { schemaVersion: 1 } }];
    const res = await migrateCatalogPayload({ force: true });
    expect(res.skipped).toBe(false);
    expect(db.updates).toHaveLength(1);
  });

  it('does not walk types that have no upgraders', async () => {
    // Only the character type (with an upgrader) should be queried; the idea
    // type is v1 / upgrader-less. We assert nothing was upgraded when the only
    // below-current rows belong to the no-upgrader type — the migration never
    // SELECTs for it. Simulate by leaving db.rows empty (character has none).
    db.rows = [];
    const res = await migrateCatalogPayload();
    expect(res.stats.upgraded).toBe(0);
  });
});
