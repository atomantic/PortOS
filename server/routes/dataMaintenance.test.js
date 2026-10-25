import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'maintenance-fixture-')));
const state = vi.hoisted(() => ({ jobs: [], busy: false, caption: null, authorized: true, failRemoval: false, recreate: false }));
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return { ...makePathsProxy(actual, { dataRoot: root }), rmGuarded: async (path, options) => {
    if (state.failRemoval) throw new Error('Synthetic storage failure');
    await actual.rmGuarded(path, options);
    if (state.recreate) {
      mkdirSync(join(root, 'training-runs'));
      writeFileSync(join(root, 'training-runs/new.bin'), 'new writer');
    }
  } };
});
vi.mock('../services/mediaJobQueue/index.js', () => ({ listJobs: () => state.jobs }));
vi.mock('../services/dataManagerBusy.js', () => ({ trainingRunsBusy: async () => ({ busy: state.busy }) }));
vi.mock('../services/loraDatasetCaption.js', () => ({ getActiveCaptionRun: () => state.caption }));
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: work => work() }));
vi.mock('../services/authGate.js', () => ({ requireHostControl: (_req, res, next) => state.authorized ? next() : res.sendStatus(403) }));
const { default: routes } = await import('./dataMaintenance.js');
const app = express(); app.use(express.json()); app.use('/api/data-maintenance', routes);
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
const preview = () => request(app).post('/api/data-maintenance/preview').send({ operationId: 'retired-training-runs' });
const execute = p => request(app).post('/api/data-maintenance/execute').send({ token: p.token, confirmation: p.confirmation });
beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const path of ['training-runs/run-example', 'lora-datasets/example/images', 'loras']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'training-runs/run-example/checkpoint.bin'), 'unique checkpoint');
  writeFileSync(join(root, 'lora-datasets/example/images/source.png'), 'unique source');
  writeFileSync(join(root, 'loras/example.safetensors'), 'shared adapter');
  state.jobs = []; state.busy = false; state.caption = null; state.authorized = true; state.failRemoval = false; state.recreate = false;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe('allowlisted data maintenance HTTP workflow', () => {
  it('previews without mutating, requires exact confirmation, removes only approved artifacts and replays idempotently', async () => {
    const inventory = await request(app).get('/api/data-maintenance');
    expect(inventory.body.find(row => row.id === 'retired-training-runs')).toMatchObject({ status: 'retained', files: 1, bytes: 17 });
    const p = (await preview()).body;
    expect(existsSync(join(root, 'training-runs/run-example/checkpoint.bin'))).toBe(true);
    expect((await request(app).post('/api/data-maintenance/execute').send({ token: p.token, confirmation: 'DELETE' })).status).toBe(400);
    const [one, two] = await Promise.all([execute(p), execute(p)]);
    expect(one.status).toBe(200); expect(two.body).toEqual(one.body);
    expect(existsSync(join(root, 'training-runs'))).toBe(false);
    expect(existsSync(join(root, 'loras/example.safetensors'))).toBe(true);
    expect(existsSync(join(root, 'lora-datasets/example/images/source.png'))).toBe(true);
  });
  it('rejects stale inventories and refuses a job that starts after preview', async () => {
    const p = (await preview()).body;
    writeFileSync(join(root, 'training-runs/run-example/new.bin'), 'new');
    expect((await execute(p)).body.code).toBe('MAINTENANCE_STALE');
    const fresh = (await preview()).body;
    state.jobs = [{ status: 'running', kind: 'image' }];
    expect((await execute(fresh)).body.code).toBe('MAINTENANCE_BUSY');
    expect(existsSync(join(root, 'training-runs/run-example/new.bin'))).toBe(true);
  });
  it('refuses surviving trainers, captioning, arbitrary paths, shared assets, unknown previews and unauthorized callers', async () => {
    state.busy = true; expect((await preview()).body.code).toBe('MAINTENANCE_BUSY');
    state.busy = false; state.caption = { status: 'running' }; expect((await preview()).body.code).toBe('MAINTENANCE_BUSY');
    state.caption = null;
    for (const operationId of ['../loras', 'shared-lora-adapters', 'archives']) expect((await request(app).post('/api/data-maintenance/preview').send({ operationId })).status).toBe(404);
    expect((await execute({ token: '00000000-0000-4000-8000-000000000001', confirmation: 'DELETE training-runs' })).body.code).toBe('MAINTENANCE_STALE');
    state.authorized = false; expect((await preview()).status).toBe(403);
  });
  it('refuses links without following their targets', async () => {
    symlinkSync(join(root, 'loras'), join(root, 'training-runs/run-example/link'));
    expect((await preview()).body.code).toBe('MAINTENANCE_UNSAFE');
    const rows = (await request(app).get('/api/data-maintenance')).body;
    expect(rows.find(row => row.id === 'retired-training-runs').status).toBe('unavailable');
    expect(existsSync(join(root, 'loras/example.safetensors'))).toBe(true);
  });
});

it('refuses removal while checkpoint promotion or a retained dataset write owns the data', async () => {
  const p = (await preview()).body;
  const { withRetiredDataAccess } = await import('../lib/retiredLoraTraining.js');
  let release;
  const access = withRetiredDataAccess(() => new Promise(resolve => { release = resolve; }));
  try {
    expect((await execute(p)).body.code).toBe('MAINTENANCE_BUSY');
    expect(existsSync(join(root, 'training-runs/run-example/checkpoint.bin'))).toBe(true);
  } finally { release(); await access; }
  expect((await execute(p)).status).toBe(200);
});

it('expires previews and rejects a replaced directory without removing its replacement', async () => {
  const p = (await preview()).body;
  const actualNow = Date.now;
  vi.spyOn(Date, 'now').mockReturnValue(actualNow() + 6 * 60_000);
  try { expect((await execute(p)).body.code).toBe('MAINTENANCE_STALE'); }
  finally { vi.restoreAllMocks(); }
  const fresh = (await preview()).body;
  rmSync(join(root, 'training-runs'), { recursive: true });
  mkdirSync(join(root, 'training-runs'));
  writeFileSync(join(root, 'training-runs/new.bin'), 'replacement');
  expect((await execute(fresh)).body.code).toBe('MAINTENANCE_STALE');
  expect(existsSync(join(root, 'training-runs/new.bin'))).toBe(true);
});

it('reports filesystem failure without success and restores the untouched detached tree', async () => {
  const p = (await preview()).body;
  state.failRemoval = true;
  const result = await execute(p);
  expect(result.status).toBe(409);
  expect(result.body.code).toBe('MAINTENANCE_INCOMPLETE');
  expect(existsSync(join(root, 'training-runs/run-example/checkpoint.bin'))).toBe(true);
});

it('reports newly appearing files as retained instead of falsely reporting an empty category', async () => {
  const p = (await preview()).body;
  state.recreate = true;
  const result = await execute(p);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ status: 'retained', remainingFiles: 1, remainingBytes: 10 });
  expect(existsSync(join(root, 'training-runs/new.bin'))).toBe(true);
});

it('refuses a linked data root instead of following it into another location', async () => {
  const moved = `${root}-moved`;
  renameSync(root, moved);
  try {
    symlinkSync(moved, root, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await preview()).body.code).toBe('MAINTENANCE_UNSAFE');
    expect(existsSync(join(moved, 'training-runs/run-example/checkpoint.bin'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    renameSync(moved, root);
  }
});
