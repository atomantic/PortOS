import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { copyEcosystemConfig } from '../test/fixtures/ecosystemConfigCopy.js';

vi.mock('../lib/paths.js', async importOriginal => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), {
    dataRoot: () => lazyTempDataRoot('portos-database-preflight-'),
    extraOverrides: root => ({ installRoot: root }),
  });
});
vi.mock('../lib/db.js', () => ({
  POOL_CONFIG: { host: 'localhost', port: 5432, user: 'example_role', database: 'example_test', password: 'example-only' },
  checkHealth: vi.fn(), query: vi.fn(),
}));
vi.mock('../services/activeProcessing.js', () => ({ getSystemActivity: vi.fn() }));
vi.mock('../services/updatePreflight.js', () => ({
  countActiveCosAgents: vi.fn(), getPersistentMindImageWorkGuard: vi.fn(),
}));
vi.mock('../lib/childProcess.js', async importOriginal => ({
  ...await importOriginal(), execFile: vi.fn(), spawn: vi.fn(),
}));
// The detached cutover worker is launched only after acceptance; never here.
vi.mock('../lib/detachedSpawn.js', async importOriginal => ({
  ...await importOriginal(),
  spawnDatabaseMaintenanceWorker: vi.fn(async () => ({ on() {} })),
}));

import databaseRoutes from './database.js';
import { PATHS } from '../lib/paths.js';
import { POOL_CONFIG, query } from '../lib/db.js';
import { execFile, spawn } from '../lib/childProcess.js';
import { createDatabaseMaintenanceJournal } from '../lib/databaseMaintenanceJournal.js';
import { acquireBackupSnapshotCut, withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { getSystemActivity } from '../services/activeProcessing.js';
import { countActiveCosAgents, getPersistentMindImageWorkGuard } from '../services/updatePreflight.js';
import { spawnDatabaseMaintenanceWorker } from '../lib/detachedSpawn.js';
import { hostControlRouteGate } from '../services/authGate.js';

const idle = () => ({
  jobs: [], extras: { imageTo3d: [] }, agents: { trusted: true, active: 0, queued: 0 },
  mind: { trusted: true, thinking: false, queued: 0 }, llm: { trusted: true, active: 0 },
  appOperations: [], update: { inProgress: false }, backup: { inProgress: false },
});
const saveMode = mode => writeFileSync(join(PATHS.installRoot, '.env'), `PGMODE=${mode}\n`);
const app = express();
app.use(express.json());
app.use('/api/database', databaseRoutes);
app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message, code: err.code }));
const preflight = (body = { source: 'native', target: 'docker' }) => request(app).post('/api/database/maintenance/preflight').send(body);
const accept = (body = { source: 'native', target: 'docker' }) => request(app).post('/api/database/maintenance/cutover').send(body);

beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ PGHOST: 'localhost', PGPORT: '5432', PORTOS_NATIVE_PGPORT: '5432', PGPORT_DOCKER: '5561', PGUSER: 'example_role', PGDATABASE: 'example_test', PGPASSWORD: 'example-only' })) vi.stubEnv(key, value);
  Object.assign(POOL_CONFIG, { host: 'localhost', port: 5432, user: 'example_role', database: 'example_test' });
  copyEcosystemConfig(PATHS.installRoot);
  saveMode('native');
  getSystemActivity.mockResolvedValue(idle());
  countActiveCosAgents.mockResolvedValue(0);
  getPersistentMindImageWorkGuard.mockResolvedValue({ trusted: true, safe: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(join(PATHS.data, 'database-maintenance'), { recursive: true, force: true });
  rmSync(join(PATHS.data, 'database-maintenance-cancelled'), { recursive: true, force: true });
  expect(execFile).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});
afterAll(cleanupTempDataRoots);

