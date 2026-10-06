import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
const f = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: await mkdtemp(join(tmpdir(), 'game-compile-backup-')), row: null, beforeRow: null, bypass: false };
});
const queue = createFileWriteQueue();
vi.mock('./store.js', () => ({
  gameRecordDir: () => f.root, isValidGameId: () => true,
  queueGameWrite: (_id, fn) => queue(fn), readRaw: async () => f.row,
  writeRaw: async (_id, next) => { await f.beforeRow?.(); f.row = next; },
}));
vi.mock('./records.js', () => ({ GAME_HISTORY_LIMIT: 20, sanitizeGame: game => game }));
vi.mock('./integrity.js', () => ({ resolveGameAssets: async () => ({
  issues: [], sprites: [], music: [], artwork: [], inputSha256: 'example', schemaVersion: 1, verifiedFileCount: 0,
}) }));
vi.mock('../apps.js', () => ({ getAppById: async () => ({ id: 'example-app' }) }));
vi.mock('../../lib/backupSnapshotBoundary.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, withBackupAssetPublication: work => f.bypass ? work() : actual.withBackupAssetPublication(work) };
});
const { compileGameAssets } = await import('./compile.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const files = () => readdir(join(f.root, 'manifests'));
const assertPair = async () => expect(JSON.parse(await readFile(join(f.root, f.row.compiledManifest.manifestPath), 'utf8')).game.id).toBe('game-example');
beforeEach(async () => {
  await rm(f.root, { recursive: true, force: true }); await mkdir(join(f.root, 'manifests'), { recursive: true });
  f.row = { id: 'game-example', name: 'Example', appId: 'example-app', compileHistory: [] };
  f.beforeRow = null; f.bypass = false;
});
afterAll(() => rm(f.root, { recursive: true, force: true }));
it('blocks manifest and row changes during a cut', async () => {
  const release = await acquireBackupSnapshotCut();
  const work = compileGameAssets('game-example');
  try { await settle(); expect(await files()).toEqual([]); expect(f.row.compiledManifest).toBeUndefined(); }
  finally { release(); }
  await work; await assertPair();
});
it('drains a manifest already written through its pointer commit', async () => {
  const reached = deferred(); const commit = deferred();
  f.beforeRow = async () => { reached.resolve(); await commit.promise; };
  const work = compileGameAssets('game-example'); await reached.promise;
  expect(await files()).toHaveLength(1);
  let ready = false; const cut = acquireBackupSnapshotCut().then(release => { ready = true; return release; });
  try { await settle(); expect(ready).toBe(false); } finally { commit.resolve(); }
  await work; const release = await cut;
  try { await assertPair(); } finally { release(); }
});
it('negative control exposes a dumped pointer missing from the prior file copy', async () => {
  f.bypass = true;
  const release = await acquireBackupSnapshotCut();
  try {
    const copiedFiles = await files(); await compileGameAssets('game-example');
    expect(copiedFiles).not.toContain(f.row.compiledManifest.manifestPath.split('/').at(-1));
    await assertPair();
  } finally { release(); }
});
