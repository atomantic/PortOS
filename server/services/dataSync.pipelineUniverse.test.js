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

const SERIES_DIR = join(tempRoot, 'pipeline-series');
const ISSUES_DIR = join(tempRoot, 'pipeline-issues');
const UNIVERSES_DIR = join(tempRoot, 'universes');
const MEDIA_COLLECTIONS_PATH = join(tempRoot, 'media-collections.json');

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
    expect(snap.portosMeta.schemaVersions.universes).toBe(5);
  });

  it('applyRemote rejects when sender schemaVersions are AHEAD of local code', async () => {
    writeUniverseState({ universes: [], runs: [] });
    const result = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u-new', name: 'Foundry', updatedAt: '2026-05-17T10:00:00Z' }],
    }, { portosMeta: { portosVersion: '99.0.0', schemaVersions: { universes: 6 } } });
    expect(result.applied).toBe(false);
    expect(result.count).toBe(0);
    expect(result.blockedBySchema).toBeDefined();
    expect(result.blockedBySchema.ahead).toEqual([
      { category: 'universes', senderV: 6, receiverV: 5 },
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
    writeJSON(MEDIA_COLLECTIONS_PATH, {
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
    writeJSON(MEDIA_COLLECTIONS_PATH, {
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
    writeJSON(MEDIA_COLLECTIONS_PATH, { collections: [] });
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
    const persisted = readJSON(MEDIA_COLLECTIONS_PATH);
    expect(persisted.collections).toHaveLength(1);
    expect(persisted.collections[0].id).toBe('c-new');
  });

  it('applyRemote unions items by kind:ref — never loses a render', async () => {
    writeJSON(MEDIA_COLLECTIONS_PATH, {
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
    const persisted = readJSON(MEDIA_COLLECTIONS_PATH);
    const refs = persisted.collections[0].items.map(i => i.ref).sort();
    expect(refs).toEqual(['local.png', 'remote.png']);
  });

  it('checksum changes after applyRemote bumps file mtime', async () => {
    writeJSON(MEDIA_COLLECTIONS_PATH, {
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
    writeJSON(MEDIA_COLLECTIONS_PATH, {
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
    writeJSON(MEDIA_COLLECTIONS_PATH, {
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
