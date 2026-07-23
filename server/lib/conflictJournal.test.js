import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from './mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'conflict-journal-test-'));

// Shared counter for base-hash file writes (delegating spy below). Hoisted so
// the vi.mock factory can reference it. The flush-batch tests assert N stamps
// collapse to ONE sync_base_hashes.json rewrite.
const writeCounter = vi.hoisted(() => ({ baseHash: 0 }));

vi.mock('./fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return makePathsProxy(actual, {
    dataRoot: TEST_DATA_ROOT,
    overrides: {
      // Count base-hash rewrites, then delegate to the real writer so on-disk
      // state stays correct for every other assertion in this suite.
      atomicWrite: async (path, data) => {
        if (typeof path === 'string' && path.endsWith('sync_base_hashes.json')) writeCounter.baseHash += 1;
        return actual.atomicWrite(path, data);
      },
    },
  });
});

const cj = await import('./conflictJournal.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

// Minimal universe-shaped records (sanitizeRecordForWire needs an id; universe
// adds the soft-delete pair). Distinct content → distinct content hashes.
const uni = (over = {}) => ({ id: 'u-1', name: 'X', starterPrompt: 'base', updatedAt: '2026-05-01T00:00:00Z', ...over });

// Minimal issue-shaped record — sanitizeRecordForWire('issue', …) passes the
// content through verbatim (it does NOT run sanitizeIssue), so `stages`
// round-trips into the content hash. `number` is deliberately EXCLUDED from
// the issue conflict hash (renumber-managed; see HASH_EXCLUDED_FIELDS).
const iss = (over = {}) => ({ id: 'iss-1', seriesId: 'ser-1', title: 'T', number: 1, status: 'draft', stages: {}, updatedAt: '2026-05-01T00:00:00Z', ...over });

// Minimal track-shaped record — sanitizeRecordForWire('track', …) passes the
// content through verbatim (whole-record LWW). `chiptuneScore`/`chiptunePrompt`
// default to their "untouched" shape (null/'') so a fixture that omits them
// still round-trips exactly like a pre-#2911 track.
const trk = (over = {}) => ({ id: 't-1', title: 'Song', albumId: 'al-1', artistId: 'ar-1', renders: [], chiptuneScore: null, chiptunePrompt: '', updatedAt: '2026-05-01T00:00:00Z', ...over });

const pendingEntries = async () => cj.conflictJournalStore().loadAll();

describe('conflictJournal', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
    cj.__resetBaseHashCacheForTests();
  });

  it('contentHashForRecord is stable and null for an ephemeral non-tombstone', () => {
    const h1 = cj.contentHashForRecord('universe', uni());
    const h2 = cj.contentHashForRecord('universe', uni());
    expect(h1).toBe(h2);
    expect(cj.contentHashForRecord('universe', uni({ ephemeral: true }))).toBeNull();
  });

  it('contentHashForRecord ignores styleImageRefs (probe renders never feed conflict detection)', () => {
    // styleImageRefs is stripped from the wire projection contentHashForRecord
    // reuses, so a base style-probe render that only adds/changes those refs
    // must NOT shift the content hash — otherwise a render alone could register
    // a phantom 3-way divergence whose conflict diff can't even mention the
    // field (RESTORABLE_FIELDS.universe omits it).
    const base = cj.contentHashForRecord('universe', uni());
    expect(cj.contentHashForRecord('universe', uni({ styleImageRefs: ['probe-1.png'] }))).toBe(base);
    expect(cj.contentHashForRecord('universe', uni({ styleImageRefs: ['probe-1.png', 'probe-2.png'] }))).toBe(base);
  });

  it('no base → treated as clean (no journal), base seeded for next time', async () => {
    const local = uni({ starterPrompt: 'local', updatedAt: '2026-05-01T00:00:00Z' });
    const remote = uni({ starterPrompt: 'remote', updatedAt: '2026-05-02T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote, source: { via: 'sync' } });
    await cj.flushBaseHashes();
    expect(await pendingEntries()).toHaveLength(0);
    expect(await cj.getSyncBaseHash('universe', 'u-1')).toBe(cj.contentHashForRecord('universe', remote));
  });

  it('clean sequential update (local == base) → no journal', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    // local untouched since base; remote is a newer edit.
    const remote = uni({ starterPrompt: 'remote-edit', updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local: base, remote, source: { via: 'sync' } });
    expect(await pendingEntries()).toHaveLength(0);
  });

  it('true 3-way divergence → exactly one journal entry; convergence base advances', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    const local = uni({ starterPrompt: 'LOCAL edit', updatedAt: '2026-05-02T00:00:00Z' });   // diverged
    const remote = uni({ starterPrompt: 'REMOTE edit', updatedAt: '2026-05-03T00:00:00Z' });  // diverged + newer

    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote, source: { via: 'push', peerId: 'peer-A' } });
    const entries = await pendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ recordKind: 'universe', recordId: 'u-1', status: 'pending' });
    expect(entries[0].localSnapshot.starterPrompt).toBe('LOCAL edit');
    expect(entries[0].remoteSnapshot.starterPrompt).toBe('REMOTE edit');
    expect(entries[0].diffSummary.some((d) => d.field === 'starterPrompt')).toBe(true);
    // Base advanced to remote → an idempotent replay must NOT re-journal.
    expect(await cj.getSyncBaseHash('universe', 'u-1')).toBe(cj.contentHashForRecord('universe', remote));
  });

  it('idempotent snapshot replay does not create a second entry', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    const local = uni({ starterPrompt: 'LOCAL', updatedAt: '2026-05-02T00:00:00Z' });
    const remote = uni({ starterPrompt: 'REMOTE', updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote, source: { via: 'sync' } });
    // After the (simulated) overwrite, local == remote; replay the same remote.
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local: remote, remote, source: { via: 'sync' } });
    expect(await pendingEntries()).toHaveLength(1);
  });

  it('diffSummary surfaces only restorable content fields, never server-owned ones', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    // Differ in a restorable field (starterPrompt) AND a non-restorable one
    // (schemaVersion). Only the restorable field may be offered to the UI —
    // otherwise merge-fields would reject the whole request server-side.
    const local = uni({ starterPrompt: 'LOCAL', schemaVersion: 4, updatedAt: '2026-05-02T00:00:00Z' });
    const remote = uni({ starterPrompt: 'REMOTE', schemaVersion: 5, updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote, source: { via: 'sync' } });
    const [entry] = await pendingEntries();
    const fields = entry.diffSummary.map((d) => d.field);
    expect(fields).toContain('starterPrompt');
    expect(fields).not.toContain('schemaVersion');
    expect(fields).not.toContain('id');
  });

  describe('deepFieldDiff (per-sub-entry diffing)', () => {
    it('object map → one part per changed key, only the differing keys', () => {
      const local = { tone: { v: 'dark' }, palette: { v: 'warm' }, era: { v: 'now' } };
      const remote = { tone: { v: 'light' }, palette: { v: 'warm' }, mood: { v: 'tense' } };
      const parts = cj.deepFieldDiff(local, remote);
      const byPath = Object.fromEntries(parts.map((p) => [p.path, p]));
      expect(Object.keys(byPath).sort()).toEqual(['era', 'mood', 'tone']); // palette unchanged → absent
      expect(byPath.tone.changed).toBe('both');
      expect(byPath.era.changed).toBe('local-only');   // removed on remote
      expect(byPath.mood.changed).toBe('remote-only');  // added on remote
    });

    it('array of identity-bearing objects → paired by id (path), labelled by name (label)', () => {
      const local = [{ id: 'c1', name: 'Alice', age: 30 }, { id: 'c2', name: 'Bob', age: 40 }];
      const remote = [{ id: 'c1', name: 'Alice', age: 31 }, { id: 'c3', name: 'Cara', age: 22 }];
      const parts = cj.deepFieldDiff(local, remote);
      // path = the unique match key (id); label = the friendly name.
      const byId = Object.fromEntries(parts.map((p) => [p.path, p]));
      expect(Object.keys(byId).sort()).toEqual(['c1', 'c2', 'c3']);
      expect(byId.c1).toMatchObject({ label: 'Alice', changed: 'both' });
      expect(byId.c2).toMatchObject({ label: 'Bob', changed: 'local-only' });   // removed
      expect(byId.c3).toMatchObject({ label: 'Cara', changed: 'remote-only' }); // added
    });

    it('distinct ids with a COLLIDING display name keep distinct (unique) paths', () => {
      // Two different characters both named "Alice" must not collapse — the
      // React key is `path` (the id), which stays unique even when labels clash.
      const local = [{ id: 'c1', name: 'Alice', bio: 'one' }, { id: 'c2', name: 'Alice', bio: 'two' }];
      const remote = [{ id: 'c1', name: 'Alice', bio: 'ONE' }, { id: 'c2', name: 'Alice', bio: 'TWO' }];
      const parts = cj.deepFieldDiff(local, remote);
      expect(parts.map((p) => p.path).sort()).toEqual(['c1', 'c2']);
      expect(parts.every((p) => p.label === 'Alice')).toBe(true);
    });

    it('reordering identity-bearing objects with no content change → null (no spurious parts)', () => {
      const local = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
      const remote = [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }];
      expect(cj.deepFieldDiff(local, remote)).toBeNull();
    });

    it('duplicate match keys within an array → null (pairing unreliable, fall back to whole-field)', () => {
      const local = [{ id: 'dup', name: 'A' }, { id: 'dup', name: 'B' }];
      const remote = [{ id: 'dup', name: 'C' }];
      expect(cj.deepFieldDiff(local, remote)).toBeNull();
    });

    it('returns null for scalars, arrays of scalars, identity-less arrays, and shape mismatches', () => {
      expect(cj.deepFieldDiff('a', 'b')).toBeNull();
      expect(cj.deepFieldDiff(['x', 'y'], ['x', 'z'])).toBeNull();
      expect(cj.deepFieldDiff([{ foo: 1 }], [{ foo: 2 }])).toBeNull(); // no id/key/slug/name
      expect(cj.deepFieldDiff({ a: 1 }, [1, 2])).toBeNull();           // object vs array
    });
  });

  it('diffSummary emits `parts` for object-map + array-of-object fields, whole-field for scalars', async () => {
    const base = uni({
      starterPrompt: 'base',
      categories: { tone: { v: 'dark' } },
      characters: [{ id: 'c1', name: 'Alice', bio: 'old' }],
    });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    const local = uni({
      starterPrompt: 'LOCAL prompt',
      categories: { tone: { v: 'LOCAL tone' } },
      characters: [{ id: 'c1', name: 'Alice', bio: 'LOCAL bio' }],
      updatedAt: '2026-05-02T00:00:00Z',
    });
    const remote = uni({
      starterPrompt: 'REMOTE prompt',
      categories: { tone: { v: 'REMOTE tone' } },
      characters: [{ id: 'c1', name: 'Alice', bio: 'REMOTE bio' }],
      updatedAt: '2026-05-03T00:00:00Z',
    });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote, source: { via: 'sync' } });
    const [entry] = await pendingEntries();
    const byField = Object.fromEntries(entry.diffSummary.map((d) => [d.field, d]));
    // scalar field → whole-field values, no parts.
    expect(byField.starterPrompt.parts).toBeUndefined();
    expect(byField.starterPrompt.localValue).toBe('LOCAL prompt');
    // object-map field → parts keyed by category (path = label = key).
    expect(byField.categories.localValue).toBeUndefined();
    expect(byField.categories.parts.map((p) => p.path)).toEqual(['tone']);
    // array-of-objects field → path is the id, label is the name.
    expect(byField.characters.parts.map((p) => p.path)).toEqual(['c1']);
    expect(byField.characters.parts.map((p) => p.label)).toEqual(['Alice']);
    expect(byField.characters.parts[0].remoteValue.bio).toBe('REMOTE bio');
  });

  it('issue content hash ignores the renumber-managed `number` (no false divergence on a sibling renumber)', () => {
    // A local sibling-delete shifts this issue's `number` in place WITHOUT
    // bumping updatedAt — that must NOT register as a content divergence.
    expect(cj.contentHashForRecord('issue', iss({ number: 1 })))
      .toBe(cj.contentHashForRecord('issue', iss({ number: 9 })));
    // A real content edit (title) still changes the hash.
    expect(cj.contentHashForRecord('issue', iss({ title: 'A' })))
      .not.toBe(cj.contentHashForRecord('issue', iss({ title: 'B' })));
  });

  it('a pure-renumber local drift does NOT journal a conflict when a real remote edit arrives', async () => {
    const base = iss({ number: 1 });
    await cj.setSyncBaseHash('issue', 'iss-1', cj.contentHashForRecord('issue', base));
    // Local ONLY renumbered (number 1→2, no restorable edit, updatedAt unchanged).
    const local = iss({ number: 2 });
    // Remote made a real edit and is newer.
    const remote = iss({ title: 'REMOTE edit', updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'issue', id: 'iss-1', local, remote, source: { via: 'sync' } });
    expect(await pendingEntries()).toHaveLength(0); // local == base (number excluded) → clean fast-forward
  });

  it('journals an issue 3-way divergence; diffSummary covers title + stages, never number/seriesId', async () => {
    const base = iss();
    await cj.setSyncBaseHash('issue', 'iss-1', cj.contentHashForRecord('issue', base));
    // Both sides diverge on the title AND the prose stage content (and a
    // server-owned `number` that must NOT surface in the diff).
    const local = iss({ title: 'LOCAL', number: 9, stages: { prose: { status: 'ready', output: 'mine' } }, updatedAt: '2026-05-02T00:00:00Z' });
    const remote = iss({ title: 'REMOTE', number: 4, stages: { prose: { status: 'ready', output: 'theirs' } }, updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'issue', id: 'iss-1', local, remote, source: { via: 'share-bucket', bucketId: 'b-1' } });
    const entries = await pendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ recordKind: 'issue', recordId: 'iss-1', status: 'pending' });
    expect(entries[0].localSnapshot.title).toBe('LOCAL');
    const fields = entries[0].diffSummary.map((d) => d.field);
    expect(fields).toContain('title');
    expect(fields).toContain('stages');
    expect(fields).not.toContain('number');
    expect(fields).not.toContain('seriesId');
    // Base advanced to remote → an idempotent replay must NOT re-journal.
    expect(await cj.getSyncBaseHash('issue', 'iss-1')).toBe(cj.contentHashForRecord('issue', remote));
  });

  describe('track content hash — version-gated additive fields (#2912)', () => {
    it('still ignores renders (server-managed take history, permanently excluded)', () => {
      const base = cj.contentHashForRecord('track', trk());
      const withRenders = cj.contentHashForRecord('track', trk({ renders: [{ id: 'r-1', url: 'a.wav' }] }));
      expect(withRenders).toBe(base);
    });

    it('at the current version, chiptuneScore/chiptunePrompt DO participate in the hash (no longer excluded)', () => {
      const base = cj.contentHashForRecord('track', trk());
      const withScore = cj.contentHashForRecord('track', trk({ chiptuneScore: { bpm: 120 }, chiptunePrompt: 'farm loop' }));
      expect(withScore).not.toBe(base);
    });

    it('a base hash stamped BEFORE the field existed (version 2) does not churn when only chiptuneScore differs', async () => {
      // Simulate the pre-#2912 base: hashed with maxVersion 2, so chiptuneScore/
      // chiptunePrompt (introduced at tracks v3) were never part of it — the
      // same shape `HASH_EXCLUDED_FIELDS` used to produce permanently.
      const legacyBase = trk({ chiptuneScore: null, chiptunePrompt: '' });
      const legacyHash = cj.contentHashForRecord('track', legacyBase, { maxVersion: 2 });
      await cj.setSyncBaseHash('track', 't-1', legacyHash, { version: 2 });

      // Nobody has touched chiptuneScore since; only unrelated fields exist
      // identically on both sides.
      const local = trk();
      const remote = trk();
      const { isConflict, baseHash, localHash } = await cj.detectConflict({ kind: 'track', id: 't-1', local, remote });
      expect(baseHash).toBe(legacyHash);
      expect(localHash).toBe(legacyHash); // compared at the STORED (v2) version — no false divergence
      expect(isConflict).toBe(false);
    });

    it('two peers independently composing a chiptune score off a CURRENT-version base trips a real conflict', async () => {
      const base = trk({ chiptuneScore: null, chiptunePrompt: '' });
      // setSyncBaseHash with no explicit version stamps the CURRENT (v3) version.
      await cj.setSyncBaseHash('track', 't-1', cj.contentHashForRecord('track', base));

      const local = trk({ chiptuneScore: { bpm: 120 }, chiptunePrompt: 'mine', updatedAt: '2026-05-02T00:00:00Z' });
      const remote = trk({ chiptuneScore: { bpm: 90 }, chiptunePrompt: 'theirs', updatedAt: '2026-05-03T00:00:00Z' });
      await cj.maybeJournalBeforeOverwrite({ kind: 'track', id: 't-1', local, remote, source: { via: 'sync' } });
      const entries = await pendingEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ recordKind: 'track', recordId: 't-1', status: 'pending' });
    });

    it('a base advanced THROUGH maybeJournalBeforeOverwrite is re-stamped at the CURRENT version, not mislabeled at the old comparison version', async () => {
      // Regression: maybeJournalBeforeOverwrite used to advance the base with
      // the version-RESTRICTED remoteHash from detectConflict, which
      // setSyncBaseHash then tagged with the CURRENT version anyway — a
      // mislabeled entry whose stored hash bytes never included
      // chiptuneScore/chiptunePrompt, but whose version tag claimed they did.
      // Every later comparison would then include those fields (trusting the
      // tag) against hash bytes that never had them present at all —
      // permanent, guaranteed churn even when nobody touched the field.
      const legacyBase = trk({ chiptuneScore: null, chiptunePrompt: '' });
      const legacyHash = cj.contentHashForRecord('track', legacyBase, { maxVersion: 2 });
      await cj.setSyncBaseHash('track', 't-1', legacyHash, { version: 2 });

      // First sync after the base was seeded: remote is byte-identical to the
      // legacy base's content (no one has touched chiptuneScore yet) — a
      // clean fast-forward, not a conflict, and it advances the base.
      const remote1 = trk();
      await cj.maybeJournalBeforeOverwrite({ kind: 'track', id: 't-1', local: legacyBase, remote: remote1, source: { via: 'sync' } });
      expect(await pendingEntries()).toHaveLength(0);
      // Directly pin the mechanism, not just the downstream symptom: the base
      // must now be the UNRESTRICTED (current-version) hash of remote1 — the
      // mislabeling bug stamped the version-restricted hash instead.
      expect(await cj.getSyncBaseHash('track', 't-1')).toBe(cj.contentHashForRecord('track', remote1));

      // Now a SINGLE peer composes a chiptune score; the other side (`remote2`
      // here, standing in for what's already persisted) is untouched. This
      // must be a clean LWW update, not a conflict — the base should already
      // reflect remote1's full-field content, so only one side has diverged.
      const local2 = trk({ chiptuneScore: { bpm: 120 }, chiptunePrompt: 'solo edit', updatedAt: '2026-05-02T00:00:00Z' });
      const { isConflict } = await cj.detectConflict({ kind: 'track', id: 't-1', local: local2, remote: remote1 });
      expect(isConflict).toBe(false);
    });
  });

  it('does NOT journal when the local side is a tombstone (no content to lose)', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    const localTombstone = uni({ deleted: true, deletedAt: '2026-05-02T00:00:00Z', updatedAt: '2026-05-02T00:00:00Z' });
    const remote = uni({ starterPrompt: 'REMOTE', updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local: localTombstone, remote, source: { via: 'sync' } });
    expect(await pendingEntries()).toHaveLength(0);
  });

  it('journals when a remote DELETE would erase a diverged local edit', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    const local = uni({ starterPrompt: 'precious local edit', updatedAt: '2026-05-02T00:00:00Z' });
    const remoteTombstone = uni({ deleted: true, deletedAt: '2026-05-03T00:00:00Z', updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote: remoteTombstone, source: { via: 'sync' } });
    const entries = await pendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].localSnapshot.starterPrompt).toBe('precious local edit');
  });

  it('deleteSyncBaseHash removes an existing entry so getSyncBaseHash returns null', async () => {
    const base = uni({ starterPrompt: 'base' });
    const hash = cj.contentHashForRecord('universe', base);
    await cj.setSyncBaseHash('universe', 'u-del', hash);
    expect(await cj.getSyncBaseHash('universe', 'u-del')).toBe(hash);
    await cj.deleteSyncBaseHash('universe', 'u-del');
    expect(await cj.getSyncBaseHash('universe', 'u-del')).toBeNull();
  });

  it('deleteSyncBaseHash is a no-op for a key that was never set', async () => {
    await expect(cj.deleteSyncBaseHash('universe', 'nonexistent')).resolves.toBeUndefined();
    expect(await cj.getSyncBaseHash('universe', 'nonexistent')).toBeNull();
  });

  describe('pruneOrphanedBaseHashes', () => {
    it('drops keys whose record no longer resolves, keeps the rest', async () => {
      await cj.setSyncBaseHash('universe', 'live', cj.contentHashForRecord('universe', uni({ id: 'live' })));
      await cj.setSyncBaseHash('universe', 'dead', cj.contentHashForRecord('universe', uni({ id: 'dead' })));
      await cj.setSyncBaseHash('series', 'live-s', cj.contentHashForRecord('universe', uni({ id: 'live-s' })));
      // Resolver: only 'live' and 'live-s' still exist.
      const liveKeys = new Set(['universe:live', 'series:live-s']);
      const { pruned } = await cj.pruneOrphanedBaseHashes(async (kind, id) => liveKeys.has(`${kind}:${id}`));
      expect(pruned).toBe(1);
      expect(await cj.getSyncBaseHash('universe', 'live')).not.toBeNull();
      expect(await cj.getSyncBaseHash('universe', 'dead')).toBeNull();
      expect(await cj.getSyncBaseHash('series', 'live-s')).not.toBeNull();
    });

    it('keeps every key when the resolver returns true (a partial resolver never strips live entries)', async () => {
      await cj.setSyncBaseHash('issue', 'iss-1', cj.contentHashForRecord('issue', iss({ id: 'iss-1' })));
      // The contract: a resolver that returns true (e.g. for a kind it doesn't
      // recognize) must leave that key in place. The tombstoneGc resolver maps
      // unknown kinds to true for exactly this reason.
      const { pruned } = await cj.pruneOrphanedBaseHashes(async () => true);
      expect(pruned).toBe(0);
      expect(await cj.getSyncBaseHash('issue', 'iss-1')).not.toBeNull();
    });

    it('treats a resolver that throws as a conservative keep', async () => {
      await cj.setSyncBaseHash('universe', 'u-x', cj.contentHashForRecord('universe', uni({ id: 'u-x' })));
      const { pruned } = await cj.pruneOrphanedBaseHashes(async () => { throw new Error('lookup blew up'); });
      expect(pruned).toBe(0);
      expect(await cj.getSyncBaseHash('universe', 'u-x')).not.toBeNull();
    });

    it('returns {pruned:0} when given a non-function', async () => {
      await cj.setSyncBaseHash('universe', 'u-y', cj.contentHashForRecord('universe', uni({ id: 'u-y' })));
      expect(await cj.pruneOrphanedBaseHashes(null)).toEqual({ pruned: 0 });
      expect(await cj.getSyncBaseHash('universe', 'u-y')).not.toBeNull();
    });
  });
});