describe('database maintenance preflight HTTP contract', () => {
  it.each(['native', 'docker'])('returns only non-accepted advice for a trusted idle %s source', async source => {
    saveMode(source);
    POOL_CONFIG.port = source === 'native' ? 5432 : 5561;
    const target = source === 'native' ? 'docker' : 'native';
    const result = await preflight({ source, target });
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toEqual({ source, target, advisory: true, accepted: false });
    expect(createDatabaseMaintenanceJournal(PATHS.data).read()).toBeNull();
    expect(readFileSync(join(PATHS.installRoot, '.env'), 'utf8')).toBe(`PGMODE=${source}\n`);
  });

  it.each([
    {}, { source: 'native', target: 'native' }, { source: 'native', target: 'other' },
    { source: 'native', target: 'docker', force: true },
  ])('rejects invalid or bypass-shaped requests before work inspection: %j', async body => {
    expect((await preflight(body)).status).toBe(400);
    expect(getSystemActivity).not.toHaveBeenCalled();
  });

  it.each(['host', 'port', 'user', 'database'])('refuses when saved source differs from the actual pool %s', async key => {
    POOL_CONFIG[key] = key === 'port' ? 6000 : 'example-mismatch';
    const result = await preflight();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('DATABASE_PREFLIGHT_STALE');
    expect(result.body.error).not.toContain('example-mismatch');
    expect(getSystemActivity).not.toHaveBeenCalled();
  });

  it('refuses reversed requests and aliased backends', async () => {
    expect((await preflight({ source: 'docker', target: 'native' })).body.code).toBe('DATABASE_PREFLIGHT_STALE');
    vi.stubEnv('PGPORT_DOCKER', '5432');
    expect((await preflight()).body.code).toBe('DATABASE_PREFLIGHT_STALE');
    expect(getSystemActivity).not.toHaveBeenCalled();
  });

  it.each([
    ['queued media', s => { s.jobs = [{ status: 'queued', prompt: 'example private prompt' }]; }],
    ['active agent', s => { s.agents.active = 1; }],
    ['queued mind', s => { s.mind.queued = 1; }],
    ['LLM run', s => { s.llm.active = 1; }],
    ['backup', s => { s.backup.inProgress = true; }],
    ['update', s => { s.update.inProgress = true; }],
    ['app operation', s => { s.appOperations = [{ name: 'example-private-app' }]; }],
    ['image build', s => { s.extras.imageTo3d = [{ name: 'example-private-model' }]; }],
  ])('refuses %s without exposing activity records', async (_label, mutate) => {
    const snapshot = idle(); mutate(snapshot); getSystemActivity.mockResolvedValue(snapshot);
    const result = await preflight();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('DATABASE_PREFLIGHT_BUSY');
    expect(JSON.stringify(result.body)).not.toContain('example');
  });

  it.each([
    ['missing slice', s => { delete s.jobs; }],
    ['unreadable builds', s => { s.extras.imageTo3d = null; }],
    ['untrusted agents', s => { s.agents.trusted = false; }],
    ['untrusted mind', s => { s.mind.trusted = false; }],
    ['untrusted LLM', s => { s.llm.trusted = false; }],
    ['malformed count', s => { s.agents.active = -1; }],
  ])('refuses %s instead of manufacturing an idle snapshot', async (_label, mutate) => {
    const snapshot = idle(); mutate(snapshot); getSystemActivity.mockResolvedValue(snapshot);
    const result = await preflight();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('DATABASE_PREFLIGHT_UNTRUSTED');
  });

  it('includes the spawn window and independent Persistent Mind guard', async () => {
    countActiveCosAgents.mockResolvedValue(1);
    expect((await preflight()).body.code).toBe('DATABASE_PREFLIGHT_BUSY');
    countActiveCosAgents.mockResolvedValue(0);
    getPersistentMindImageWorkGuard.mockResolvedValue({ trusted: true, safe: false });
    const mindBusy = await preflight();
    expect(mindBusy.body.code, JSON.stringify(mindBusy)).toBe('DATABASE_PREFLIGHT_BUSY');
    getPersistentMindImageWorkGuard.mockResolvedValue({ trusted: false, safe: false });
    expect((await preflight()).body.code).toBe('DATABASE_PREFLIGHT_UNTRUSTED');
  });

  it('sanitizes failed inspections and unreadable saved configuration', async () => {
    getSystemActivity.mockRejectedValue(new Error('example private connection detail'));
    const result = await preflight();
    expect(result.body.code).toBe('DATABASE_PREFLIGHT_UNTRUSTED');
    expect(JSON.stringify(result.body)).not.toContain('example');
    rmSync(join(PATHS.installRoot, '.env'));
    mkdirSync(join(PATHS.installRoot, '.env'));
    expect((await preflight()).body.code).toBe('DATABASE_PREFLIGHT_UNTRUSTED');
    rmSync(join(PATHS.installRoot, '.env'), { recursive: true });
  });

  it('refuses missing saved configuration rather than assuming the default direction', async () => {
    rmSync(join(PATHS.installRoot, '.env'));
    POOL_CONFIG.port = 5561;
    const result = await preflight({ source: 'docker', target: 'native' });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('DATABASE_PREFLIGHT_UNTRUSTED');
    expect(getSystemActivity).not.toHaveBeenCalled();
  });

  it('re-reads saved settings after asynchronous work inspection', async () => {
    getSystemActivity.mockImplementation(async () => { saveMode('docker'); return idle(); });
    expect((await preflight()).body.code).toBe('DATABASE_PREFLIGHT_STALE');
    // Same active source, but the target identity changed during the observation.
    saveMode('native');
    getSystemActivity.mockImplementation(async () => { vi.stubEnv('PGPORT_DOCKER', '6000'); return idle(); });
    expect((await preflight()).body.code).toBe('DATABASE_PREFLIGHT_STALE');
  });

  it('rechecks the persistent fence before returning advice', async () => {
    const journal = createDatabaseMaintenanceJournal(PATHS.data);
    getSystemActivity.mockImplementation(async () => {
      const source = { mode: 'native', host: 'localhost', port: 5432, user: 'example_role', database: 'example_test' };
      journal.begin({ source, target: { ...source, mode: 'docker', port: 5561 } });
      return idle();
    });
    const result = await preflight();
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('DATABASE_MAINTENANCE');
    getSystemActivity.mockClear();
    expect((await preflight()).status).toBe(503);
    expect(getSystemActivity).not.toHaveBeenCalled();
  });
});

