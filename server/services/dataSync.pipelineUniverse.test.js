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
    writeJSON(UNIVERSE_PATH, {
      universes: [],
      runs: [{ id: 'r1', kind: 'expand' }]
    });
    await dataSync.applyRemote('universe', {
      universes: [{ id: 'u1', name: 'X', updatedAt: '2026-05-17T10:00:00Z' }]
    });
    const persisted = readJSON(UNIVERSE_PATH);
    expect(persisted.runs).toEqual([{ id: 'r1', kind: 'expand' }]);
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

  it('applyRemote merges series + issues and reports total applied', async () => {
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

    const persistedSeries = readJSON(SERIES_PATH).series;
    expect(persistedSeries).toHaveLength(2);
    expect(persistedSeries.find(s => s.id === 'ser-1').name).toBe('New'); // LWW
    expect(persistedSeries.find(s => s.id === 'ser-2').name).toBe('Foundry');

    const persistedIssues = readJSON(ISSUES_PATH).issues;
    expect(persistedIssues).toHaveLength(1);
    expect(persistedIssues[0].seriesId).toBe('ser-2');
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

    // Only issues change.
    await dataSync.applyRemote('pipeline', {
      series: [{ id: 'ser-1', updatedAt: '2026-05-17T09:00:00Z' }], // older → skipped
      issues: [{ id: 'iss-new', seriesId: 'ser-1', updatedAt: '2026-05-17T11:00:00Z' }]
    });

    // Series file untouched (no incidental rewrite that could clobber a
    // concurrent write outside the sync orchestrator).
    expect(readJSON(SERIES_PATH).series[0].updatedAt).toBe('2026-05-17T10:00:00Z');
    expect(readJSON(ISSUES_PATH).issues).toHaveLength(1);
  });
});
