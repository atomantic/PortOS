import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../server/lib/mockPathsDataRoot.js';
import { createMaintenanceAdmission } from '../../server/lib/maintenanceAdmission.js';
import { createMaintenanceJournal } from '../../server/lib/maintenanceJournal.js';
import { assertNoScopedLegacyProcesses } from '../../server/services/maintenanceScopedProcesses.js';
import { runDeferredUpdate } from '../deferred-update.mjs';
import { createUpdateReservationRecovery } from './updateReservationRecovery.mjs';
import { continueManualUpdateRecovery } from './manualUpdateRecovery.mjs';

vi.mock('../../server/lib/paths.js', async original => makePathsProxy(await original(), {
  dataRoot: () => join(lazyTempDataRoot('update-recovery-auth-'), 'data'),
}));

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await cleanupTempDataRoots();
});
const listen = async handler => {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanups.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
};
const idle = () => ({ jobs: [], agents: { trusted: true, active: 0, queued: 0 },
  mind: { trusted: true, thinking: false }, llm: { trusted: true, active: 0, directCallsTracked: true },
  extras: { imageTo3d: [] }, appOperations: [], renders: [], update: { inProgress: false }, backup: { inProgress: false } });

async function fixture({ stale = true, authenticated = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'update-bootstrap-recovery-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  mkdirSync(data);
  const gate = createMaintenanceAdmission(data);
  const journal = createMaintenanceJournal(data);
  if (stale) journal.transaction(state => state.operations.push({ id: randomUUID(), kind: 'settlement', resource: 'Output publication',
    pid: 2147483647, startedAt: '2001-01-01T00:00:00.000Z', unsettled: true, uncertaintyStamp: randomUUID() }));
  const update = gate.deferredUpdate.request();
  const revoke = vi.fn(async () => {});
  const state = { activity: idle(), runnerAgents: [], tasks: {}, agents: {}, apps: {}, clock: 0,
    processes: [{ pid: process.pid, command: 'node supervisor', state: 'S', startedAt: Date.now() - 1000 }] };
  const runner = await listen((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state.runnerAgents)); });
  writeFileSync(join(root, '.env'), `COS_RUNNER_URL=${runner}\n`);
  const api = await listen(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/system/health') return res.end('{"status":"ok"}');
    if (state.authorize ? !await state.authorize(req.headers.authorization) : authenticated && req.headers.authorization !== 'Bearer fixture-update-session') {
      res.statusCode = 401; return res.end('{"error":"AUTH_REQUIRED"}');
    }
    let value;
    if (req.method === 'DELETE' && req.url.startsWith('/api/auth/sessions/')) {
      await (state.revokeSession ?? revoke)(req.url.split('/').at(-1));
      value = { success: true };
    } else if (req.url === '/api/system/maintenance') {
      value = gate.status();
      delete value.deferredUpdate; // older servers expose the owner in blockers
    } else if (req.url === '/api/system/activity') value = state.activity;
    else if (req.url.startsWith('/api/cos/agents/')) value = state.agents[req.url.split('/').at(-1)];
    else if (req.url.startsWith('/api/cos/tasks/')) {
      const task = state.tasks[req.url.split('/').at(-1)];
      if (task) value = { task };
    } else if (req.url.startsWith('/api/apps/')) value = state.apps[req.url.split('/').at(-1)];
    if (value === undefined) { res.statusCode = 404; value = { error: 'not found' }; }
    res.end(JSON.stringify(value));
  });
  const mintSession = vi.fn(async () => ({ token: 'fixture-update-session', id: 'fixture-session' }));
  const options = { directory: gate.directory, root, env: {}, apiOrigin: api,
    credentials: { token: null }, mintSession, now: () => state.clock,
    snapshot: async () => state.processes, scoped: async () => [] };
  const recovery = await createUpdateReservationRecovery(options);
  cleanups.push(() => recovery.close());
  return { root, data, gate, journal, update, state, recovery, options, mintSession, revoke };
}