describe('database cutover acceptance HTTP contract', () => {
  const busy = () => ({ ...idle(), agents: { trusted: true, active: 1, queued: 0 } });

  it.each(['native', 'docker'])('accepts a trusted idle %s source, takes ownership, and launches one worker', async source => {
    saveMode(source);
    POOL_CONFIG.port = source === 'native' ? 5432 : 5561;
    const target = source === 'native' ? 'docker' : 'native';
    const result = await accept({ source, target });
    expect(result.status).toBe(202);
    expect(result.headers['cache-control']).toBe('no-store');
    const journal = createDatabaseMaintenanceJournal(PATHS.data);
    const operation = journal.read();
    expect(result.body).toEqual({ id: operation.id, stage: 'accepted', source, target, accepted: true });
    expect(operation).toMatchObject({ stage: 'accepted', source: { mode: source }, target: { mode: target } });
    // Owned before launch: cancellation and a second owner are refused.
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'unregistered' });
    // Launched only after the 202 is sent — the worker stops this server.
    await vi.waitFor(() => expect(spawnDatabaseMaintenanceWorker).toHaveBeenCalledTimes(1));
    expect(spawnDatabaseMaintenanceWorker.mock.calls[0][0]).toBe(operation.id);
    expect(() => journal.acquireCoordinator(operation.id)).toThrow();
    // Acceptance itself never changes the saved mode.
    expect(readFileSync(join(PATHS.installRoot, '.env'), 'utf8')).toBe(`PGMODE=${source}\n`);
    expect((await accept({ source, target })).status).toBe(503);
  });

  it('refuses stale and reversed requests without publishing an operation', async () => {
    expect((await accept({ source: 'docker', target: 'native' })).body.code).toBe('DATABASE_PREFLIGHT_STALE');
    POOL_CONFIG.port = 6000;
    expect((await accept()).body.code).toBe('DATABASE_PREFLIGHT_STALE');
    expect(createDatabaseMaintenanceJournal(PATHS.data).read()).toBeNull();
    expect(spawnDatabaseMaintenanceWorker).not.toHaveBeenCalled();
  });

  // The second activity observation runs AFTER publication: admission is closed.
  const raceFinalCheck = observe => getSystemActivity.mockResolvedValueOnce(idle()).mockImplementationOnce(async () => {
    expect(createDatabaseMaintenanceJournal(PATHS.data).isFenced()).toBe(true);
    return observe();
  });

  it('cancels the unowned operation when work admitted before the fence is still running', async () => {
    raceFinalCheck(busy);
    const result = await accept();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('DATABASE_PREFLIGHT_BUSY');
    const journal = createDatabaseMaintenanceJournal(PATHS.data);
    expect(journal.read()).toBeNull();
    expect(() => journal.assertAdmission()).not.toThrow();
    expect(spawnDatabaseMaintenanceWorker).not.toHaveBeenCalled();
  });

  it('publishes the fence only after an admitted file-plus-row publication drains, then refuses a backup cut', async () => {
    const journal = createDatabaseMaintenanceJournal(PATHS.data);
    let finishRow;
    const halfPublished = withBackupAssetPublication(() => new Promise(resolve => { finishRow = resolve; }));
    const accepting = accept().then(result => result);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(journal.read()).toBeNull();

    finishRow();
    await halfPublished;
    expect((await accepting).status).toBe(202);
    expect(journal.read()).toMatchObject({ stage: 'accepted' });
    // The fence also refuses a backup cut, so nothing can capture the stores meanwhile.
    await expect(acquireBackupSnapshotCut()).rejects.toMatchObject({ code: 'DATABASE_MAINTENANCE' });
  });

  it('refuses without a fence while a backup owns the snapshot cut, and accepts once it is released', async () => {
    const journal = createDatabaseMaintenanceJournal(PATHS.data);
    const releaseBackupCut = await acquireBackupSnapshotCut();
    try {
      const refused = await accept();
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('DATABASE_PREFLIGHT_BUSY');
      expect(journal.read()).toBeNull();
      expect(spawnDatabaseMaintenanceWorker).not.toHaveBeenCalled();
    } finally {
      releaseBackupCut();
    }
    expect((await accept()).status).toBe(202);
  });

  it('releases its own cut when acceptance is cancelled, so a backup can still take one', async () => {
    raceFinalCheck(busy);
    expect((await accept()).body.code).toBe('DATABASE_PREFLIGHT_BUSY');
    (await acquireBackupSnapshotCut())();
  });

  it('keeps the fence when the saved source changed during acceptance', async () => {
    raceFinalCheck(() => { saveMode('docker'); return idle(); });
    const result = await accept();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('DATABASE_PREFLIGHT_STALE');
    // Reopening now would let a restart select the unimported backend.
    const journal = createDatabaseMaintenanceJournal(PATHS.data);
    expect(journal.read()).toMatchObject({ stage: 'accepted', source: { mode: 'native' } });
    expect(() => journal.assertAdmission()).toThrow();
    expect(journal.coordinatorStatus(journal.read().id)).toEqual({ state: 'unclaimed' });
    expect(spawnDatabaseMaintenanceWorker).not.toHaveBeenCalled();
  });

  it('requires host-control authority before accepting or recovering', async () => {
    const gated = express();
    gated.use((req, _res, next) => { req.portosAuthContext = { enabled: true, authenticated: false }; next(); });
    gated.use(hostControlRouteGate);
    gated.use(express.json());
    gated.use('/api/database', databaseRoutes);
    for (const path of ['cutover', 'recover']) {
      const result = await request(gated).post(`/api/database/maintenance/${path}`).send({ source: 'native', target: 'docker' });
      expect(result.status).toBe(403);
    }
    expect(getSystemActivity).not.toHaveBeenCalled();
    expect(createDatabaseMaintenanceJournal(PATHS.data).read()).toBeNull();
  });

  it('recovers only the recorded operation after its worker exit receipt', async () => {
    const recover = id => request(app).post('/api/database/maintenance/recover').send({ id });
    expect((await recover('not-a-uuid')).status).toBe(400);
    const accepted = await accept();
    const journal = createDatabaseMaintenanceJournal(PATHS.data);
    await vi.waitFor(() => expect(spawnDatabaseMaintenanceWorker).toHaveBeenCalledTimes(1));
    const [id, token] = spawnDatabaseMaintenanceWorker.mock.calls[0];
    const directory = journal.reserveCoordinatorWorker(id, token);
    // Still running (no receipt): recovery launches nothing.
    expect((await recover(id)).body).toEqual({ id, stage: 'accepted', recovery: 'running' });
    writeFileSync(join(directory, 'exit'), '1\n');
    expect((await recover('00000000-0000-4000-8000-000000000000')).status).toBe(503);
    const recovered = await recover(id);
    expect(recovered.status).toBe(202);
    expect(recovered.body).toEqual({ id: accepted.body.id, stage: 'accepted', recovery: 'launching' });
    await vi.waitFor(() => expect(spawnDatabaseMaintenanceWorker).toHaveBeenCalledTimes(2));
    expect(spawnDatabaseMaintenanceWorker.mock.calls[1][0]).toBe(id);
    expect(spawnDatabaseMaintenanceWorker.mock.calls[1][1]).not.toBe(token);
  });
});
