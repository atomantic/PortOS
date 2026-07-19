/**
 * Tests for the `pipeline` and `universe` sync categories added in PR
 * [extend-syncorchestrator-to-cover-pipeline-universe].
 *
 * Covers: snapshot shape, checksum stability across no-op reads, array-by-id
 * LWW merge for series/issues/universes, no-blob coverage (the sync is
 * record-level only — images and videos flow through the sharing system).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-datasync-piuni-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

afterAll(cleanup);

const dataSync = await import('./dataSync.js');
// Derive the receiver's pipelineSeries version from the source of truth so this
// test doesn't false-fail every time the constant is bumped (it drifted red on
// the 10→11 bump). "Sender ahead" is always receiver + 1. Dynamic-imported after
// the vi.mock hoist so the static import doesn't disturb mock initialization.
const schemaVersionsMod = await import('../lib/schemaVersions.js');
const RECEIVER_PIPELINE_SERIES_V = schemaVersionsMod.PORTOS_SCHEMA_VERSIONS.pipelineSeries;
const SENDER_AHEAD_PIPELINE_SERIES_V = RECEIVER_PIPELINE_SERIES_V + 1;
const conflictJournal = await import('../lib/conflictJournal.js');
const { PORTOS_SCHEMA_VERSIONS } = await import('../lib/schemaVersions.js');

const SERIES_DIR = join(tempRoot, 'pipeline-series');
const ISSUES_DIR = join(tempRoot, 'pipeline-issues');
const UNIVERSES_DIR = join(tempRoot, 'universes');
const MEDIA_COLLECTIONS_DIR = join(tempRoot, 'media-collections');
const PEER_SUBS_PATH = join(tempRoot, 'sharing', 'peer_subscriptions.json');
const VIDEO_HISTORY_PATH = join(tempRoot, 'video-history.json');

// Write the outbound peer-subscription store that drives the per-peer
// snapshot exclude-set. Each row is `{ peerId, recordKind, recordId }`.
function writePeerSubs(rows) {
  mkdirSync(join(tempRoot, 'sharing'), { recursive: true });
  writeFileSync(PEER_SUBS_PATH, JSON.stringify({
    subscriptions: rows.map((r) => ({
      id: `peer-${r.recordKind}-${r.recordId}-${r.peerId}`,
      peerId: r.peerId,
      recordKind: r.recordKind,
      recordId: r.recordId,
      createdAt: '2026-05-25T00:00:00Z',
      updatedAt: '2026-05-25T00:00:00Z',
    })),
  }, null, 2));
}

function writeJSON(path, obj) {
  mkdirSync(tempRoot, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeCollectionState(dir, type, records) {
  mkdirSync(dir, { recursive: true });
  writeJSON(join(dir, 'index.json'), {
    schemaVersion: 1,
    type,
    updatedAt: '2026-05-17T09:00:00Z',
    config: {},
  });
  for (const record of records) {
    mkdirSync(join(dir, record.id), { recursive: true });
    writeJSON(join(dir, record.id, 'index.json'), record);
  }
}

function readCollectionState(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJSON(join(dir, entry.name, 'index.json')));
}

// media-collections moved to the per-record collectionStore layout (migration
// 059); these adapters keep the `{ collections: [...] }`-shaped call sites below
// working against the split dir.
function writeMediaCollections({ collections = [] } = {}) {
  writeCollectionState(MEDIA_COLLECTIONS_DIR, 'mediaCollections', collections);
}
function readMediaCollections() {
  return { collections: readCollectionState(MEDIA_COLLECTIONS_DIR) };
}

const writeSeriesState = (series) => writeCollectionState(SERIES_DIR, 'pipelineSeries', series);
const writeIssueState = (issues) => writeCollectionState(ISSUES_DIR, 'pipelineIssues', issues);
const readSeriesState = () => readCollectionState(SERIES_DIR);
const readIssueState = () => readCollectionState(ISSUES_DIR);

// Write the universes split layout (migration 034's output): one
// `universes/<id>/index.json` per record + a type-level `universes/index.json`
// whose `config.runs` carries the cross-record runs[] log.
function writeUniverseState({ universes = [], runs = [] } = {}) {
  mkdirSync(UNIVERSES_DIR, { recursive: true });
  for (const u of universes) {
    const dir = join(UNIVERSES_DIR, u.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.json'), JSON.stringify(u, null, 2));
  }
  writeFileSync(join(UNIVERSES_DIR, 'index.json'), JSON.stringify({
    schemaVersion: 5, type: 'universes', updatedAt: new Date().toISOString(),
    config: { runs },
  }, null, 2));
}

// Read it back as the legacy `{ universes, runs }` shape so existing
// assertions don't need rewiring.
function readUniverseState() {
  if (!existsSync(UNIVERSES_DIR)) return { universes: [], runs: [] };
  const entries = readdirSync(UNIVERSES_DIR);
  const universes = [];
  for (const name of entries) {
    if (name === 'index.json' || name.startsWith('.')) continue;
    const p = join(UNIVERSES_DIR, name, 'index.json');
    if (existsSync(p)) universes.push(JSON.parse(readFileSync(p, 'utf-8')));
  }
  const typeIdx = existsSync(join(UNIVERSES_DIR, 'index.json'))
    ? JSON.parse(readFileSync(join(UNIVERSES_DIR, 'index.json'), 'utf-8'))
    : null;
  const runs = typeIdx?.config?.runs || [];
  return { universes, runs };
}

beforeEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
});

describe('dataSync — universe category', () => {
  it('is registered alongside the other categories', () => {
    const cats = dataSync.getSupportedCategories();
    expect(cats).toContain('universe');
    expect(cats).toContain('pipeline');
    expect(cats).toContain('goals'); // sanity
  });

  it('snapshot returns just `universes` (not `runs`)', async () => {
    writeUniverseState({
      universes: [{ id: 'u1', name: 'Salt', updatedAt: '2026-05-17T10:00:00Z' }],
      runs: [{ id: 'r1', logs: ['ephemeral'] }]
    });
    const snap = await dataSync.getSnapshot('universe');
    expect(snap.data.universes).toHaveLength(1);
    expect(snap.data.universes[0].id).toBe('u1');
    expect(snap.data.runs).toBeUndefined();
    expect(snap.checksum).toBeTruthy();
  });

  it('snapshot envelope carries portosMeta { portosVersion, schemaVersions } so receivers can gate', async () => {
    const snap = await dataSync.getSnapshot('universe');
    expect(snap.portosMeta).toBeDefined();
    expect(typeof snap.portosMeta.portosVersion).toBe('string');
    expect(snap.portosMeta.schemaVersions.universes).toBe(7);
  });

  it('applyRemote rejects when sender schemaVersions are AHEAD of local code', async () => {
    writeUniverseState({ universes: [], runs: [] });
    const result = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u-new', name: 'Foundry', updatedAt: '2026-05-17T10:00:00Z' }],
    }, { portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 8 } } });
    expect(result.applied).toBe(false);
    expect(result.count).toBe(0);
    expect(result.blockedBySchema).toBeDefined();
    expect(result.blockedBySchema.ahead).toEqual([
      { category: 'universes', senderV: 8, receiverV: 7 },
    ]);
    expect(result.blockedBySchema.senderPortosVersion).toBe('99.0.0');
    // Nothing was written.
    expect(readUniverseState().universes).toEqual([]);
  });

  it('applyRemote falls through when sender is BEHIND (sanitizer backfills)', async () => {
    writeUniverseState({ universes: [], runs: [] });
    const result = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u-old', name: 'Legacy', createdAt: '2026-05-17T09:00:00Z', updatedAt: '2026-05-17T10:00:00Z' }],
    }, { portosMeta: { portosVersion: '2.6.0', schemaVersions: { universes: 4 } } });
    expect(result.applied).toBe(true);
    expect(result.count).toBe(1);
  });

  it('applyRemote falls through for legacy senders that send NO portosMeta at all', async () => {
    writeUniverseState({ universes: [], runs: [] });
    const result = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u-legacy', name: 'Pre-Versioning', createdAt: '2026-05-17T09:00:00Z', updatedAt: '2026-05-17T10:00:00Z' }],
    });
    expect(result.applied).toBe(true);
  });

  it('snapshot checksum is stable across reads when state is unchanged', async () => {
    writeUniverseState({ universes: [{ id: 'u1', updatedAt: '2026-05-17T10:00:00Z' }] });
    const a = await dataSync.getSnapshot('universe');
    const b = await dataSync.getSnapshot('universe');
    expect(a.checksum).toBe(b.checksum);
  });

  it('snapshot handles a missing file gracefully', async () => {
    const snap = await dataSync.getSnapshot('universe');
    expect(snap.data.universes).toEqual([]);
    expect(snap.checksum).toBeTruthy();
  });

  it('applyRemote inserts a new universe', async () => {
    writeUniverseState({ universes: [], runs: [] });
    const result = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u-new', name: 'Foundry', updatedAt: '2026-05-17T10:00:00Z' }]
    });
    expect(result.applied).toBe(true);
    expect(result.count).toBe(1);
    const persisted = readUniverseState();
    expect(persisted.universes).toHaveLength(1);
    expect(persisted.universes[0].id).toBe('u-new');
    // Local-only `runs` must survive the merge.
    expect(persisted.runs).toEqual([]);
  });

  it('applyRemote LWW: newer remote wins, older remote is dropped', async () => {
    writeUniverseState({
      universes: [{ id: 'u1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }]
    });
    const result = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u1', name: 'New', updatedAt: '2026-05-17T11:00:00Z' }]
    });
    expect(result.applied).toBe(true);
    expect(readUniverseState().universes[0].name).toBe('New');

    // Replay older — should NOT clobber.
    const replay = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }]
    });
    expect(replay.applied).toBe(false);
    expect(readUniverseState().universes[0].name).toBe('New');
  });

  it('applyRemote preserves local-only `runs[]` when only universes change', async () => {
    // Runs need a valid shape — `sanitizeRun` requires id + universeId since
    // the merge now routes through the service-level entry point that
    // sanitizes every read.
    const localRun = {
      id: 'r1', universeId: 'u-local', collectionId: null,
      jobIds: [], promptCount: 0, createdAt: '2026-05-17T09:00:00Z',
    };
    writeUniverseState({ universes: [], runs: [localRun] });
    await dataSync.applyRemote('universe', {
      universes: [{ id: 'u1', name: 'A', createdAt: '2026-05-17T09:00:00Z', updatedAt: '2026-05-17T10:00:00Z' }]
    });
    const persisted = readUniverseState();
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0].id).toBe('r1');
    expect(persisted.runs[0].universeId).toBe('u-local');
  });
});

describe('dataSync — conflict-journal source attribution (snapshot path)', () => {
  // The snapshot apply path (syncOrchestrator → dataSync.applyRemote → the
  // service merge fns) must stamp journaled conflicts with `via: 'snapshot'`
  // and the source peer's id. Before [conflict-source-attribution] the param
  // was dropped, so the Conflicts tab showed `via: sync (peerId: null)` and
  // couldn't say which peer collided.
  const journalDir = () => join(tempRoot, 'conflict-journal');
  const readJournalEntries = () => {
    if (!existsSync(journalDir())) return [];
    return readdirSync(journalDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readJSON(join(journalDir(), e.name, 'index.json')));
  };
  // Seed local + a divergent base so the incoming remote is a true 3-way
  // conflict (local ≠ base, remote ≠ base, remote ≠ local) and the merge
  // journals before overwriting. Remote `updatedAt` is newer so it wins LWW.
  async function seedConflict(id) {
    writeUniverseState({
      universes: [{ id, name: 'Local Edit', updatedAt: '2026-05-17T10:00:00Z' }],
    });
    await conflictJournal.setSyncBaseHash('universe', id, `base-hash-${id}-distinct`);
    await conflictJournal.flushBaseHashes();
  }

  beforeEach(() => {
    // The base-hash cache is module-level; reset it so the wiped temp root
    // doesn't bleed seeds across tests.
    conflictJournal.__resetBaseHashCacheForTests();
  });

  it('records via:snapshot + the source peerId when the orchestrator passes one', async () => {
    await seedConflict('u-attr');
    const result = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u-attr', name: 'Remote Edit', updatedAt: '2026-05-18T10:00:00Z' }],
    }, { peerId: 'peer-zeta' });
    expect(result.applied).toBe(true);

    const entries = readJournalEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].recordKind).toBe('universe');
    expect(entries[0].recordId).toBe('u-attr');
    expect(entries[0].source).toEqual({ via: 'snapshot', peerId: 'peer-zeta' });
  });

  it('defaults peerId to null (not undefined) when the caller omits it — manual REST apply', async () => {
    await seedConflict('u-anon');
    await dataSync.applyRemote('universe', {
      universes: [{ id: 'u-anon', name: 'Remote Edit', updatedAt: '2026-05-18T10:00:00Z' }],
    });
    const entries = readJournalEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toEqual({ via: 'snapshot', peerId: null });
  });
});

describe('dataSync — pipeline category', () => {
  it('snapshot bundles series + issues from their respective files', async () => {
    writeSeriesState([{ id: 'ser-1', name: 'A', updatedAt: '2026-05-17T10:00:00Z' }]);
    writeIssueState([{ id: 'iss-1', seriesId: 'ser-1', title: 'One', updatedAt: '2026-05-17T10:00:00Z' }]);
    const snap = await dataSync.getSnapshot('pipeline');
    expect(snap.data.series).toHaveLength(1);
    expect(snap.data.issues).toHaveLength(1);
    expect(snap.data.issues[0].seriesId).toBe('ser-1');
  });

  it('snapshot tolerates missing files', async () => {
    const snap = await dataSync.getSnapshot('pipeline');
    expect(snap.data.series).toEqual([]);
    expect(snap.data.issues).toEqual([]);
  });

  it('applyRemote merges series + issues; count reports records actually changed', async () => {
    writeSeriesState([{ id: 'ser-1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }]);
    writeIssueState([]);

    const result = await dataSync.applyRemote('pipeline', {
      series: [
        { id: 'ser-1', name: 'New', updatedAt: '2026-05-17T11:00:00Z' },
        { id: 'ser-2', name: 'Foundry', updatedAt: '2026-05-17T10:00:00Z' }
      ],
      issues: [
        { id: 'iss-1', seriesId: 'ser-2', title: 'Pilot', updatedAt: '2026-05-17T10:00:00Z' }
      ]
    });
    expect(result.applied).toBe(true);
    // `count` is records actually changed/added this cycle, NOT total post-
    // merge records (which would over-report when callers sum across cycles
    // or categories). Two series updated/added + one issue added = 3.
    expect(result.count).toBe(3);
    // Per-side breakdown surfaced for telemetry that wants to distinguish them.
    expect(result.seriesChanged).toBe(2);
    expect(result.issuesChanged).toBe(1);

    const persistedSeries = readSeriesState();
    expect(persistedSeries).toHaveLength(2);
    expect(persistedSeries.find(s => s.id === 'ser-1').name).toBe('New'); // LWW
    expect(persistedSeries.find(s => s.id === 'ser-2').name).toBe('Foundry');

    const persistedIssues = readIssueState();
    expect(persistedIssues).toHaveLength(1);
    expect(persistedIssues[0].seriesId).toBe('ser-2');
  });

  it('applyRemote count reports only the changed side when only series differs', async () => {
    writeSeriesState([{ id: 'ser-1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }]);
    // Local issues exist but won't change — sync must not inflate count to
    // include them (the pre-fix bug counted total post-merge issues).
    writeIssueState([{ id: 'iss-1', seriesId: 'ser-1', title: 'Local', updatedAt: '2026-05-17T10:00:00Z' }]);

    const result = await dataSync.applyRemote('pipeline', {
      series: [{ id: 'ser-1', name: 'New', updatedAt: '2026-05-17T11:00:00Z' }],
      issues: [{ id: 'iss-1', seriesId: 'ser-1', title: 'Stale', updatedAt: '2026-05-17T09:00:00Z' }], // older, skipped
    });
    expect(result.applied).toBe(true);
    expect(result.count).toBe(1); // one series change; issues side unchanged
    expect(result.seriesChanged).toBe(1);
    expect(result.issuesChanged).toBe(0);
  });

  it('applyRemote is a no-op when nothing is newer', async () => {
    writeSeriesState([{ id: 'ser-1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }]);
    writeIssueState([{ id: 'iss-1', seriesId: 'ser-1', title: 'Local', updatedAt: '2026-05-17T10:00:00Z' }]);

    const before = readSeriesState();
    const result = await dataSync.applyRemote('pipeline', {
      series: [{ id: 'ser-1', updatedAt: '2026-05-17T10:00:00Z' }], // same ts
      issues: [{ id: 'iss-1', updatedAt: '2026-05-17T09:00:00Z' }]  // older
    });
    expect(result.applied).toBe(false);
    expect(result.count).toBe(0);
    expect(readSeriesState()).toEqual(before);
  });

  it('applyRemote skips writes for unchanged sides (writes only what differs)', async () => {
    writeSeriesState([{ id: 'ser-1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }]);
    writeIssueState([]);

    // Only issues change. Use a valid issue payload (id + seriesId + title)
    // since the merge now routes through sanitizeIssue.
    await dataSync.applyRemote('pipeline', {
      series: [{ id: 'ser-1', updatedAt: '2026-05-17T09:00:00Z' }], // older → skipped
      issues: [{ id: 'iss-new', seriesId: 'ser-1', title: 'New Issue', updatedAt: '2026-05-17T11:00:00Z' }]
    });

    // Series file untouched (no incidental rewrite that could clobber a
    // concurrent write outside the sync orchestrator).
    expect(readSeriesState()[0].updatedAt).toBe('2026-05-17T10:00:00Z');
    expect(readIssueState()).toHaveLength(1);
  });
});

describe('dataSync — getChecksum cache', () => {
  it('returns the same checksum across consecutive calls and matches getSnapshot', async () => {
    writeUniverseState({
      universes: [{ id: 'u1', name: 'A', createdAt: '2026-05-17T09:00:00Z', updatedAt: '2026-05-17T10:00:00Z' }],
    });
    const c1 = await dataSync.getChecksum('universe');
    const c2 = await dataSync.getChecksum('universe');
    const snap = await dataSync.getSnapshot('universe');
    expect(c1.checksum).toBe(c2.checksum);
    expect(c1.checksum).toBe(snap.checksum);
  });

  it('invalidates the cache after applyRemote bumps the underlying file mtime', async () => {
    writeUniverseState({
      universes: [{ id: 'u1', name: 'A', createdAt: '2026-05-17T09:00:00Z', updatedAt: '2026-05-17T10:00:00Z' }],
    });
    const before = await dataSync.getChecksum('universe');
    await dataSync.applyRemote('universe', {
      universes: [{ id: 'u1', name: 'B', updatedAt: '2026-05-17T11:00:00Z' }],
    });
    const after = await dataSync.getChecksum('universe');
    expect(after.checksum).not.toBe(before.checksum);
    expect(after.checksum).toBe((await dataSync.getSnapshot('universe')).checksum);
  });

  it('reflects an out-of-band file mutation (pipeline series changes outside this service)', async () => {
    writeSeriesState([{ id: 'ser-1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }]);
    writeIssueState([]);
    const before = await dataSync.getChecksum('pipeline');
    // Force a different mtime — vitest can run faster than the FS's ms tick,
    // so wait long enough that the mtime is guaranteed to advance.
    await new Promise((r) => setTimeout(r, 5));
    writeSeriesState([{ id: 'ser-1', name: 'New', updatedAt: '2026-05-17T11:00:00Z' }]);
    const after = await dataSync.getChecksum('pipeline');
    expect(after.checksum).not.toBe(before.checksum);
  });
});

describe('dataSync — mediaCollections category', () => {
  it('is registered alongside the other categories', () => {
    expect(dataSync.getSupportedCategories()).toContain('mediaCollections');
  });

  it('snapshot returns sanitized collections array', async () => {
    writeMediaCollections({
      collections: [{
        id: 'c1',
        name: 'Universe: Echoes',
        description: '',
        coverKey: null,
        universeId: 'u1',
        seriesId: null,
        items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T01:00:00Z',
      }],
    });
    const snap = await dataSync.getSnapshot('mediaCollections');
    expect(snap.data.collections).toHaveLength(1);
    expect(snap.data.collections[0].id).toBe('c1');
    expect(snap.checksum).toBeTruthy();
  });

  it('snapshot checksum is stable across reads when state is unchanged', async () => {
    writeMediaCollections({
      collections: [{
        id: 'c1', name: 'A', description: '', coverKey: null, universeId: null, seriesId: null,
        items: [], createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T00:00:00Z',
      }],
    });
    const a = await dataSync.getSnapshot('mediaCollections');
    const b = await dataSync.getSnapshot('mediaCollections');
    expect(a.checksum).toBe(b.checksum);
  });

  it('snapshot handles a missing file gracefully', async () => {
    const snap = await dataSync.getSnapshot('mediaCollections');
    expect(snap.data.collections).toEqual([]);
    expect(snap.checksum).toBeTruthy();
  });

  it('applyRemote inserts a new collection', async () => {
    writeMediaCollections({ collections: [] });
    const result = await dataSync.applyRemote('mediaCollections', {
      collections: [{
        id: 'c-new', name: 'Universe: New', description: '', coverKey: null,
        universeId: 'u-new', seriesId: null,
        items: [{ kind: 'image', ref: 'new.png', addedAt: '2026-05-22T01:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T01:00:00Z',
      }],
    });
    expect(result.applied).toBe(true);
    expect(result.count).toBe(1);
    const persisted = readMediaCollections();
    expect(persisted.collections).toHaveLength(1);
    expect(persisted.collections[0].id).toBe('c-new');
  });

  it('applyRemote unions items by kind:ref — never loses a render', async () => {
    writeMediaCollections({
      collections: [{
        id: 'c1', name: 'A', description: '', coverKey: null, universeId: null, seriesId: null,
        items: [{ kind: 'image', ref: 'local.png', addedAt: '2026-05-22T01:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T01:00:00Z',
      }],
    });
    await dataSync.applyRemote('mediaCollections', {
      collections: [{
        id: 'c1', name: 'A', description: '', coverKey: null, universeId: null, seriesId: null,
        items: [{ kind: 'image', ref: 'remote.png', addedAt: '2026-05-22T02:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T02:00:00Z',
      }],
    });
    const persisted = readMediaCollections();
    const refs = persisted.collections[0].items.map(i => i.ref).sort();
    expect(refs).toEqual(['local.png', 'remote.png']);
  });

  it('checksum changes after applyRemote bumps file mtime', async () => {
    writeMediaCollections({
      collections: [{
        id: 'c1', name: 'A', description: '', coverKey: null, universeId: null, seriesId: null,
        items: [], createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T01:00:00Z',
      }],
    });
    const before = await dataSync.getChecksum('mediaCollections');
    await dataSync.applyRemote('mediaCollections', {
      collections: [{
        id: 'c1', name: 'A', description: '', coverKey: null, universeId: null, seriesId: null,
        items: [{ kind: 'image', ref: 'a.png', addedAt: '2026-05-22T02:00:00Z' }],
        createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T02:00:00Z',
      }],
    });
    const after = await dataSync.getChecksum('mediaCollections');
    expect(after.checksum).not.toBe(before.checksum);
  });

  it('snapshot checksum is order-insensitive for collections and items', async () => {
    // Regression: two peers can hold identical sets but write them to disk
    // in different orders (insertion-order persistence). Without
    // canonicalization in getMediaCollectionsSnapshot, their checksums
    // diverge permanently and the UI reads "behind" forever even though
    // they're converged.
    writeMediaCollections({
      collections: [
        {
          id: 'c-b', name: 'B', description: '', coverKey: null, universeId: null, seriesId: null,
          items: [
            { kind: 'image', ref: 'z.png', addedAt: '2026-05-22T03:00:00Z' },
            { kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' },
          ],
          createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T03:00:00Z',
        },
        {
          id: 'c-a', name: 'A', description: '', coverKey: null, universeId: null, seriesId: null,
          items: [
            { kind: 'video', ref: 'v1', addedAt: '2026-05-22T02:00:00Z' },
            { kind: 'image', ref: 'x.png', addedAt: '2026-05-22T01:00:00Z' },
          ],
          createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T02:00:00Z',
        },
      ],
    });
    const a = await dataSync.getSnapshot('mediaCollections');

    // Same SET, reversed order at every level.
    await new Promise((r) => setTimeout(r, 5)); // ensure mtime changes
    writeMediaCollections({
      collections: [
        {
          id: 'c-a', name: 'A', description: '', coverKey: null, universeId: null, seriesId: null,
          items: [
            { kind: 'image', ref: 'x.png', addedAt: '2026-05-22T01:00:00Z' },
            { kind: 'video', ref: 'v1', addedAt: '2026-05-22T02:00:00Z' },
          ],
          createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T02:00:00Z',
        },
        {
          id: 'c-b', name: 'B', description: '', coverKey: null, universeId: null, seriesId: null,
          items: [
            { kind: 'image', ref: 'a.png', addedAt: '2026-05-22T01:00:00Z' },
            { kind: 'image', ref: 'z.png', addedAt: '2026-05-22T03:00:00Z' },
          ],
          createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T03:00:00Z',
        },
      ],
    });
    const b = await dataSync.getSnapshot('mediaCollections');
    expect(b.checksum).toBe(a.checksum);
  });
});

// ---------------------------------------------------------------------------
// Per-peer snapshot scoping (`forPeerId`) — the Item A / Item B fix.
//
// When the requesting peer is passed via `forPeerId`, the source EXCLUDES the
// records it already pushes that peer per-record (the records THIS instance
// has outbound subscriptions for to that peer) — leaving un-subscribed records
// and torn-down-sub tombstones to ride the snapshot. With NO forPeerId, the
// snapshot is the full category (legacy behavior).
// ---------------------------------------------------------------------------
describe('dataSync — per-peer snapshot scoping (forPeerId exclude-set)', () => {
  it('universe: excludes the requesting peer\'s subscribed ids, keeps un-subscribed (partial-subscription gap)', async () => {
    writeUniverseState({
      universes: [
        { id: 'u-a', name: 'A', updatedAt: '2026-05-25T10:00:00Z' },
        { id: 'u-b', name: 'B', updatedAt: '2026-05-25T10:00:00Z' },
        { id: 'u-d', name: 'D', updatedAt: '2026-05-25T10:00:00Z' }, // never subscribed
      ],
    });
    // We push u-a + u-b to peer-A per-record; u-d has no sub.
    writePeerSubs([
      { peerId: 'peer-A', recordKind: 'universe', recordId: 'u-a' },
      { peerId: 'peer-A', recordKind: 'universe', recordId: 'u-b' },
    ]);
    const scoped = await dataSync.getSnapshot('universe', { forPeerId: 'peer-A' });
    const ids = scoped.data.universes.map((u) => u.id).sort();
    // Subscribed records excluded; the un-subscribed one still rides.
    expect(ids).toEqual(['u-d']);

    // No forPeerId → full snapshot (legacy / all-or-none common case).
    const full = await dataSync.getSnapshot('universe');
    expect(full.data.universes.map((u) => u.id).sort()).toEqual(['u-a', 'u-b', 'u-d']);
  });

  it('universe: a tombstone for a torn-down sub rides the snapshot (ephemeralize-then-delete, Item B)', async () => {
    // u-x was shared, then marked ephemeral (sub torn down), then deleted →
    // the record is now a tombstone on disk and has NO peer subscription. It
    // must ride the snapshot so the peer converges the delete.
    writeUniverseState({
      universes: [
        { id: 'u-x', name: 'Gone', ephemeral: true, deleted: true, deletedAt: '2026-05-25T11:00:00Z', updatedAt: '2026-05-25T11:00:00Z' },
        { id: 'u-y', name: 'Live', updatedAt: '2026-05-25T10:00:00Z' },
      ],
    });
    // peer-A still subscribes to u-y only (u-x's sub was removed on ephemeralize).
    writePeerSubs([{ peerId: 'peer-A', recordKind: 'universe', recordId: 'u-y' }]);
    const scoped = await dataSync.getSnapshot('universe', { forPeerId: 'peer-A' });
    const byId = Object.fromEntries(scoped.data.universes.map((u) => [u.id, u]));
    // u-y excluded (covered per-record); u-x tombstone present so the delete converges.
    expect(byId['u-y']).toBeUndefined();
    expect(byId['u-x']).toBeDefined();
    expect(byId['u-x'].deleted).toBe(true);
  });

  it('pipeline: excluding a subscribed series ALSO drops its child issues; un-subscribed series + issues ride', async () => {
    writeSeriesState([
      { id: 'ser-sub', name: 'Subbed', updatedAt: '2026-05-25T10:00:00Z' },
      { id: 'ser-free', name: 'Free', updatedAt: '2026-05-25T10:00:00Z' },
    ]);
    writeIssueState([
      { id: 'iss-1', seriesId: 'ser-sub', title: 'child of subbed', updatedAt: '2026-05-25T10:00:00Z' },
      { id: 'iss-2', seriesId: 'ser-free', title: 'child of free', updatedAt: '2026-05-25T10:00:00Z' },
    ]);
    // series → pipeline category; we push ser-sub (+ its issues) per-record.
    writePeerSubs([{ peerId: 'peer-A', recordKind: 'series', recordId: 'ser-sub' }]);
    const scoped = await dataSync.getSnapshot('pipeline', { forPeerId: 'peer-A' });
    expect(scoped.data.series.map((s) => s.id)).toEqual(['ser-free']);
    // iss-1 (child of the excluded series) dropped; iss-2 (free series) rides.
    expect(scoped.data.issues.map((i) => i.id)).toEqual(['iss-2']);
  });

  it('mediaCollections: excludes the requesting peer\'s subscribed collection ids', async () => {
    writeMediaCollections({
      collections: [
        { id: 'col-sub', name: 'Subbed', description: '', coverKey: null, universeId: null, seriesId: null, items: [], createdAt: '2026-05-25T00:00:00Z', updatedAt: '2026-05-25T01:00:00Z' },
        { id: 'col-free', name: 'Free', description: '', coverKey: null, universeId: null, seriesId: null, items: [], createdAt: '2026-05-25T00:00:00Z', updatedAt: '2026-05-25T01:00:00Z' },
      ],
    });
    writePeerSubs([{ peerId: 'peer-A', recordKind: 'mediaCollection', recordId: 'col-sub' }]);
    const scoped = await dataSync.getSnapshot('mediaCollections', { forPeerId: 'peer-A' });
    expect(scoped.data.collections.map((c) => c.id)).toEqual(['col-free']);
  });

  it('subscriptions to a DIFFERENT peer do not scope this peer\'s snapshot (per-peer isolation)', async () => {
    writeUniverseState({
      universes: [{ id: 'u-a', name: 'A', updatedAt: '2026-05-25T10:00:00Z' }],
    });
    // u-a is subscribed to peer-B, but peer-A pulls — peer-A must still get u-a.
    writePeerSubs([{ peerId: 'peer-B', recordKind: 'universe', recordId: 'u-a' }]);
    const scopedForA = await dataSync.getSnapshot('universe', { forPeerId: 'peer-A' });
    expect(scopedForA.data.universes.map((u) => u.id)).toEqual(['u-a']);
    const scopedForB = await dataSync.getSnapshot('universe', { forPeerId: 'peer-B' });
    expect(scopedForB.data.universes.map((u) => u.id)).toEqual([]);
  });

  it('checksum is per-peer: a peer\'s scoped checksum differs once any of its subs exclude a record', async () => {
    // Single universe so the (un-canonicalized) universe snapshot order can't
    // perturb the comparison — a peer that excludes the only record gets an
    // empty snapshot whose checksum necessarily differs from the 1-record one.
    // `createdAt` is set explicitly: without it, sanitizeTemplate backfills
    // `createdAt: now` on every read, making the snapshot non-deterministic
    // across calls (the comparison below relies on byte-stable snapshots).
    writeUniverseState({
      universes: [{ id: 'u-a', name: 'A', createdAt: '2026-05-25T09:00:00Z', updatedAt: '2026-05-25T10:00:00Z' }],
    });
    writePeerSubs([{ peerId: 'peer-A', recordKind: 'universe', recordId: 'u-a' }]);
    const full = await dataSync.getChecksum('universe');
    const scopedA = await dataSync.getChecksum('universe', { forPeerId: 'peer-A' });
    // peer-A's scoped checksum (u-a excluded → empty) differs from the full one.
    expect(scopedA.checksum).not.toBe(full.checksum);
    // A peer with NO subs excludes nothing → its scoped snapshot ids match the
    // full set (checksum equality would also assert ordering, which the
    // universe snapshot doesn't canonicalize — assert on content instead).
    const scopedC = await dataSync.getSnapshot('universe', { forPeerId: 'peer-C' });
    expect(scopedC.data.universes.map((u) => u.id)).toEqual(['u-a']);
  });

  it('checksum cache invalidates when a subscription changes even though no record file moved', async () => {
    // One universe so the empty-vs-present checksum comparison is unambiguous.
    // Explicit `createdAt` keeps the snapshot byte-stable across reads (see the
    // sanitizeTemplate backfill note in the previous test).
    writeUniverseState({
      universes: [{ id: 'u-a', name: 'A', createdAt: '2026-05-25T09:00:00Z', updatedAt: '2026-05-25T10:00:00Z' }],
    });
    writePeerSubs([{ peerId: 'peer-A', recordKind: 'universe', recordId: 'u-a' }]);
    const before = await dataSync.getChecksum('universe', { forPeerId: 'peer-A' });
    // Tear down the sub (ephemeralize-then-delete teardown) — no record file
    // moves, but the exclude-set shrinks so the scoped snapshot now includes
    // u-a again. PEER_SUBSCRIPTIONS_FILE is in CHECKSUM_PATHS, so the cache
    // must invalidate (otherwise the stale empty-snapshot checksum is served).
    await new Promise((r) => setTimeout(r, 5)); // distinct mtime for the subs file
    writePeerSubs([]);
    const after = await dataSync.getChecksum('universe', { forPeerId: 'peer-A' });
    expect(after.checksum).not.toBe(before.checksum);
    // And it now matches the full snapshot (nothing excluded).
    const full = await dataSync.getChecksum('universe');
    expect(after.checksum).toBe(full.checksum);
  });
});

describe('dataSync — videoHistory category', () => {
  const row = (id, overrides = {}) => ({
    id,
    prompt: `prompt ${id}`,
    filename: `${id}.mp4`,
    thumbnail: `${id}.jpg`,
    createdAt: '2026-05-22T00:00:00Z',
    ...overrides,
  });

  it('is registered alongside the other categories', () => {
    expect(dataSync.getSupportedCategories()).toContain('videoHistory');
  });

  it('snapshot returns the videos array under a stable key', async () => {
    writeJSON(VIDEO_HISTORY_PATH, [row('v1'), row('v2')]);
    const snap = await dataSync.getSnapshot('videoHistory');
    expect(snap.data.videos).toHaveLength(2);
    expect(snap.data.videos.map((v) => v.id).sort()).toEqual(['v1', 'v2']);
    expect(snap.checksum).toBeTruthy();
  });

  it('snapshot handles a missing file gracefully', async () => {
    const snap = await dataSync.getSnapshot('videoHistory');
    expect(snap.data.videos).toEqual([]);
    expect(snap.checksum).toBeTruthy();
  });

  it('snapshot includes hidden rows but strips the hidden flag (hide stays local, checksums converge)', async () => {
    // `hidden` is local-only visibility. The row CONTENT must still ride the wire
    // (so the checksum is hide-state-independent and peers converge), but the
    // `hidden` flag itself must be stripped so it doesn't propagate.
    writeJSON(VIDEO_HISTORY_PATH, [row('v1'), row('v-hidden', { hidden: true }), row('v2')]);
    const snap = await dataSync.getSnapshot('videoHistory');
    expect(snap.data.videos.map((v) => v.id).sort()).toEqual(['v1', 'v-hidden', 'v2'].sort());
    expect(snap.data.videos.every((v) => !('hidden' in v))).toBe(true);
  });

  it('snapshot checksum is identical whether or not a row is hidden (convergence across divergent hide-state)', async () => {
    writeJSON(VIDEO_HISTORY_PATH, [row('v1'), row('v2')]);
    const visible = await dataSync.getSnapshot('videoHistory');
    await new Promise((r) => setTimeout(r, 5)); // ensure mtime changes
    writeJSON(VIDEO_HISTORY_PATH, [row('v1'), row('v2', { hidden: true })]);
    const oneHidden = await dataSync.getSnapshot('videoHistory');
    // Two peers that disagree only on v2's hidden flag compute the SAME checksum.
    expect(oneHidden.checksum).toBe(visible.checksum);
  });

  it('applying a remote (hidden-stripped) row does not unhide a locally-hidden row', async () => {
    // The immutable-createdAt LWW merge keeps the existing local row on a tie, so
    // a peer's visible copy of a row the user hid locally must not undo the hide.
    writeJSON(VIDEO_HISTORY_PATH, [row('v1', { hidden: true })]);
    await dataSync.applyRemote('videoHistory', { videos: [row('v1')] }); // remote has no hidden flag
    const persisted = readJSON(VIDEO_HISTORY_PATH);
    expect(persisted.find((v) => v.id === 'v1')?.hidden).toBe(true);
  });

  it('snapshot excludes id-less rows so checksums converge (apply side drops them too)', async () => {
    // An id-less local row can't be merged by applyVideoHistoryRemote, so it
    // MUST be kept off the wire snapshot/checksum — otherwise a receiver that
    // drops it recomputes a different checksum and the peers re-download forever.
    writeJSON(VIDEO_HISTORY_PATH, [row('v1'), { prompt: 'legacy no-id', filename: 'legacy.mp4' }, row('v2')]);
    const snap = await dataSync.getSnapshot('videoHistory');
    expect(snap.data.videos.map((v) => v.id)).toEqual(['v1', 'v2']);
    // Convergence: a fresh receiver applies the wire snapshot onto an empty
    // store, then recomputes its OWN snapshot checksum — it must equal the
    // sender's. If an id-less row had leaked onto the wire, the receiver (which
    // drops it on apply) would compute a different checksum and never converge.
    writeJSON(VIDEO_HISTORY_PATH, []);
    const applied = await dataSync.applyRemote('videoHistory', snap.data);
    expect(applied.applied).toBe(true);
    const receiverSnap = await dataSync.getSnapshot('videoHistory');
    expect(receiverSnap.checksum).toBe(snap.checksum);
  });

  it('snapshot checksum is order-insensitive (rows sorted by id on the wire)', async () => {
    writeJSON(VIDEO_HISTORY_PATH, [row('v-b'), row('v-a')]);
    const a = await dataSync.getSnapshot('videoHistory');
    await new Promise((r) => setTimeout(r, 5)); // ensure mtime changes
    writeJSON(VIDEO_HISTORY_PATH, [row('v-a'), row('v-b')]);
    const b = await dataSync.getSnapshot('videoHistory');
    expect(b.checksum).toBe(a.checksum);
  });

  it('applyRemote inserts new rows (union by id)', async () => {
    writeJSON(VIDEO_HISTORY_PATH, [row('v1')]);
    const result = await dataSync.applyRemote('videoHistory', {
      videos: [row('v2')],
    });
    expect(result.applied).toBe(true);
    expect(result.count).toBe(1);
    const persisted = readJSON(VIDEO_HISTORY_PATH);
    expect(persisted.map((v) => v.id).sort()).toEqual(['v1', 'v2']);
  });

  it('applyRemote keeps local rows the remote does not carry (no data loss)', async () => {
    writeJSON(VIDEO_HISTORY_PATH, [row('local-only'), row('shared')]);
    await dataSync.applyRemote('videoHistory', {
      videos: [row('shared'), row('remote-only')],
    });
    const persisted = readJSON(VIDEO_HISTORY_PATH);
    expect(persisted.map((v) => v.id).sort()).toEqual(['local-only', 'remote-only', 'shared']);
  });

  it('applyRemote LWW: newer remote createdAt wins for the same id', async () => {
    writeJSON(VIDEO_HISTORY_PATH, [row('v1', { createdAt: '2026-05-22T00:00:00Z', prompt: 'old' })]);
    await dataSync.applyRemote('videoHistory', {
      videos: [row('v1', { createdAt: '2026-05-22T05:00:00Z', prompt: 'new' })],
    });
    const persisted = readJSON(VIDEO_HISTORY_PATH);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].prompt).toBe('new');
  });

  it('applyRemote is a no-op when nothing is newer or new', async () => {
    writeJSON(VIDEO_HISTORY_PATH, [row('v1')]);
    const result = await dataSync.applyRemote('videoHistory', { videos: [row('v1')] });
    expect(result.applied).toBe(false);
    expect(result.count).toBe(0);
  });

  it('applyRemote skips rows without a string id (cannot clobber real rows)', async () => {
    writeJSON(VIDEO_HISTORY_PATH, [row('v1')]);
    const result = await dataSync.applyRemote('videoHistory', {
      videos: [{ prompt: 'no id', filename: 'x.mp4', createdAt: '2026-05-22T09:00:00Z' }],
    });
    expect(result.applied).toBe(false);
    const persisted = readJSON(VIDEO_HISTORY_PATH);
    expect(persisted.map((v) => v.id)).toEqual(['v1']);
  });

  it('applyRemote preserves an id-less LOCAL row instead of dropping it', async () => {
    writeJSON(VIDEO_HISTORY_PATH, [{ prompt: 'legacy', filename: 'legacy.mp4' }]);
    await dataSync.applyRemote('videoHistory', { videos: [row('v-new')] });
    const persisted = readJSON(VIDEO_HISTORY_PATH);
    expect(persisted.some((v) => v.prompt === 'legacy')).toBe(true);
    expect(persisted.some((v) => v.id === 'v-new')).toBe(true);
  });

  it('checksum changes after applyRemote mutates the file', async () => {
    writeJSON(VIDEO_HISTORY_PATH, [row('v1')]);
    const before = await dataSync.getChecksum('videoHistory');
    await dataSync.applyRemote('videoHistory', { videos: [row('v2')] });
    const after = await dataSync.getChecksum('videoHistory');
    expect(after.checksum).not.toBe(before.checksum);
  });
});

describe('dataSync — storyBuilder category (#730)', () => {
  const STORY_BUILDER_DIR = join(tempRoot, 'story-builder');
  const session = (id, overrides = {}) => ({
    id,
    title: `Session ${id}`,
    intakeMode: 'seed',
    seedIdea: '',
    universeId: null,
    seriesId: null,
    currentStep: 'idea',
    steps: {},
    llm: { provider: null, model: null },
    sync: true,
    syncedHashes: {},
    origin: null,
    createdAt: '2026-05-22T00:00:00Z',
    updatedAt: '2026-05-22T00:00:00Z',
    ...overrides,
  });
  const writeSessions = (sessions) => writeCollectionState(STORY_BUILDER_DIR, 'storyBuilder', sessions);
  const readSessions = () => readCollectionState(STORY_BUILDER_DIR);

  it('is registered alongside the other categories', () => {
    expect(dataSync.getSupportedCategories()).toContain('storyBuilder');
  });

  it('snapshot includes ONLY sync:true sessions — local-only sessions never cross the wire', async () => {
    writeSessions([session('stb-synced'), session('stb-local', { sync: false })]);
    const snap = await dataSync.getSnapshot('storyBuilder');
    expect(snap.data.sessions.map((s) => s.id)).toEqual(['stb-synced']);
    expect(snap.checksum).toBeTruthy();
  });

  it('snapshot checksum is identical whether or not a local-only session exists (convergence)', async () => {
    writeSessions([session('stb-synced')]);
    const a = await dataSync.getSnapshot('storyBuilder');
    await new Promise((r) => setTimeout(r, 5));
    writeSessions([session('stb-synced'), session('stb-local', { sync: false })]);
    const b = await dataSync.getSnapshot('storyBuilder');
    expect(b.checksum).toBe(a.checksum);
  });

  it('applyRemote inserts a new synced session (union by id)', async () => {
    writeSessions([session('stb-a')]);
    const result = await dataSync.applyRemote('storyBuilder', {
      sessions: [session('stb-b')],
    });
    expect(result.applied).toBe(true);
    expect(readSessions().map((s) => s.id).sort()).toEqual(['stb-a', 'stb-b']);
  });

  it('applyRemote LWW: newer remote wins for the same id', async () => {
    writeSessions([session('stb-a', { title: 'old', updatedAt: '2026-05-22T00:00:00Z' })]);
    await dataSync.applyRemote('storyBuilder', {
      sessions: [session('stb-a', { title: 'new', updatedAt: '2026-05-22T05:00:00Z' })],
    });
    expect(readSessions().find((s) => s.id === 'stb-a').title).toBe('new');
  });

  it('applyRemote refuses to overwrite a LOCAL session the user turned local-only', async () => {
    writeSessions([session('stb-a', { sync: false, title: 'local wins' })]);
    const result = await dataSync.applyRemote('storyBuilder', {
      sessions: [session('stb-a', { title: 'peer wins?', updatedAt: '2030-01-01T00:00:00Z' })],
    });
    expect(result.applied).toBe(false);
    const got = readSessions().find((s) => s.id === 'stb-a');
    expect(got.sync).toBe(false);
    expect(got.title).toBe('local wins');
  });

  it('round-trips: a fresh receiver applying the wire snapshot recomputes the same checksum', async () => {
    writeSessions([session('stb-a'), session('stb-b'), session('stb-local', { sync: false })]);
    const snap = await dataSync.getSnapshot('storyBuilder');
    // Fresh receiver: empty store, apply, recompute.
    rmSync(STORY_BUILDER_DIR, { recursive: true, force: true });
    writeSessions([]);
    const applied = await dataSync.applyRemote('storyBuilder', snap.data);
    expect(applied.applied).toBe(true);
    const receiverSnap = await dataSync.getSnapshot('storyBuilder');
    expect(receiverSnap.checksum).toBe(snap.checksum);
  });

  it('does NOT block a storyBuilder snapshot when the sender is ahead on universes (per-category gate)', async () => {
    writeSessions([]);
    const result = await dataSync.applyRemote('storyBuilder', {
      sessions: [session('stb-a')],
    }, { portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 6, storyBuilder: 1 } } });
    expect(result.blockedBySchema).toBeUndefined();
    expect(result.applied).toBe(true);
  });

  it('STILL blocks a storyBuilder snapshot when the sender is ahead on storyBuilder', async () => {
    writeSessions([]);
    const result = await dataSync.applyRemote('storyBuilder', {
      sessions: [session('stb-a')],
    }, { portosMeta: { portosVersion: '99.0.0', schemaVersions: { storyBuilder: 2 } } });
    expect(result.applied).toBe(false);
    expect(result.blockedBySchema).toBeDefined();
    expect(result.blockedBySchema.ahead).toEqual([
      { category: 'storyBuilder', senderV: 2, receiverV: 1 },
    ]);
    expect(readSessions()).toEqual([]);
  });
});

describe('dataSync — per-category schema gate (cross-key isolation)', () => {
  // A sender always stamps its FULL schemaVersions map (buildPortosMeta spreads
  // PORTOS_SCHEMA_VERSIONS). The old whole-payload gate rejected EVERY category
  // when the sender was ahead on ANY one of them. These tests pin the new
  // per-category behavior: an ahead-mismatch only gates the category whose
  // storage layout that snapshot actually writes.
  const aheadOnUniverses = {
    portosVersion: '99.0.0',
    schemaVersions: { universes: 6, pipelineSeries: 1, pipelineIssues: 1, mediaCollections: 1 },
  };

  it('does NOT block a videoHistory snapshot when the sender is ahead on universes', async () => {
    // videoHistory has no versioned storage layout, so it must keep syncing
    // even from a sender on a newer universes layout. This is the exact latent
    // bug the per-category gate fixes (the old union gate rejected it).
    writeJSON(VIDEO_HISTORY_PATH, []);
    const result = await dataSync.applyRemote('videoHistory', {
      videos: [{ id: 'v1', prompt: 'p', filename: 'v1.mp4', createdAt: '2026-05-22T00:00:00Z' }],
    }, { portosMeta: aheadOnUniverses });
    expect(result.blockedBySchema).toBeUndefined();
    expect(result.applied).toBe(true);
  });

  it('does NOT block a pipeline snapshot when the sender is ahead on universes', async () => {
    writeSeriesState([]);
    writeIssueState([]);
    const result = await dataSync.applyRemote('pipeline', {
      series: [{ id: 'ser-1', name: 'Foundry', updatedAt: '2026-05-17T11:00:00Z' }],
      issues: [],
    }, { portosMeta: aheadOnUniverses });
    expect(result.blockedBySchema).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(readSeriesState().find((s) => s.id === 'ser-1')).toBeTruthy();
  });

  it('does NOT block a mediaCollections snapshot when the sender is ahead on universes', async () => {
    writeMediaCollections({ collections: [] });
    const result = await dataSync.applyRemote('mediaCollections', {
      collections: [{
        id: 'c-new', name: 'New', description: '', coverKey: null, universeId: null, seriesId: null,
        items: [], createdAt: '2026-05-22T00:00:00Z', updatedAt: '2026-05-22T01:00:00Z',
      }],
    }, { portosMeta: aheadOnUniverses });
    expect(result.blockedBySchema).toBeUndefined();
    expect(result.applied).toBe(true);
  });

  it('does NOT block a universe snapshot when the sender is ahead on mediaCollections only', async () => {
    writeUniverseState({ universes: [], runs: [] });
    const result = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u-new', name: 'Foundry', updatedAt: '2026-05-17T10:00:00Z' }],
    }, { portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 5, mediaCollections: 2 } } });
    expect(result.blockedBySchema).toBeUndefined();
    expect(result.applied).toBe(true);
  });

  it('STILL blocks a pipeline snapshot when the sender is ahead on pipelineSeries (relevant category)', async () => {
    writeSeriesState([]);
    writeIssueState([]);
    const result = await dataSync.applyRemote('pipeline', {
      series: [{ id: 'ser-1', name: 'Foundry', updatedAt: '2026-05-17T11:00:00Z' }],
      issues: [],
    }, { portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 5, pipelineSeries: SENDER_AHEAD_PIPELINE_SERIES_V, pipelineIssues: 1, mediaCollections: 1 } } });
    expect(result.applied).toBe(false);
    expect(result.blockedBySchema).toBeDefined();
    // The reported gap is scoped to the relevant category — NOT mis-attributed.
    expect(result.blockedBySchema.ahead).toEqual([
      { category: 'pipelineSeries', senderV: SENDER_AHEAD_PIPELINE_SERIES_V, receiverV: RECEIVER_PIPELINE_SERIES_V },
    ]);
    expect(readSeriesState()).toEqual([]); // nothing written
  });

  // ---- gate-map completeness (fail-open guard) -------------------------
  it('every snapshot category has a deliberate schema-key mapping', () => {
    // No `|| []` fallthrough surprises: a future category must be mapped
    // explicitly (even to []) so the gate decision for it is intentional.
    const map = dataSync.getSnapshotCategorySchemaKeys();
    for (const category of dataSync.getSupportedCategories()) {
      expect(Array.isArray(map[category])).toBe(true);
    }
  });

  it('every versioned PORTOS_SCHEMA_VERSIONS key is reachable from some snapshot category', () => {
    // A newly-versioned category can't ship without being wired into the
    // per-category snapshot gate — otherwise its snapshot transfer is ungated.
    //
    // EXCEPTION: a few keys move via dedicated out-of-band sync endpoints
    // (Postgres-backed federation), not the file-snapshot transfer. Those
    // are gated at their own apply path with `compareSchemaVersions` and
    // need not appear in the snapshot map. List them here so the coverage
    // assertion stays honest about what the snapshot map IS and ISN'T
    // responsible for.
    const OUT_OF_BAND_SYNC_KEYS = new Set([
      // catalog → `POST /api/catalog/sync/apply` (server/services/catalogSync.js)
      'catalog',
      // authors → per-record peer-push only (no 60s file-snapshot category).
      // Gated at applyIncomingPush via compareSchemaVersions / RECORD_KIND_SCHEMA_CATEGORIES.author.
      'authors',
      // music records → per-record peer-push only (no 60s file-snapshot category).
      // Gated at applyIncomingPush via compareSchemaVersions / RECORD_KIND_SCHEMA_CATEGORIES.
      'artists',
      'albums',
      'tracks',
      // Creative Director projects (#1564) → per-record peer-push only (no 60s
      // file-snapshot category). Gated at applyIncomingPush via
      // compareSchemaVersions / RECORD_KIND_SCHEMA_CATEGORIES.creativeDirectorProject.
      'creativeDirectorProjects',
      // Mood boards (#1564) → per-record peer-push only (no 60s file-snapshot
      // category). Gated at applyIncomingPush via compareSchemaVersions /
      // RECORD_KIND_SCHEMA_CATEGORIES.moodBoard.
      'moodBoards',
      // Writers Room works (#1565) → per-record peer-push only (no 60s
      // file-snapshot category; the .md prose bodies ride a dedicated body
      // manifest). Gated at applyIncomingPush via compareSchemaVersions /
      // RECORD_KIND_SCHEMA_CATEGORIES.writersRoomWork.
      'writersRoomWorks',
      // Writers Room folders + exercises (#1645) → per-record peer-push only (no
      // 60s file-snapshot category; both are body-less). Gated at
      // applyIncomingPush via compareSchemaVersions /
      // RECORD_KIND_SCHEMA_CATEGORIES.writersRoomFolder / .writersRoomExercise.
      'writersRoomFolders',
      'writersRoomExercises',
      // Music Video projects (#1770) → per-record peer-push only (no 60s
      // file-snapshot category). Gated at applyIncomingPush via
      // compareSchemaVersions / RECORD_KIND_SCHEMA_CATEGORIES.musicVideoProject.
      'musicVideoProjects',
      // Creative Commission feedback (#2686) → per-record peer-push only (no 60s
      // file-snapshot category). Gated at applyIncomingPush via
      // compareSchemaVersions / RECORD_KIND_SCHEMA_CATEGORIES.commissionFeedback.
      'commissionFeedback',
      // Creative Commission brief (#2686) → per-record peer-push only (no 60s
      // file-snapshot category). Gated at applyIncomingPush via
      // compareSchemaVersions / RECORD_KIND_SCHEMA_CATEGORIES.creativeCommission.
      'creativeCommissions',
      // Standalone media library (#1566) → its own receiver-pull endpoint
      // (GET /api/peer-sync/library-manifest), NOT the file-snapshot transfer.
      // Versioned for the manifest envelope and gated by syncMediaLibraryFromPeer's
      // gentle skip-if-ahead; declared non-record in NON_RECORD_SCHEMA_CATEGORIES.
      'mediaLibrary',
      // Completed-agent CoS history (#1650) → its own receiver-pull endpoint
      // (GET /api/peer-sync/cos-history-manifest), NOT the file-snapshot transfer.
      // Versioned for the manifest envelope and gated by syncCosHistoryFromPeer's
      // gentle skip-if-ahead; declared non-record in NON_RECORD_SCHEMA_CATEGORIES.
      'cosHistory',
      // Live CoS task list + claim metadata (#1712) → its own receiver-pull
      // endpoint (GET /api/peer-sync/cos-tasks) with a claim-aware per-task merge,
      // NOT the file-snapshot transfer. Versioned for the payload envelope and
      // gated by syncCosTasksFromPeer's gentle skip-if-ahead; declared non-record
      // in NON_RECORD_SCHEMA_CATEGORIES.
      'cosTasks',
    ]);
    const covered = new Set(Object.values(dataSync.getSnapshotCategorySchemaKeys()).flat());
    for (const key of Object.keys(PORTOS_SCHEMA_VERSIONS)) {
      if (OUT_OF_BAND_SYNC_KEYS.has(key)) continue;
      expect(covered.has(key)).toBe(true);
    }
  });
});
