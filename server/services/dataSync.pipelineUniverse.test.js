/**
 * Tests for the `pipeline` and `universe` sync categories added in PR
 * [extend-syncorchestrator-to-cover-pipeline-universe].
 *
 * Covers: snapshot shape, checksum stability across no-op reads, array-by-id
 * LWW merge for series/issues/universes, no-blob coverage (the sync is
 * record-level only — images and videos flow through the sharing system).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-datasync-piuni-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

afterAll(cleanup);

const dataSync = await import('./dataSync.js');

const SERIES_PATH = join(tempRoot, 'pipeline-series.json');
const ISSUES_PATH = join(tempRoot, 'pipeline-issues.json');
const UNIVERSE_PATH = join(tempRoot, 'universe-builder.json');

function writeJSON(path, obj) {
  mkdirSync(tempRoot, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
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
    writeJSON(UNIVERSE_PATH, {
      universes: [{ id: 'u1', name: 'Salt', updatedAt: '2026-05-17T10:00:00Z' }],
      runs: [{ id: 'r1', logs: ['ephemeral'] }]
    });
    const snap = await dataSync.getSnapshot('universe');
    expect(snap.data.universes).toHaveLength(1);
    expect(snap.data.universes[0].id).toBe('u1');
    expect(snap.data.runs).toBeUndefined();
    expect(snap.checksum).toBeTruthy();
  });

  it('snapshot checksum is stable across reads when state is unchanged', async () => {
    writeJSON(UNIVERSE_PATH, { universes: [{ id: 'u1', updatedAt: '2026-05-17T10:00:00Z' }] });
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
    writeJSON(UNIVERSE_PATH, { universes: [], runs: [] });
    const result = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u-new', name: 'Foundry', updatedAt: '2026-05-17T10:00:00Z' }]
    });
    expect(result.applied).toBe(true);
    expect(result.count).toBe(1);
    const persisted = readJSON(UNIVERSE_PATH);
    expect(persisted.universes).toHaveLength(1);
    expect(persisted.universes[0].id).toBe('u-new');
    // Local-only `runs` must survive the merge.
    expect(persisted.runs).toEqual([]);
  });

  it('applyRemote LWW: newer remote wins, older remote is dropped', async () => {
    writeJSON(UNIVERSE_PATH, {
      universes: [{ id: 'u1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }]
    });
    const result = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u1', name: 'New', updatedAt: '2026-05-17T11:00:00Z' }]
    });
    expect(result.applied).toBe(true);
    expect(readJSON(UNIVERSE_PATH).universes[0].name).toBe('New');

    // Replay older — should NOT clobber.
    const replay = await dataSync.applyRemote('universe', {
      universes: [{ id: 'u1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }]
    });
    expect(replay.applied).toBe(false);
    expect(readJSON(UNIVERSE_PATH).universes[0].name).toBe('New');
  });

  it('applyRemote preserves local-only `runs[]` when only universes change', async () => {
    // Runs need a valid shape — `sanitizeRun` requires id + universeId since
    // the merge now routes through the service-level entry point that
    // sanitizes every read.
    const localRun = {
      id: 'r1', universeId: 'u-local', collectionId: null,
      jobIds: [], promptCount: 0, createdAt: '2026-05-17T09:00:00Z',
    };
    writeJSON(UNIVERSE_PATH, { universes: [], runs: [localRun] });
    await dataSync.applyRemote('universe', {
      universes: [{ id: 'u1', name: 'X', updatedAt: '2026-05-17T10:00:00Z' }]
    });
    const persisted = readJSON(UNIVERSE_PATH);
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0].id).toBe('r1');
    expect(persisted.runs[0].universeId).toBe('u-local');
  });
});

describe('dataSync — pipeline category', () => {
  it('snapshot bundles series + issues from their respective files', async () => {
    writeJSON(SERIES_PATH, {
      series: [{ id: 'ser-1', name: 'A', updatedAt: '2026-05-17T10:00:00Z' }]
    });
    writeJSON(ISSUES_PATH, {
      issues: [{ id: 'iss-1', seriesId: 'ser-1', title: 'One', updatedAt: '2026-05-17T10:00:00Z' }]
    });
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
    writeJSON(SERIES_PATH, { series: [{ id: 'ser-1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }] });
    writeJSON(ISSUES_PATH, { issues: [] });

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

    const persistedSeries = readJSON(SERIES_PATH).series;
    expect(persistedSeries).toHaveLength(2);
    expect(persistedSeries.find(s => s.id === 'ser-1').name).toBe('New'); // LWW
    expect(persistedSeries.find(s => s.id === 'ser-2').name).toBe('Foundry');

    const persistedIssues = readJSON(ISSUES_PATH).issues;
    expect(persistedIssues).toHaveLength(1);
    expect(persistedIssues[0].seriesId).toBe('ser-2');
  });

  it('applyRemote count reports only the changed side when only series differs', async () => {
    writeJSON(SERIES_PATH, { series: [{ id: 'ser-1', name: 'Old', updatedAt: '2026-05-17T10:00:00Z' }] });
    // Local issues exist but won't change — sync must not inflate count to
    // include them (the pre-fix bug counted total post-merge issues).
    writeJSON(ISSUES_PATH, { issues: [{ id: 'iss-1', seriesId: 'ser-1', title: 'Local', updatedAt: '2026-05-17T10:00:00Z' }] });

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
    writeJSON(SERIES_PATH, { series: [{ id: 'ser-1', updatedAt: '2026-05-17T10:00:00Z' }] });
    writeJSON(ISSUES_PATH, { issues: [{ id: 'iss-1', updatedAt: '2026-05-17T10:00:00Z' }] });

    const before = readJSON(SERIES_PATH);
    const result = await dataSync.applyRemote('pipeline', {
      series: [{ id: 'ser-1', updatedAt: '2026-05-17T10:00:00Z' }], // same ts
      issues: [{ id: 'iss-1', updatedAt: '2026-05-17T09:00:00Z' }]  // older
    });
    expect(result.applied).toBe(false);
    expect(result.count).toBe(0);
    expect(readJSON(SERIES_PATH)).toEqual(before);
  });

  it('applyRemote skips writes for unchanged sides (writes only what differs)', async () => {
    writeJSON(SERIES_PATH, { series: [{ id: 'ser-1', updatedAt: '2026-05-17T10:00:00Z' }] });
    writeJSON(ISSUES_PATH, { issues: [] });

    // Only issues change. Use a valid issue payload (id + seriesId + title)
    // since the merge now routes through sanitizeIssue.
    await dataSync.applyRemote('pipeline', {
      series: [{ id: 'ser-1', updatedAt: '2026-05-17T09:00:00Z' }], // older → skipped
      issues: [{ id: 'iss-new', seriesId: 'ser-1', title: 'New Issue', updatedAt: '2026-05-17T11:00:00Z' }]
    });

    // Series file untouched (no incidental rewrite that could clobber a
    // concurrent write outside the sync orchestrator).
    expect(readJSON(SERIES_PATH).series[0].updatedAt).toBe('2026-05-17T10:00:00Z');
    expect(readJSON(ISSUES_PATH).issues).toHaveLength(1);
  });
});

describe('dataSync — getChecksum cache', () => {
  it('returns the same checksum across consecutive calls and matches getSnapshot', async () => {
    writeJSON(UNIVERSE_PATH, {
      universes: [{ id: 'u1', name: 'A', updatedAt: '2026-05-17T10:00:00Z' }],
    });
    const c1 = await dataSync.getChecksum('universe');
    const c2 = await dataSync.getChecksum('universe');
    const snap = await dataSync.getSnapshot('universe');
    expect(c1.checksum).toBe(c2.checksum);
    expect(c1.checksum).toBe(snap.checksum);
  });

  it('invalidates the cache after applyRemote bumps the underlying file mtime', async () => {
    writeJSON(UNIVERSE_PATH, {
      universes: [{ id: 'u1', name: 'A', updatedAt: '2026-05-17T10:00:00Z' }],
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
    writeJSON(SERIES_PATH, { series: [{ id: 'ser-1', updatedAt: '2026-05-17T10:00:00Z' }] });
    writeJSON(ISSUES_PATH, { issues: [] });
    const before = await dataSync.getChecksum('pipeline');
    // Force a different mtime — vitest can run faster than the FS's ms tick,
    // so wait long enough that the mtime is guaranteed to advance.
    await new Promise((r) => setTimeout(r, 5));
    writeJSON(SERIES_PATH, { series: [{ id: 'ser-1', updatedAt: '2026-05-17T11:00:00Z' }] });
    const after = await dataSync.getChecksum('pipeline');
    expect(after.checksum).not.toBe(before.checksum);
  });
});