// A minimal collection-shaped record (sanitizeRecordForWire('mediaCollection')
// needs an id; the merge LWWs name/description/coverKey/universeId/seriesId and
// union-merges items). `items`/`updatedAt` must NOT affect the conflict hash.
const coll = (over = {}) => ({
  id: 'c-1', name: 'Bucket', description: 'd', coverKey: null, universeId: null, seriesId: null,
  items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-01T00:00:00Z' }],
  createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z', ...over,
});

describe('conflictJournal — mediaCollection scalar-subset hashing', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
    cj.__resetBaseHashCacheForTests();
  });

  it('hash ignores items and updatedAt (union-merged / LWW-key, never lost)', () => {
    const base = cj.contentHashForRecord('mediaCollection', coll());
    // Add an item + bump updatedAt — exactly what addItem does. Same scalars.
    const withItem = cj.contentHashForRecord('mediaCollection', coll({
      items: [
        { kind: 'image', ref: 'a.png', addedAt: '2026-05-01T00:00:00Z' },
        { kind: 'image', ref: 'b.png', addedAt: '2026-05-02T00:00:00Z' },
      ],
      updatedAt: '2026-05-02T00:00:00Z',
    }));
    expect(withItem).toBe(base);
  });

  it('hash changes when a tracked scalar (name) changes', () => {
    expect(cj.contentHashForRecord('mediaCollection', coll({ name: 'Renamed' })))
      .not.toBe(cj.contentHashForRecord('mediaCollection', coll()));
  });

  it('item-only divergence is NOT a 3-way conflict (no false-positive journal)', async () => {
    await cj.setSyncBaseHash('mediaCollection', 'c-1', cj.contentHashForRecord('mediaCollection', coll()));
    // Both peers added different items; neither touched a scalar. updatedAt bumps.
    const local = coll({ items: [{ kind: 'image', ref: 'L.png', addedAt: '2026-05-02T00:00:00Z' }], updatedAt: '2026-05-02T00:00:00Z' });
    const remote = coll({ items: [{ kind: 'image', ref: 'R.png', addedAt: '2026-05-03T00:00:00Z' }], updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'mediaCollection', id: 'c-1', local, remote, source: { via: 'sync' } });
    expect(await pendingEntries()).toHaveLength(0);
  });

  it('true scalar divergence (both renamed) journals exactly one entry', async () => {
    await cj.setSyncBaseHash('mediaCollection', 'c-1', cj.contentHashForRecord('mediaCollection', coll()));
    const local = coll({ name: 'LOCAL name', updatedAt: '2026-05-02T00:00:00Z' });
    const remote = coll({ name: 'REMOTE name', updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'mediaCollection', id: 'c-1', local, remote, source: { via: 'sync' } });
    const entries = await pendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].localSnapshot.name).toBe('LOCAL name');
    expect(entries[0].diffSummary.some((d) => d.field === 'name')).toBe(true);
    // diffSummary only offers restorable content fields, never items/updatedAt.
    expect(entries[0].diffSummary.some((d) => d.field === 'items' || d.field === 'updatedAt')).toBe(false);
  });
});

