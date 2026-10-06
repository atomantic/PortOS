/** Snapshot/index pairs must be copied together, including unlink-first deletion. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

let beforeIndexWrite = async () => {};
let bypassAdmission = false;
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return makePathsProxy(actual, {
    dataRoot: () => lazyTempDataRoot('portos-timecapsule-backup-'),
    overrides: { atomicWrite: async (path, data) => {
      if (path.endsWith('index.json')) await beforeIndexWrite();
      return actual.atomicWrite(path, data);
    } },
  });
});
vi.mock('../lib/backupSnapshotBoundary.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, withBackupAssetPublication: work => bypassAdmission ? work() : actual.withBackupAssetPublication(work) };
});
const { PATHS } = await import('../lib/fileUtils.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { createSnapshot, deleteSnapshot } = await import('./timeCapsule.js');
const dir = () => join(PATHS.digitalTwin, 'snapshots');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const capture = async () => ({
  files: (await readdir(dir())).filter(name => name !== 'index.json').sort(),
  rows: JSON.parse(await readFile(join(dir(), 'index.json'), 'utf8')).snapshots.map(row => `${row.id}.json`).sort(),
});
beforeEach(async () => {
  beforeIndexWrite = async () => {}; bypassAdmission = false;
  await rm(PATHS.data, { recursive: true, force: true });
  await mkdir(dir(), { recursive: true });
  await writeFile(join(dir(), 'index.json'), '{"snapshots":[]}');
});
afterAll(cleanupTempDataRoots);

const cases = [
  { name: 'create', setup: async () => () => createSnapshot('Example snapshot') },
  { name: 'delete', setup: async () => {
    const snapshot = await createSnapshot('Example snapshot');
    return () => deleteSnapshot(snapshot.id);
  } },
];
describe.each(cases)('$name snapshot pair', ({ setup }) => {
  it('does not mutate either half during an open cut', async () => {
    const run = await setup();
    const before = await capture();
    const release = await acquireBackupSnapshotCut();
    const work = run();
    try { await settle(); await settle(); expect(await capture()).toEqual(before); }
    finally { release(); }
    await work;
    const after = await capture();
    expect(after.files).toEqual(after.rows);
    expect(after).not.toEqual(before);
  });

  it('drains from the first file mutation through the index commit', async () => {
    const run = await setup();
    const reached = deferred(); const commit = deferred();
    beforeIndexWrite = async () => { reached.resolve(); await commit.promise; };
    const work = run();
    await reached.promise;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    try { await settle(); expect(cutReady).toBe(false); }
    finally { commit.resolve(); }
    await work;
    const release = await cut;
    try { const after = await capture(); expect(after.files).toEqual(after.rows); }
    finally { release(); }
  });
});

it('negative control exposes a copied index naming a file created after the file-copy phase', async () => {
  bypassAdmission = true;
  const release = await acquireBackupSnapshotCut();
  try {
    const copiedFiles = (await capture()).files;
    await createSnapshot('Example unadmitted snapshot');
    const copiedIndex = (await capture()).rows;
    expect(copiedIndex).toHaveLength(1);
    expect(copiedFiles).not.toEqual(copiedIndex);
  } finally { release(); }
});
