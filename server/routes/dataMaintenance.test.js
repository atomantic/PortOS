import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'maintenance-fixture-')));
const state = vi.hoisted(() => ({ jobs: [], authorized: true, failRemoval: false, recreate: false }));
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
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: work => work() }));
// hostControlRouteGate (#16018) admits the writes; the inventory GET carries its own check.
const gate = (_req, res, next) => state.authorized ? next() : res.sendStatus(403);
vi.mock('../services/authGate.js', () => ({ requireHostControl: gate, hostControlRouteGate: (req, res, next) => (req.method === 'GET' ? next() : gate(req, res, next)) }));
const { default: routes } = await import('./dataMaintenance.js');
const { hostControlRouteGate } = await import('../services/authGate.js');
const app = express(); app.use(express.json()); app.use(hostControlRouteGate); app.use('/api/data-maintenance', routes);
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
const del = (id = 'retired-training-runs') => request(app).delete(`/api/data-maintenance/${id}`);
beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const path of ['training-runs/run-example', 'lora-datasets/example/images', 'loras']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'training-runs/run-example/checkpoint.bin'), 'unique checkpoint');
  writeFileSync(join(root, 'lora-datasets/example/images/source.png'), 'unique source');
  writeFileSync(join(root, 'loras/example.safetensors'), 'shared adapter');
  state.jobs = []; state.authorized = true; state.failRemoval = false; state.recreate = false;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe('allowlisted data maintenance HTTP workflow', () => {
  it('lists only the two retired-data operations with their size', async () => {
    const inventory = await request(app).get('/api/data-maintenance');
    expect(inventory.body.map(row => row.id)).toEqual(['retired-training-runs', 'retired-lora-datasets']);
    expect(inventory.body.find(row => row.id === 'retired-training-runs')).toMatchObject({ status: 'retained', files: 1, bytes: 17, actions: ['delete'] });
  });
  it('deletes only the named operation for an authorized caller', async () => {
    const result = await del();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, operationId: 'retired-training-runs', removedFiles: 1, removedBytes: 17, status: 'deleted' });
    expect(existsSync(join(root, 'training-runs'))).toBe(false);
    expect(existsSync(join(root, 'loras/example.safetensors'))).toBe(true);
    expect(existsSync(join(root, 'lora-datasets/example/images/source.png'))).toBe(true);
  });
  it('refuses an unauthorized caller without removing anything', async () => {
    state.authorized = false;
    expect((await del()).status).toBe(403);
    expect(existsSync(join(root, 'training-runs/run-example/checkpoint.bin'))).toBe(true);
  });
  it('refuses arbitrary paths, the shared adapter directory and unknown operation ids', async () => {
    for (const id of ['..%2Floras', 'shared-lora-adapters', 'archives', 'loras']) expect((await del(id)).status).toBe(404);
    expect(existsSync(join(root, 'loras/example.safetensors'))).toBe(true);
  });
  it('refuses while queued or running media could own inputs', async () => {
    for (const status of ['queued', 'running']) {
      state.jobs = [{ status, kind: 'image' }];
      expect((await del()).body.code).toBe('MAINTENANCE_BUSY');
    }
    expect(existsSync(join(root, 'training-runs/run-example/checkpoint.bin'))).toBe(true);
  });

  it('protects both directories from a legacy detached writer until it exits', async () => {
    const control = join(root, 'training-runs/run-example/.detached');
    mkdirSync(control);
    writeFileSync(join(control, 'pid'), String(process.pid));

    for (const id of ['retired-training-runs', 'retired-lora-datasets']) {
      expect((await del(id)).body.code).toBe('MAINTENANCE_BUSY');
    }
    expect(existsSync(join(root, 'training-runs/run-example/checkpoint.bin'))).toBe(true);
    expect(existsSync(join(root, 'lora-datasets/example/images/source.png'))).toBe(true);

    writeFileSync(join(control, 'exit'), '0');
    expect((await del('retired-lora-datasets')).body).toMatchObject({ status: 'deleted', removedFiles: 1 });
    expect(existsSync(join(root, 'lora-datasets'))).toBe(false);
    expect(existsSync(join(root, 'training-runs/run-example/checkpoint.bin'))).toBe(true);
    expect((await del()).body.status).toBe('deleted');
    expect(existsSync(join(root, 'loras/example.safetensors'))).toBe(true);
  });
  it('reports nothing-to-delete as stale', async () => {
    expect((await del()).status).toBe(200);
    expect((await del()).body.code).toBe('MAINTENANCE_STALE');
  });
  it('refuses links without following their targets', async () => {
    symlinkSync(join(root, 'loras'), join(root, 'training-runs/run-example/link'));
    expect((await del()).body.code).toBe('MAINTENANCE_UNSAFE');
    const rows = (await request(app).get('/api/data-maintenance')).body;
    expect(rows.find(row => row.id === 'retired-training-runs').status).toBe('unavailable');
    expect(existsSync(join(root, 'loras/example.safetensors'))).toBe(true);
  });
});

it('reports filesystem failure without success and restores the untouched detached tree', async () => {
  state.failRemoval = true;
  const result = await del();
  expect(result.status).toBe(409);
  expect(result.body.code).toBe('MAINTENANCE_INCOMPLETE');
  expect(existsSync(join(root, 'training-runs/run-example/checkpoint.bin'))).toBe(true);
});

it('reports newly appearing files as retained instead of falsely reporting an empty category', async () => {
  state.recreate = true;
  const result = await del();
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ status: 'retained', remainingFiles: 1, remainingBytes: 10 });
  expect(existsSync(join(root, 'training-runs/new.bin'))).toBe(true);
});

it('refuses a linked data root instead of following it into another location', async () => {
  const moved = `${root}-moved`;
  renameSync(root, moved);
  try {
    symlinkSync(moved, root, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await del()).body.code).toBe('MAINTENANCE_UNSAFE');
    expect(existsSync(join(moved, 'training-runs/run-example/checkpoint.bin'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    renameSync(moved, root);
  }
});