describe('conflictJournal — withBaseHashFlushBatch coalescing', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
    cj.__resetBaseHashCacheForTests();
    writeCounter.baseHash = 0;
  });

  it('collapses N await-separated stamp+flush cycles into ONE file write', async () => {
    // Simulate the peer:online convergence loop: stamp record i, flush (deferred
    // by the batch), then "await the network" before the next record.
    await cj.withBaseHashFlushBatch(async () => {
      for (let i = 0; i < 10; i++) {
        await cj.setSyncBaseHash('universe', `u-${i}`, cj.contentHashForRecord('universe', uni({ id: `u-${i}`, starterPrompt: `p-${i}` })));
        await cj.flushBaseHashes(); // no-op inside the batch
        await Promise.resolve();    // yield, as an inter-push await would
      }
    });
    // Exactly one terminal write for all 10 stamps.
    expect(writeCounter.baseHash).toBe(1);
    // …and every stamp persisted.
    for (let i = 0; i < 10; i++) {
      expect(await cj.getSyncBaseHash('universe', `u-${i}`)).toBe(cj.contentHashForRecord('universe', uni({ id: `u-${i}`, starterPrompt: `p-${i}` })));
    }
  });

  it('without a batch, the same loop writes once per stamp', async () => {
    for (let i = 0; i < 5; i++) {
      await cj.setSyncBaseHash('universe', `u-${i}`, cj.contentHashForRecord('universe', uni({ id: `u-${i}`, starterPrompt: `p-${i}` })));
      await cj.flushBaseHashes();
    }
    expect(writeCounter.baseHash).toBe(5);
  });

  it('nested batches collapse to the outermost (one write)', async () => {
    await cj.withBaseHashFlushBatch(async () => {
      await cj.setSyncBaseHash('universe', 'u-a', cj.contentHashForRecord('universe', uni({ id: 'u-a' })));
      await cj.withBaseHashFlushBatch(async () => {
        await cj.setSyncBaseHash('universe', 'u-b', cj.contentHashForRecord('universe', uni({ id: 'u-b' })));
        await cj.flushBaseHashes();
      });
      // Inner scope closed but depth is still >0 → no write yet.
      expect(writeCounter.baseHash).toBe(0);
    });
    expect(writeCounter.baseHash).toBe(1);
  });

  it('flushes whatever stamps landed even when the batch body throws', async () => {
    await expect(cj.withBaseHashFlushBatch(async () => {
      await cj.setSyncBaseHash('universe', 'u-x', cj.contentHashForRecord('universe', uni({ id: 'u-x' })));
      throw new Error('push blew up mid-loop');
    })).rejects.toThrow('push blew up mid-loop');
    // The terminal flush ran in `finally`, so the pre-throw stamp persisted.
    expect(writeCounter.baseHash).toBe(1);
    expect(await cj.getSyncBaseHash('universe', 'u-x')).toBe(cj.contentHashForRecord('universe', uni({ id: 'u-x' })));
  });

  it('no write when no stamp landed inside the batch', async () => {
    await cj.withBaseHashFlushBatch(async () => {
      await Promise.resolve(); // did nothing dirty
    });
    expect(writeCounter.baseHash).toBe(0);
  });
});
