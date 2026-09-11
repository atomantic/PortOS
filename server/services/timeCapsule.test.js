/**
 * Time capsule snapshot store — corrupt/missing files must not crash ops (#7010).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-time-capsule-') }));

const { PATHS } = await import('../lib/fileUtils.js');
const {
  listSnapshots,
  createSnapshot,
  getSnapshot,
  deleteSnapshot,
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
});
