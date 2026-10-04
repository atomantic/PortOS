/** LoRA training and deployed-LoRA workflows over real files. A backup cut must
 * never copy a replaced adapter whose run row it then dumps unchanged, and must
 * never let a deletion remove bytes a captured row still names (#9982). */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-lora-training-backup-'),
}));
vi.mock('../../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission: () => {} }));

// In-memory run rows; every write awaits `beforeRowWrite` so a test can hold
// a workflow at its row commit.
const rows = new Map();
let beforeRowWrite = async () => {};
vi.mock('./db.js', () => ({
  getRun: async id => rows.get(id) ?? null,
  getRunRequired: async (id) => {
    if (!rows.has(id)) throw Object.assign(new Error(`Run ${id} not found`), { status: 404 });
    return rows.get(id);
  },
  updateRun: async (id, patch) => {
    await beforeRowWrite(id);
    const current = rows.get(id);
    rows.set(id, typeof patch === 'function' ? patch(current) : { ...current, ...patch });
    return rows.get(id);
  },
  deleteRun: async (id) => { await beforeRowWrite(id); rows.delete(id); return { ok: true, id }; },
  listRuns: async () => [...rows.values()],
  listActiveRuns: async () => [],
}));
vi.mock('./checkpoints.js', () => ({
  listRunCheckpoints: () => [{ step: 100, loss: 0.1, previewUrl: '/preview.png' }],
  listRunSamples: () => [],
  resolveCheckpointAdapterBuffer: async () => Buffer.from('promoted adapter'),
  resolveLatestCheckpointArtifact: () => null,
  selectDeployableCheckpoint: vi.fn(),
}));
vi.mock('../loraDatasets.js', () => ({ updateDataset: async () => null }));
vi.mock('../modelManifest.js', () => ({ recordModelInstall: async () => {}, recordModelUninstall: async () => {} }));
vi.mock('../settings.js', () => ({ getSettings: async () => ({}) }));
vi.mock('../../lib/pythonSetup.js', () => ({
  isFlux2VenvHealthy: async () => false, resolveFlux2Python: () => null, resolveMfluxPython: () => null,
}));
vi.mock('../mediaJobQueue/index.js', () => ({
  assertMediaQueueRoom: () => {}, enqueueJob: vi.fn(), getJob: () => null, mediaJobEvents: { emit: vi.fn(), on: vi.fn() },
}));

const { PATHS } = await import('../../lib/fileUtils.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');
const { deleteTrainingRun, promoteCheckpoint, runDir } = await import('./index.js');
const { deleteLora, writeLoraSidecar } = await import('../loras.js');

const LORA = 'lora-example-trained.safetensors';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const settleSeveral = async () => { for (let i = 0; i < 5; i += 1) await settle(); };
const adapterBytes = () => readFile(join(PATHS.loras, LORA), 'utf8');
const seedRun = (overrides = {}) => rows.set('run-1', {
  id: 'run-1', status: 'completed', name: 'Example', datasetId: null,
  character: { entryId: 'subject-1', universeId: 'universe-1', name: 'Example Character' },
  params: { steps: 100 }, progress: { step: 100 },
  output: { loraFilename: LORA, selectedCheckpointStep: 200 },
  ...overrides,
});

afterAll(() => cleanupTempDataRoots());
beforeEach(async () => {
  beforeRowWrite = async () => {};
  rows.clear();
  await rm(PATHS.data, { recursive: true, force: true });
  await mkdir(PATHS.loras, { recursive: true });
  await mkdir(join(runDir('run-1'), 'samples'), { recursive: true });
  await writeFile(join(runDir('run-1'), 'samples', 'sample.png'), 'synthetic sample');
  await writeFile(join(PATHS.loras, LORA), 'deployed adapter');
  seedRun();
});

describe('checkpoint promotion', () => {
  it('drains a promotion that already replaced the adapter until its run row commits', async () => {
    const held = deferred();
    const proceed = deferred();
    beforeRowWrite = async () => { held.resolve(); await proceed.promise; };
    const promotion = promoteCheckpoint('run-1', 100);
    await held.promise;
    expect(await adapterBytes()).toBe('promoted adapter');
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then(release => { cutReady = true; return release; });
    await settleSeveral();
    expect(cutReady).toBe(false);
    proceed.resolve();
    await promotion;
    const release = await cut;
    expect(rows.get('run-1').output.selectedCheckpointStep).toBe(100);
    release();
  });

  it('leaves the deployed adapter untouched while a cut is open', async () => {
    const release = await acquireBackupSnapshotCut();
    const promotion = promoteCheckpoint('run-1', 100);
    await settleSeveral();
    expect(await adapterBytes()).toBe('deployed adapter');
    expect(rows.get('run-1').output.selectedCheckpointStep).toBe(200);
    release();
    await promotion;
    expect(await adapterBytes()).toBe('promoted adapter');
  });
});

describe('run and LoRA deletion', () => {
  it('keeps the run artifacts, adapter and row until the cut that captured them finishes', async () => {
    const release = await acquireBackupSnapshotCut();
    const deletion = deleteTrainingRun('run-1', { withLora: true });
    await settleSeveral();
    expect(existsSync(runDir('run-1'))).toBe(true);
    expect(await readdir(PATHS.loras)).toContain(LORA);
    expect(rows.has('run-1')).toBe(true);
    release();
    expect(await deletion).toEqual({ ok: true, id: 'run-1' });
    expect(existsSync(runDir('run-1'))).toBe(false);
    expect(await readdir(PATHS.loras)).not.toContain(LORA);
  });

  it('refuses to delete an active run before touching its files', async () => {
    seedRun({ status: 'running' });
    await expect(deleteTrainingRun('run-1')).rejects.toMatchObject({ code: 'RUN_ACTIVE' });
    expect(existsSync(runDir('run-1'))).toBe(true);
  });

  it('holds a manager deletion until the cut finishes, since other rows may still name the LoRA', async () => {
    const release = await acquireBackupSnapshotCut();
    const deletion = deleteLora(LORA);
    await settleSeveral();
    expect(await readdir(PATHS.loras)).toContain(LORA);
    release();
    await deletion;
    expect(await readdir(PATHS.loras)).not.toContain(LORA);
  });
});

describe('LoRA install commit', () => {
  it('writes the sidecar naming newly linked weights only after the cut finishes', async () => {
    const release = await acquireBackupSnapshotCut();
    const commit = writeLoraSidecar(LORA, { name: 'Example' });
    await settleSeveral();
    expect(existsSync(join(PATHS.loras, `${LORA}.metadata.json`))).toBe(false);
    release();
    await commit;
    expect(existsSync(join(PATHS.loras, `${LORA}.metadata.json`))).toBe(true);
  });
});
