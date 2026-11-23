/**
 * Time capsule snapshot store — corrupt/missing files must not crash ops (#7010).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-time-capsule-') }));

const { PATHS } = await import('../lib/fileUtils.js');
const {
  listSnapshots,
  createSnapshot,
  getSnapshot,
  deleteSnapshot,
  compareSnapshots,
  stripGenomeFromSnapshots,
} = await import('./timeCapsule.js');

const twinDir = () => PATHS.digitalTwin;
const snapshotsDir = () => join(twinDir(), 'snapshots');
const indexPath = () => join(snapshotsDir(), 'index.json');

function resetTwinDir() {
  rmSync(twinDir(), { recursive: true, force: true });
  mkdirSync(twinDir(), { recursive: true });
}

function writeTwinJson(name, value) {
  writeFileSync(join(twinDir(), name), typeof value === 'string' ? value : JSON.stringify(value));
}

function readIndex() {
  return JSON.parse(readFileSync(indexPath(), 'utf-8'));
}

beforeAll(() => {
  resetTwinDir();
});

beforeEach(() => {
  resetTwinDir();
});

afterAll(() => cleanupTempDataRoots());

describe('listSnapshots', () => {
  it('returns an empty list when the index file is missing', async () => {
    await expect(listSnapshots()).resolves.toEqual([]);
  });

  it('returns an empty list when the index file is empty', async () => {
    mkdirSync(snapshotsDir(), { recursive: true });
    writeFileSync(indexPath(), '');
    await expect(listSnapshots()).resolves.toEqual([]);
  });

  it('returns an empty list when the index file is invalid JSON', async () => {
    mkdirSync(snapshotsDir(), { recursive: true });
    writeFileSync(indexPath(), '{not-json');
    await expect(listSnapshots()).resolves.toEqual([]);
  });

  it('returns an empty list when snapshots is not an array', async () => {
    mkdirSync(snapshotsDir(), { recursive: true });
    writeFileSync(indexPath(), JSON.stringify({ snapshots: 'nope' }));
    await expect(listSnapshots()).resolves.toEqual([]);
  });

  it('rebuilds the listing from on-disk snapshot files when the index is corrupt', async () => {
    mkdirSync(snapshotsDir(), { recursive: true });
    const kept = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      label: 'kept',
      createdAt: '2026-01-02T00:00:00.000Z',
      data: { 'identity.json': { name: 'Example Twin' } },
    };
    writeFileSync(join(snapshotsDir(), `${kept.id}.json`), JSON.stringify(kept));
    writeFileSync(indexPath(), '{truncated');

    const listed = await listSnapshots();
    expect(listed).toEqual([{
      id: kept.id,
      label: 'kept',
      createdAt: kept.createdAt,
    }]);
  });
});

describe('createSnapshot', () => {
  it('omits a malformed twin JSON file and still writes the snapshot', async () => {
    writeTwinJson('identity.json', { name: 'Example Twin' });
    writeTwinJson('goals.json', '{truncated');
    writeTwinJson('notes.md', '# Notes');

    const snapshot = await createSnapshot('baseline', 'first capture');

    expect(snapshot.label).toBe('baseline');
    expect(snapshot.summary.hasIdentity).toBe(true);
    expect(snapshot.summary.goalsCount).toBe(0);
    expect(snapshot.summary.markdownFiles).toBe(1);

    const stored = await getSnapshot(snapshot.id);
    expect(stored.data['identity.json']).toEqual({ name: 'Example Twin' });
    expect(stored.data['goals.json']).toBeUndefined();
    expect(stored.data.documents['notes.md']).toBe('# Notes');
    expect(readIndex().snapshots).toHaveLength(1);
  });

  it('recovers from a corrupt index instead of crashing', async () => {
    mkdirSync(snapshotsDir(), { recursive: true });
    writeFileSync(indexPath(), '');
    writeTwinJson('identity.json', { name: 'Example Twin' });

    const snapshot = await createSnapshot('recovered');
    expect(snapshot.id).toBeTruthy();
    expect(readIndex().snapshots.map(s => s.id)).toEqual([snapshot.id]);
  });

  it('keeps prior snapshot files in the index when creating after corruption', async () => {
    mkdirSync(snapshotsDir(), { recursive: true });
    const kept = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      label: 'kept',
      createdAt: '2026-01-01T00:00:00.000Z',
      data: { 'identity.json': { name: 'Example Twin' } },
    };
    writeFileSync(join(snapshotsDir(), `${kept.id}.json`), JSON.stringify(kept));
    writeFileSync(indexPath(), '{truncated');
    writeTwinJson('identity.json', { name: 'Example Twin' });

    const snapshot = await createSnapshot('after-corrupt');
    expect(readIndex().snapshots.map(s => s.id).sort()).toEqual([kept.id, snapshot.id].sort());
  });

  it('skips a markdown directory that would fail a TOCTOU stat-then-read', async () => {
    mkdirSync(join(twinDir(), 'journal.md'), { recursive: true });
    writeTwinJson('identity.json', { name: 'Example Twin' });

    const snapshot = await createSnapshot('no-md-dir');
    expect(snapshot.summary.markdownFiles).toBe(0);
    expect((await getSnapshot(snapshot.id)).data.documents).toBeUndefined();
  });

  it('keeps both snapshots when two creates overlap', async () => {
    writeTwinJson('identity.json', { name: 'Example Twin' });
    const [a, b] = await Promise.all([
      createSnapshot('one'),
      createSnapshot('two'),
    ]);
    const listed = await listSnapshots();
    expect(listed).toHaveLength(2);
    expect(listed.map(s => s.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('genome capture', () => {
  const meatspaceGenomePath = () => join(PATHS.meatspace, 'genome.json');
  beforeEach(() => {
    rmSync(meatspaceGenomePath(), { force: true });
  });
  const writeMeatspaceGenome = (value) => {
    mkdirSync(PATHS.meatspace, { recursive: true });
    writeFileSync(meatspaceGenomePath(), JSON.stringify(value));
  };

  it('captures only aggregate genome summary counts and omits raw savedMarkers and filename', async () => {
    writeMeatspaceGenome({
      uploaded: true,
      uploadedAt: '2026-01-01T00:00:00.000Z',
      filename: 'private-23andme-export.txt',
      snpCount: 500000,
      build: 'Build 37',
      lastScanAt: '2026-01-02T00:00:00.000Z',
      savedMarkers: {
        rs1: { rsid: 'rs1', genotype: 'GG', status: 'beneficial', notes: 'private-note' },
        rs2: { rsid: 'rs2', genotype: 'CT', status: 'concern' }
      }
    });

    const snapshot = await createSnapshot('with genome');

    expect(snapshot.summary.genomeMarkers).toBe(2);
    const stored = await getSnapshot(snapshot.id);
    expect(stored.data['genome.json']).toEqual({
      uploaded: true,
      uploadedAt: '2026-01-01T00:00:00.000Z',
      snpCount: 500000,
      build: 'Build 37',
      markerCount: 2,
      statusCounts: { beneficial: 1, typical: 0, concern: 1, major_concern: 0, not_found: 0 },
      lastScanAt: '2026-01-02T00:00:00.000Z'
    });
    expect(stored.data['genome.json'].savedMarkers).toBeUndefined();
    expect(stored.data['genome.json'].filename).toBeUndefined();
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain('private-23andme-export.txt');
    expect(raw).not.toContain('private-note');
    expect(raw).not.toContain('rs1');
  });

  it('records zero genome markers when no genome file exists', async () => {
    const snapshot = await createSnapshot('no genome');

    expect(snapshot.summary.genomeMarkers).toBe(0);
    const stored = await getSnapshot(snapshot.id);
    expect(stored.data['genome.json']).toBeUndefined();
  });

  it('reports a genome marker change between snapshots taken before and after upload', async () => {
    const before = await createSnapshot('before upload');
    writeMeatspaceGenome({ savedMarkers: { rs1: { id: 'rs1' } } });
    const after = await createSnapshot('after upload');

    const diff = await compareSnapshots(before.id, after.id);

    expect(diff.changes).toContainEqual({ field: 'Genome markers', before: 0, after: 1 });
  });

  it('stripGenomeFromSnapshots returns zero without creating snapshots dir when absent', async () => {
    await expect(stripGenomeFromSnapshots()).resolves.toEqual({ updated: 0 });
    expect(existsSync(snapshotsDir())).toBe(false);
  });

  it('stripGenomeFromSnapshots scrubs genetic fields, updates index metadata, and is idempotent', async () => {
    writeTwinJson('identity.json', { name: 'Example Twin' });
    writeTwinJson('chronotype.json', {
      type: 'morning',
      geneticMarkers: { mtnr1b: { rsid: 'rs4753426', genotype: 'GG', status: 'concern' } },
      caffeineMarkers: { cyp1a2: { rsid: 'rs762551', genotype: 'AA', status: 'beneficial' } },
      behavioralData: { preferredWakeTime: '06:30' }
    });
    writeTwinJson('longevity.json', {
      longevityMarkers: { foxo3a: { rsid: 'rs2802292', genotype: 'GG', status: 'beneficial' } },
      cardiovascularMarkers: { cad9p21: { rsid: 'rs1333049', genotype: 'CC', status: 'concern' } }
    });
    writeTwinJson('goals.json', {
      birthDate: '2000-01-01',
      goals: [{ id: 'g1', title: 'Read more' }],
      lifeExpectancy: { adjusted: 85 },
      timeHorizons: { yearsRemaining: 59 }
    });
    writeMeatspaceGenome({ uploaded: true, savedMarkers: { rs1: { rsid: 'rs1', status: 'typical' } } });

    const snap = await createSnapshot('pre-delete');
    const beforeHash = snap.dataHash;
    const beforeSize = snap.sizeBytes;

    await expect(stripGenomeFromSnapshots()).resolves.toEqual({ updated: 1 });

    const after = await getSnapshot(snap.id);
    expect(after.data['genome.json']).toBeUndefined();
    expect(after.data['chronotype.json'].geneticMarkers).toEqual({});
    expect(after.data['chronotype.json'].caffeineMarkers).toEqual({});
    expect(after.data['chronotype.json'].behavioralData).toEqual({ preferredWakeTime: '06:30' });
    expect(after.data['longevity.json'].longevityMarkers).toEqual({});
    expect(after.data['longevity.json'].cardiovascularMarkers).toEqual({});
    expect(after.data['goals.json'].lifeExpectancy).toBeNull();
    expect(after.data['goals.json'].timeHorizons).toBeNull();
    expect(after.data['goals.json'].goals).toEqual([{ id: 'g1', title: 'Read more' }]);
    expect(after.summary.genomeMarkers).toBe(0);
    expect(after.dataHash).not.toBe(beforeHash);
    expect(after.sizeBytes).toBeLessThan(beforeSize);

    const [indexed] = await listSnapshots();
    expect(indexed.summary.genomeMarkers).toBe(0);
    expect(indexed.dataHash).toBe(after.dataHash);
    expect(indexed.sizeBytes).toBe(after.sizeBytes);

    // Second pass is a no-op.
    await expect(stripGenomeFromSnapshots()).resolves.toEqual({ updated: 0 });
  });

  it('stripGenomeFromSnapshots rebuilds a corrupt index from scrubbed snapshot files', async () => {
    writeMeatspaceGenome({ uploaded: true, savedMarkers: { rs1: { rsid: 'rs1', status: 'typical' } } });
    const snap = await createSnapshot('corrupt-index-case');
    writeFileSync(indexPath(), '{truncated');

    await expect(stripGenomeFromSnapshots()).resolves.toEqual({ updated: 1 });
    const listed = await listSnapshots();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(snap.id);
    expect(listed[0].summary.genomeMarkers).toBe(0);
  });

  it('stripGenomeFromSnapshots fails closed on an unreadable snapshot without mutating others', async () => {
    writeMeatspaceGenome({ uploaded: true, savedMarkers: { rs1: { rsid: 'rs1', status: 'typical' } } });
    const snap = await createSnapshot('valid-snap');
    writeFileSync(join(snapshotsDir(), 'broken.json'), '{truncated');

    await expect(stripGenomeFromSnapshots()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
    expect((await getSnapshot(snap.id)).summary.genomeMarkers).toBe(1);
  });
});

describe('getSnapshot / deleteSnapshot', () => {
  it('returns null for a corrupt snapshot file instead of throwing', async () => {
    mkdirSync(snapshotsDir(), { recursive: true });
    writeFileSync(join(snapshotsDir(), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json'), '{nope');
    await expect(getSnapshot('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).resolves.toBeNull();
  });

  it('deletes from a recovered empty index without throwing', async () => {
    mkdirSync(snapshotsDir(), { recursive: true });
    writeFileSync(indexPath(), '{truncated');
    await expect(deleteSnapshot('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).resolves.toBe(false);
  });

  it('removes a snapshot from the index and disk', async () => {
    writeTwinJson('identity.json', { name: 'Example Twin' });
    const snapshot = await createSnapshot('keep-me');
    expect(existsSync(join(snapshotsDir(), `${snapshot.id}.json`))).toBe(true);

    await expect(deleteSnapshot(snapshot.id)).resolves.toBe(true);
    await expect(listSnapshots()).resolves.toEqual([]);
    expect(existsSync(join(snapshotsDir(), `${snapshot.id}.json`))).toBe(false);
  });

  it('keeps a failed deletion visible and retryable, while tolerating an already missing file', async () => {
    const snapshot = await createSnapshot('retry-delete');
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(fsPromises.unlink).mockRejectedValueOnce(error);

    await expect(deleteSnapshot(snapshot.id)).rejects.toBe(error);
    expect((await listSnapshots()).map(s => s.id)).toEqual([snapshot.id]);
    expect(await getSnapshot(snapshot.id)).toMatchObject({ id: snapshot.id });

    // A file removed outside PortOS can still have its stale listing deleted.
    rmSync(join(snapshotsDir(), `${snapshot.id}.json`));
    await expect(deleteSnapshot(snapshot.id)).resolves.toBe(true);
    await expect(listSnapshots()).resolves.toEqual([]);
  });
});