describe('fresh updater recovery against a running server', () => {
  it('recovers through authenticated HTTP and the saved runner URL when activity is fully instrumented', async () => {
    const f = await fixture({ authenticated: true });
    const { state, gate, root, data } = f;
    state.apps['portos-default'] = { repoPath: root };
    const requestedAt = Date.parse(f.update.requestedAt);
    state.activity.appOperations = [{ appId: 'portos-default', type: 'update', startedAt: requestedAt - 100,
      steps: [{ step: 'app-update', status: 'running' }, { step: 'starting', status: 'done', timestamp: requestedAt + 100 }] }];
    const media = JSON.stringify({ jobs: [{}, { id: 'completed-media', status: 'completed' }] });
    writeFileSync(join(data, 'media-jobs.json'), media);
    let receipt;
    const launch = vi.fn((_command, _args, options) => {
      const child = new EventEmitter(); child.pid = 4321;
      gate.deferredUpdate.enter(options.env.PORTOS_DEFERRED_UPDATE_ID, child.pid);
      gate.deferredUpdate.terminal(options.env.PORTOS_DEFERRED_UPDATE_ID, child.pid, true);
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    expect(await runDeferredUpdate({ admission: gate, cwd: root, launch, absent: () => true,
      legacyRunning: async () => false, emit: vi.fn(), recoverReservations: async () => { receipt = await f.recovery.run(); } })).toBe(0);
    expect(launch).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({ disposition: 'automatically-abandoned', outputCompleteness: 'unknown' });
    expect(gate.operations()).toEqual([]);
    expect(readFileSync(join(data, 'media-jobs.json'), 'utf8')).toBe(media);
    expect(f.mintSession).toHaveBeenCalledOnce();
    await f.recovery.close();
    expect(f.revoke).toHaveBeenCalledOnce();
  });

  it.each(['unknown legacy', 'confirmed active'])('offers a private-attempt browser confirmation for %s activity', async activity => {
    const f = await fixture({ stale: false });
    if (activity === 'unknown legacy') delete f.state.activity.llm.directCallsTracked;
    else f.state.activity.agents.active = 1;
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: '0.0.0', type: 'module' }));
    mkdirSync(join(f.root, 'client', 'dist'), { recursive: true });
    writeFileSync(join(f.root, 'client', 'dist', 'index.html'), 'Old UI');
    const git = args => execFileSync('git', args, { cwd: f.root, stdio: 'pipe' });
    git(['init', '--quiet']); git(['add', 'package.json']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture']);
    vi.stubEnv('PORTOS_FORCE_CLEAN_WORKSPACES', 'client,invalid,server');
    vi.stubEnv('PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED', '1');
    const launch = vi.fn(); const emit = vi.fn();
    try {
      await expect(runDeferredUpdate({ admission: f.gate, cwd: f.root, policy: 'manual', launch,
        recoverReservations: () => f.recovery.run(), legacyRunning: async () => false,
        wait: async () => { f.state.clock += 1000; }, confirmInterruption: async () => false, emit }))
        .rejects.toMatchObject({ code: 'UPDATE_INTERRUPTION_REQUIRED' });
    } finally { vi.unstubAllEnvs(); }
    expect(launch).not.toHaveBeenCalled();
    const id = f.gate.deferredUpdate.get().result.id;
    expect(emit).toHaveBeenCalledWith(expect.stringContaining(`/manual-update.html?attempt=${id}`));
    const page = readFileSync(join(f.root, 'client', 'dist', 'manual-update.html'), 'utf8');
    expect(page).not.toContain(f.root);
    expect(page).not.toContain(id);
    const continued = vi.fn(async () => ({ started: true, completion: Promise.resolve({ success: true }) }));
    const otherRoot = join(f.root, 'other-checkout');
    git(['clone', '--quiet', '--no-hardlinks', f.root, otherRoot]);
    await expect(continueManualUpdateRecovery({ id, root: otherRoot, directory: f.gate.directory, launch: continued })).rejects.toThrow('different PortOS checkout');
    expect(continued).not.toHaveBeenCalled();
    await continueManualUpdateRecovery({ id, root: f.root, directory: f.gate.directory, launch: continued });
    expect(continued).toHaveBeenCalledWith('v0.0.0', expect.any(Function), {
      acknowledgeInterruption: true, expectedRefusalId: id, forceCleanWorkspaces: ['client', 'server'], acknowledgePersistentMindImageBackup: true,
    });
    const path = join(f.gate.directory, `update-manual-${id}.json`);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const resultPath = join(f.gate.directory, 'update-result.json');
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    writeFileSync(resultPath, JSON.stringify({ ...result, id: randomUUID() }));
    await expect(continueManualUpdateRecovery({ id, root: f.root, directory: f.gate.directory, launch: continued })).rejects.toThrow('newer update attempt');
    expect(continued).toHaveBeenCalledOnce();
  });

  it('keeps an unfinished app-update handoff blocking, including during the retry cooldown', async () => {
    const f = await fixture();
    f.state.apps.self = { repoPath: f.root };
    f.state.activity.appOperations = [{ appId: 'self', type: 'update', startedAt: Date.parse(f.update.requestedAt) - 100,
      steps: [{ step: 'app-update', status: 'running' }, { step: 'starting', status: 'running' }] }];
    await expect(f.recovery.run()).rejects.toThrow('running work');
    await expect(f.recovery.run()).rejects.toThrow('running work');
    expect(f.gate.operations()).toHaveLength(2);
    f.state.activity.appOperations = [];
    f.state.clock = 5000;
    expect(await f.recovery.run()).toMatchObject({ outputCompleteness: 'unknown' });
  });

  it('checks the configured runner even when the server reports no active agents', async () => {
    const f = await fixture();
    f.state.runnerAgents = [{ id: 'agent-still-running' }];
    await expect(f.recovery.run()).rejects.toThrow('running work');
    expect(f.gate.operations()).toHaveLength(2);
  });

  it('requires the explicit completed handoff from a server that supports ownership tracking', async () => {
    const f = await fixture();
    f.state.apps.self = { repoPath: f.root };
    f.state.activity.update.handoffTracking = true;
    f.state.activity.appOperations = [{ appId: 'self', type: 'update', startedAt: Date.parse(f.update.requestedAt) - 100,
      steps: [{ step: 'app-update', status: 'running' },
        { step: 'starting', status: 'done', timestamp: Date.parse(f.update.requestedAt) + 100 }] }];
    await expect(f.recovery.run()).rejects.toThrow('running work');
    f.state.activity.appOperations[0].deferredUpdateOwnerPid = f.update.ownerPid;
    f.state.clock = 5000;
    expect(await f.recovery.run()).toMatchObject({ disposition: 'automatically-abandoned' });
  });

  it('scopes an unfinished task setup to its managed app, preserving its orphaned git child', async () => {
    const f = await fixture({ stale: false });
    const appRoot = join(f.root, 'managed-app');
    f.journal.transaction(state => state.operations.push({ id: randomUUID(), kind: 'agent', resource: 'task-setup',
      pid: 2147483647, startedAt: '2001-01-01T00:00:00.000Z' }));
    f.state.tasks['task-setup'] = { id: 'task-setup', taskType: 'user', description: 'Prepare the managed application', metadata: { app: 'managed' } };
    f.state.apps.managed = { repoPath: appRoot };
    f.state.processes.push({ pid: 4321, ppid: 1, state: 'S', command: 'git fetch origin', startedAt: Date.now() });
    const recovery = await createUpdateReservationRecovery({ ...f.options,
      scoped: (operations, rows, options) => assertNoScopedLegacyProcesses(operations, rows,
        { ...options, probeCwds: async () => new Map([[4321, appRoot]]) }) });
    cleanups.push(() => recovery.close());
    await expect(recovery.run()).rejects.toThrow('workspace is still running');
    expect(f.gate.operations().some(op => op.resource === 'task-setup')).toBe(true);
  });

  it('supports a missing local runner in direct mode while preserving an observed runner outage', async () => {
    const f = await fixture();
    writeFileSync(join(f.root, '.env'), '');
    const fetcher = async (url, options) => {
      if (url.endsWith('/agents')) throw new Error('runner unavailable');
      return fetch(url, options);
    };
    const direct = await createUpdateReservationRecovery({ ...f.options, fetcher });
    cleanups.push(() => direct.close());
    f.state.processes.push({ pid: 4321, state: 'S', command: `node ${f.root}/server/cos-runner/index.js` });
    await expect(direct.run()).rejects.toThrow('runner unavailable');
    f.state.processes.pop();
    f.state.clock = 5000;
    expect(await direct.run()).toMatchObject({ disposition: 'automatically-abandoned' });
  });

  it('preserves substantive remote uncertainty beside an empty legacy media row', async () => {
    const f = await fixture();
    const media = JSON.stringify({ jobs: [{}, { id: 'uncertain-request', status: 'failed', result: { topazUncertain: true } }] });
    writeFileSync(join(f.data, 'media-jobs.json'), media);
    await expect(f.recovery.run()).rejects.toThrow('saved media job');
    expect(readFileSync(join(f.data, 'media-jobs.json'), 'utf8')).toBe(media);
    expect(f.gate.operations()).toHaveLength(2);
  });

  it('does not dispose records after cancellation during activity inspection', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const recovery = await createUpdateReservationRecovery({ ...f.options, signal: controller.signal,
      scoped: async () => { controller.abort(new Error('update stopped')); return []; } });
    cleanups.push(() => recovery.close());
    await expect(recovery.run()).rejects.toThrow('update stopped');
    expect(f.gate.operations()).toHaveLength(2);
  });

  it('cleans up through the running auth store without restoring revoked sessions or losing new sessions', async () => {
    const f = await fixture();
    // Independent module instances represent the helper's pre-wait session
    // cache and the running API's later inventory, sharing the real store.
    vi.resetModules();
    const helperAuth = await import('../../server/services/auth.js');
    const revoked = await helperAuth.createSession();
    let apiAuth = helperAuth;
    f.state.authorize = header => apiAuth.verifySession(header?.replace(/^Bearer /, ''));
    f.state.revokeSession = id => apiAuth.revokeSessionById(id);
    const recovery = await createUpdateReservationRecovery({ ...f.options,
      mintSession: () => helperAuth.createSession({ label: 'update-recovery' }) });
    cleanups.push(() => recovery.close());
    await recovery.run();
    vi.resetModules();
    apiAuth = await import('../../server/services/auth.js');
    await apiAuth.revokeSessionById(revoked.id);
    const createdDuringWait = await apiAuth.createSession();
    await recovery.close();
    expect(await apiAuth.verifySession(revoked.token)).toBe(false);
    expect(await apiAuth.verifySession(createdDuringWait.token)).toBe(true);
    vi.resetModules();
    const reloaded = await import('../../server/services/auth.js');
    expect(await reloaded.verifySession(revoked.token)).toBe(false);
    expect(await reloaded.verifySession(createdDuringWait.token)).toBe(true);
  });
});
