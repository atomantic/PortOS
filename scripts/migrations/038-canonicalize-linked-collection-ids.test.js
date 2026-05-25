import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { canonicalizeCollections, rewriteSubscriptions } from './038-canonicalize-linked-collection-ids.js';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

describe('canonicalizeCollections', () => {
  it('rewrites a universe-linked collection id to uc-<universeId>', () => {
    const { collections, idMap, renamed, merged } = canonicalizeCollections([
      { id: 'rand-1', name: 'Universe: A', universeId: 'u1', items: [], updatedAt: '2026-05-01T00:00:00Z' },
    ]);
    expect(collections[0].id).toBe('uc-u1');
    expect(idMap).toEqual({ 'rand-1': 'uc-u1' });
    expect(renamed).toBe(1);
    expect(merged).toBe(0);
  });

  it('rewrites a series-linked collection id to sc-<seriesId>', () => {
    const { collections } = canonicalizeCollections([
      { id: 'rand-2', name: 'Series: B', seriesId: 's1', items: [], updatedAt: '2026-05-01T00:00:00Z' },
    ]);
    expect(collections[0].id).toBe('sc-s1');
  });

  it('merges two collections for the same universe (the duplicate cleanup) — union items, newer scalars win', () => {
    const { collections, merged, renamed } = canonicalizeCollections([
      { id: 'local', name: 'Universe: A (old)', universeId: 'u1', updatedAt: '2026-05-01T00:00:00Z',
        createdAt: '2026-04-01T00:00:00Z',
        items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-04-01T00:00:00Z' }] },
      { id: 'from-peer', name: 'Universe: A (new)', universeId: 'u1', updatedAt: '2026-05-10T00:00:00Z',
        createdAt: '2026-04-15T00:00:00Z',
        items: [{ kind: 'image', ref: 'b.png', addedAt: '2026-04-15T00:00:00Z' }] },
    ]);
    expect(collections).toHaveLength(1);
    const c = collections[0];
    expect(c.id).toBe('uc-u1');
    expect(c.name).toBe('Universe: A (new)'); // newer updatedAt wins scalars
    expect(c.createdAt).toBe('2026-04-01T00:00:00Z'); // earliest createdAt
    expect(c.items.map((i) => i.ref).sort()).toEqual(['a.png', 'b.png']); // union
    expect(merged).toBe(1);
    expect(renamed).toBe(2);
  });

  it('merge: a corrupted addedAt loses "earliest wins" (valid timestamp is preserved)', () => {
    const { collections } = canonicalizeCollections([
      { id: 'a', name: 'U', universeId: 'u1', updatedAt: '2026-05-01T00:00:00Z',
        items: [{ kind: 'image', ref: 'x.png', addedAt: 'not-a-date' }] },
      { id: 'b', name: 'U', universeId: 'u1', updatedAt: '2026-05-02T00:00:00Z',
        items: [{ kind: 'image', ref: 'x.png', addedAt: '2026-04-01T00:00:00Z' }] },
    ]);
    const item = collections[0].items.find((i) => i.ref === 'x.png');
    expect(item.addedAt).toBe('2026-04-01T00:00:00Z'); // valid beats unparseable, not -Infinity
  });

  it('merge: unioned items are sorted by itemKey (deterministic, matches runtime → no checksum churn)', () => {
    const { collections } = canonicalizeCollections([
      { id: 'a', name: 'U', universeId: 'u1', updatedAt: '2026-05-01T00:00:00Z',
        items: [{ kind: 'video', ref: 'z.mp4' }, { kind: 'image', ref: 'm.png' }] },
      { id: 'b', name: 'U', universeId: 'u1', updatedAt: '2026-05-02T00:00:00Z',
        items: [{ kind: 'image', ref: 'a.png' }] },
    ]);
    const keys = collections[0].items.map((i) => `${i.kind}:${i.ref}`);
    expect(keys).toEqual([...keys].sort((x, y) => x.localeCompare(y)));
    expect(keys).toEqual(['image:a.png', 'image:m.png', 'video:z.mp4']);
  });

  it('leaves standalone (unlinked) collections untouched', () => {
    const { collections, renamed } = canonicalizeCollections([
      { id: 'standalone-uuid', name: 'My Bucket', universeId: null, seriesId: null, items: [] },
    ]);
    expect(collections[0].id).toBe('standalone-uuid');
    expect(renamed).toBe(0);
  });

  it('leaves tombstones untouched (deleted records have no owner link)', () => {
    const { collections, renamed } = canonicalizeCollections([
      { id: 'gone-uuid', name: 'Universe: Dead', universeId: null, seriesId: null, deleted: true, items: [] },
    ]);
    expect(collections[0].id).toBe('gone-uuid');
    expect(renamed).toBe(0);
  });

  it('is idempotent — already-canonical ids are not renamed', () => {
    const { renamed } = canonicalizeCollections([
      { id: 'uc-u1', name: 'Universe: A', universeId: 'u1', items: [] },
      { id: 'sc-s1', name: 'Series: B', seriesId: 's1', items: [] },
    ]);
    expect(renamed).toBe(0);
  });

  it('slices an overlong owner id to the runtime cap for both the id and the stored field', () => {
    const longId = 'u'.repeat(120); // > UNIVERSE_ID_MAX (80)
    const sliced = longId.slice(0, 80);
    const { collections } = canonicalizeCollections([
      { id: 'rand-long', name: 'Universe: Long', universeId: longId, items: [], updatedAt: '2026-05-01T00:00:00Z' },
    ]);
    // Matches what findOrCreateUniverseCollection would compute (it slices first).
    expect(collections[0].id).toBe(`uc-${sliced}`);
    expect(collections[0].universeId).toBe(sliced);
  });
});

describe('rewriteSubscriptions', () => {
  it('rewrites recordId + regenerates the derived id for mediaCollection subs', () => {
    const out = rewriteSubscriptions(
      [{ id: 'peer-mediaCollection-rand-1-peerA', peerId: 'peerA', recordKind: 'mediaCollection', recordId: 'rand-1' }],
      { 'rand-1': 'uc-u1' },
    );
    expect(out).toEqual([
      { id: 'peer-mediaCollection-uc-u1-peerA', peerId: 'peerA', recordKind: 'mediaCollection', recordId: 'uc-u1' },
    ]);
  });

  it('leaves non-mediaCollection subs and unmapped ids untouched', () => {
    const subs = [
      { id: 'peer-universe-u1-peerA', peerId: 'peerA', recordKind: 'universe', recordId: 'u1' },
      { id: 'peer-mediaCollection-keepme-peerA', peerId: 'peerA', recordKind: 'mediaCollection', recordId: 'keepme' },
    ];
    expect(rewriteSubscriptions(subs, { 'rand-1': 'uc-u1' })).toEqual(subs);
  });

  it('de-dupes subs that collide after rewrite (keeps most-recently-pushed)', () => {
    const out = rewriteSubscriptions(
      [
        { id: 'peer-mediaCollection-rand-1-peerA', peerId: 'peerA', recordKind: 'mediaCollection', recordId: 'rand-1', lastPushedAt: '2026-05-01T00:00:00Z' },
        { id: 'peer-mediaCollection-uc-u1-peerA', peerId: 'peerA', recordKind: 'mediaCollection', recordId: 'uc-u1', lastPushedAt: '2026-05-09T00:00:00Z' },
      ],
      { 'rand-1': 'uc-u1' },
    );
    expect(out).toHaveLength(1);
    expect(out[0].lastPushedAt).toBe('2026-05-09T00:00:00Z');
  });
});

describe('migration 038 — up()', () => {
  let rootDir;
  let dataDir;
  let collectionsPath;
  let subsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-038-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(join(dataDir, 'sharing'), { recursive: true });
    collectionsPath = join(dataDir, 'media-collections.json');
    subsPath = join(dataDir, 'sharing', 'peer_subscriptions.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('canonicalizes ids on disk and rewrites subscriptions, idempotently', async () => {
    writeJson(collectionsPath, { collections: [
      { id: 'rand-1', name: 'Universe: A', universeId: 'u1', items: [], updatedAt: '2026-05-01T00:00:00Z' },
      { id: 'standalone', name: 'Loose', universeId: null, seriesId: null, items: [] },
    ] });
    writeJson(subsPath, { subscriptions: [
      { id: 'peer-mediaCollection-rand-1-peerA', peerId: 'peerA', recordKind: 'mediaCollection', recordId: 'rand-1' },
    ] });

    const res = await migration.up({ rootDir });
    expect(res).toMatchObject({ ok: true, reason: 'migrated', renamed: 1 });

    const cols = readJson(collectionsPath).collections;
    expect(cols.find((c) => c.universeId === 'u1').id).toBe('uc-u1');
    expect(cols.find((c) => c.name === 'Loose').id).toBe('standalone');
    expect(readJson(subsPath).subscriptions[0].recordId).toBe('uc-u1');

    // Second run is a no-op.
    const res2 = await migration.up({ rootDir });
    expect(res2).toMatchObject({ ok: true, reason: 'already-canonical' });
  });

  it('no-ops on a fresh install (no media-collections.json)', async () => {
    const res = await migration.up({ rootDir });
    expect(res).toMatchObject({ ok: true, reason: 'no-collections' });
    expect(existsSync(collectionsPath)).toBe(false);
  });
});
