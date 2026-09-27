// Offline cutover past the transfer: forward-only mode commit, restart of the
// recorded server with the committed configuration, the restarted process's
// own target proof, and admission release. PM2 is mocked at its module
// boundary; pg_dump/psql are disposable stubs; the "server" is a surrogate
// process running the REAL boot handshake and boot fence against a stubbed pg
// module. No live database, PM2 daemon, install configuration or data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { STUB_DUMP_COMPLETE, installDatabaseStubs } from '../test/fixtures/databaseTransferStubs.js';
import { installCutoverStubs, restartedServerEndpoint } from '../test/fixtures/databaseCutoverStubs.js';
import { snapshotProcesses } from '../lib/detachedSpawn.js';

const context = vi.hoisted(() => ({ root: undefined, list: null, stop: null, restart: null }));
vi.mock('../lib/paths.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: new Proxy(actual.PATHS, {
    get: (target, key) => {
      if (key === 'data' && context.root) return context.root + '/data';
      if (key === 'installRoot' && context.root) return context.root;
      return target[key];
    },
  }) };
});
vi.mock('./pm2.js', () => ({
  listMaintenanceProcesses: (...args) => context.list(...args),
  stopApp: (...args) => context.stop(...args),
  restartMaintenanceProducer: (...args) => context.restart(...args),
}));
const { createDatabaseMaintenanceJournal } = await import('../lib/databaseMaintenanceJournal.js');
const { createDatabaseAuthority } = await import('../lib/databaseAuthority.js');
const { runDatabaseTransfer } = await import('./databaseMaintenanceTransfer.js');
const { runDatabaseCutover } = await import('./databaseMaintenanceCutover.js');

const native = { mode: 'native', host: 'db.example.invalid', port: 5432, database: 'example_test', user: 'example' };
const docker = { mode: 'docker', host: 'db.example.invalid', port: 5561, database: 'example_test', user: 'example' };
const fast = { graceMs: 1500, pollMs: 20, proofTimeoutMs: 4000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const processStart = async pid => process.platform === 'win32' ? null
  : (await snapshotProcesses()).find(row => row.pid === pid)?.startedAt;
const savedEnv = { ...process.env };

let root;
let journal;
let stubs;
let cutover;
let rows;
let operation;
let token;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'database-cutover-'));
  writeFileSync(join(root, '.portos-disposable-root'), '');
  mkdirSync(join(root, 'server', 'cos-runner'), { recursive: true });
  writeFileSync(join(root, 'server', 'start.js'), '');
  writeFileSync(join(root, 'server', 'cos-runner', 'index.js'), '');
  context.root = root;
  journal = createDatabaseMaintenanceJournal(join(root, 'data'));
  stubs = installDatabaseStubs(root);
  rows = [
    { name: 'portos-cos', pmId: 12, pid: 1012, status: 'online', cwd: root, script: 'server/cos-runner/index.js' },
    { name: 'portos-server', pmId: 13, pid: 1013, status: 'online', cwd: root, script: 'server/start.js' },
  ];
  // A surrogate server that exited (refused boot) reads back as errored.
  context.list = vi.fn(async () => rows.map(row => (row.surrogate && !alive(row.pid)
    ? { ...row, status: 'errored', pid: 0 } : { ...row })));
  context.stop = vi.fn(async id => {
    const row = rows.find(value => value.pmId === id);
    stubs.event('stop ' + row.name);
    row.status = 'stopped'; row.pid = 0;
    return { success: true };
  });
  // Emulates `pm2 restart ecosystem.config.cjs --only <name> --update-env`:
  // the server receives the endpoint the saved configuration names NOW.
  context.restart = vi.fn(async name => {
    stubs.event('restart ' + name);
    const row = rows.find(value => value.name === name);
    row.pid = name === 'portos-server' ? cutover.launchServer(restartedServerEndpoint(root, stubs.dir)) : 2012;
    row.surrogate = name === 'portos-server';
    row.status = 'online';
    return { success: true };
  });
  // The worker inherits its launcher's pre-cutover routing variables; they
  // must not redirect the saved-configuration probe or the PM2 restart.
  Object.assign(process.env, { PATH: `${stubs.bin}:${savedEnv.PATH}`, PGPASSWORD: 'example-password',
    PGHOST: 'inherited.example.invalid', PGPORT: '1', PGUSER: 'inherited', PGDATABASE: 'inherited',
    PORTOS_NATIVE_PGPORT: '2', PGPORT_DOCKER: '3' });
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const pid of cutover?.surrogatePids() ?? []) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  context.root = undefined;
  rmSync(root, { recursive: true, force: true });
});

function begin(source = native, target = docker) {
  cutover = installCutoverStubs(root, stubs.dir, { source, target });
  // Other saved settings must survive the mode commit byte for byte.
  writeFileSync(join(root, '.env'), `PGPASSWORD=example-password\nPGMODE=${source.mode}\nPORTOS_EXAMPLE=kept\n`);
  operation = journal.begin({ source, target });
  token = journal.acquireCoordinator(operation.id);
  journal.reserveCoordinatorWorker(operation.id, token);
}

// Same-operation recovery exactly as a detached supervisor receipt permits it.
function successor() {
  writeFileSync(join(root, 'data', 'database-maintenance', 'worker-' + token, 'exit'), '1\n');
  token = journal.prepareRecovery(operation.id);
  journal.reserveCoordinatorWorker(operation.id, token);
}

const run = () => runDatabaseCutover(operation.id, token, fast);
const savedMode = () => /^PGMODE=(\S+)/m.exec(readFileSync(join(root, '.env'), 'utf8'))?.[1];
const serverEvents = () => stubs.events().filter(line => line.startsWith('server '));
const waitForEvent = (line) => vi.waitFor(() => expect(stubs.events()).toContain(line), { timeout: 15_000, interval: 20 });

describe.skipIf(process.platform === 'win32')('offline database cutover', () => {
  it.each([[native, docker], [docker, native]])('commits mode and releases only after the restarted server proves the target (%#)', async (source, target) => {
    begin(source, target);
    const result = await run();
    expect(result).toEqual({ id: operation.id, stage: 'released', source: source.mode, target: target.mode,
      importCommitted: true, sourceRetained: true, restartVerified: true, cosRestarted: true });
    await waitForEvent(`server booted ${target.port}`);
    // Regression caught: a restart before the committed import, or a release
    // (CoS back online) before the restarted server's own proof.
    expect(stubs.events().slice(0, 6)).toEqual(['stop portos-cos', 'stop portos-server', 'dump writer=none',
      'import-start', 'import-commit', 'restart portos-server']);
    expect(stubs.events().indexOf('restart portos-cos')).toBeGreaterThan(stubs.events().indexOf('restart portos-server'));
    // PM2 re-evaluates the ecosystem with the RECORDED endpoints, not inherited overrides.
    const [, restartEnv] = context.restart.mock.calls.find(([name]) => name === 'portos-server');
    expect(restartEnv).toMatchObject({ PGHOST: target.host, PGUSER: target.user, PGDATABASE: target.database,
      PORTOS_NATIVE_PGPORT: String(native.port), PGPORT_DOCKER: String(docker.port) });
    expect(restartEnv.PGPORT).toBeUndefined();
    expect(readFileSync(join(root, '.env'), 'utf8'))
      .toBe(`PGPASSWORD=example-password\nPGMODE=${target.mode}\nPORTOS_EXAMPLE=kept\n`);
    // Admission is open; the authority record retires the source endpoint.
    expect(journal.read()).toBeNull();
    expect(() => journal.assertAdmission()).not.toThrow();
    expect(createDatabaseAuthority(join(root, 'data')).read()).toMatchObject({ operationId: operation.id, source, target });
    expect(existsSync(join(root, 'data', 'database-maintenance-completed', operation.id, 'operation.json'))).toBe(true);
    // The source recovery copy is retained.
    expect(readFileSync(join(root, 'data', 'db-dumps', `portos-maintenance-${operation.id}.sql`), 'utf8')).toBe(STUB_DUMP_COMPLETE);

    // Release admits no process still pointed at the retired source.
    cutover.launchServer(source);
    await waitForEvent('server refused DATABASE_RETIRED_BACKEND');
    expect(serverEvents().filter(line => line.startsWith('server booted'))).toEqual([`server booted ${target.port}`]);
  }, 60_000);

  it.each(['wrong pool', 'unhealthy target'])('stays fenced when the restarted server cannot prove the target (%s), then recovers the same operation', async (fault) => {
    begin();
    if (fault === 'wrong pool') cutover.overrideRestartPool(native);
    else cutover.setHealth('unhealthy');
    await expect(run()).rejects.toThrow(/did not prove the target backend/);
    await waitForEvent('server refused DATABASE_MAINTENANCE');
    // Mode is committed forward, but PM2 `online`/saved mode is not success.
    expect(journal.read()).toEqual({ ...operation, stage: 'verifying' });
    expect(savedMode()).toBe('docker');
    expect(() => journal.assertAdmission()).toThrow();
    expect(createDatabaseAuthority(join(root, 'data')).read()).toBeNull();
    expect(context.restart).not.toHaveBeenCalledWith('portos-cos');

    // Operator repairs the backend; same-operation recovery restarts the
    // crashed server once more and never re-exports, re-imports or reverses.
    cutover.clearRestartPool();
    cutover.setHealth('healthy');
    successor();
    expect(await run()).toMatchObject({ stage: 'released', restartVerified: true });
    await waitForEvent(`server booted ${docker.port}`);
    expect(stubs.invocations('pg_dump')).toHaveLength(1);
    expect(stubs.invocations('psql')).toHaveLength(1);
    expect(journal.read()).toBeNull();
  }, 60_000);

  it.each(['before', 'after', 'reverted'])('recovers a mode commit interrupted %s the .env write without guessing or reversing', async (point) => {
    begin();
    await runDatabaseTransfer(operation.id, token, fast);
    // The crashed worker published `committing`, then died.
    journal.transition(operation.id, token, 'importing', 'committing');
    const env = readFileSync(join(root, '.env'), 'utf8');
    if (point === 'after') writeFileSync(join(root, '.env'), env.replace('PGMODE=native', 'PGMODE=docker'));
    if (point === 'reverted') writeFileSync(join(root, '.env'), env.replace('PGMODE=native\n', ''));
    successor();
    expect(await run()).toMatchObject({ stage: 'released', source: 'native', target: 'docker' });
    // The recorded target — never the file's current contents — decides.
    expect(savedMode()).toBe('docker');
    expect(readFileSync(join(root, '.env'), 'utf8')).toMatch(/PORTOS_EXAMPLE=kept/);
    expect(stubs.invocations('psql')).toHaveLength(1);
    await waitForEvent(`server booted ${docker.port}`);
  }, 60_000);

  it('keeps a verified-but-unreleased operation fenced until recovery releases it', async () => {
    begin();
    cutover.setHealth('unhealthy');
    await expect(run()).rejects.toThrow(/did not prove/);
    cutover.setHealth('healthy');
    // A healthy restarted server proves the target and waits at the fence.
    const pid = cutover.launchServer(docker);
    rows.find(row => row.name === 'portos-server').pid = pid;
    await vi.waitFor(async () => expect(journal.readTargetProof(operation.id, pid, await processStart(pid))).not.toBeNull(), { timeout: 15_000, interval: 20 });
    // A worker crashes between verification and release.
    successor();
    journal.enterCoordinatorWorker(operation.id, token);
    journal.transition(operation.id, token, 'verifying', 'verified');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(serverEvents().filter(line => line.startsWith('server booted'))).toEqual([]);
    expect(() => journal.assertAdmission()).toThrow();

    successor();
    expect(await run()).toMatchObject({ stage: 'released' });
    await waitForEvent(`server booted ${docker.port}`);
    expect(journal.read()).toBeNull();
    // Repeated recovery of a released operation has nothing to reopen.
    expect(() => journal.prepareRecovery(operation.id)).toThrow();
  }, 60_000);

  it('never accepts a proof written by an earlier process whose pid was reused', async () => {
    begin();
    cutover.setHealth('unhealthy');
    await expect(run()).rejects.toThrow(/did not prove/);
    // PM2 now reports a process that never verified anything, holding a pid for
    // which an earlier (verified) process left a proof with its own start time.
    const impostor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    impostor.unref();
    try {
      const server = rows.find(row => row.name === 'portos-server');
      Object.assign(server, { pid: impostor.pid, status: 'online', surrogate: true });
      journal.recordTargetProof(operation.id, impostor.pid, Date.now() - 3_600_000);
      successor();
      await expect(run()).rejects.toThrow(/did not prove the target backend/);
      expect(journal.read().stage).toBe('verifying');
      expect(() => journal.assertAdmission()).toThrow();
      // The new incarnation can publish its own proof without colliding with
      // immutable evidence left by the earlier holder of this PID.
      const startedAt = await processStart(impostor.pid);
      expect(journal.recordTargetProof(operation.id, impostor.pid, startedAt)).toMatchObject({ startedAt });
      expect(journal.readTargetProof(operation.id, impostor.pid, startedAt)).toMatchObject({ startedAt });
    } finally {
      impostor.kill('SIGKILL');
    }
  }, 60_000);

  it('refuses to release onto a saved configuration edited away from the target', async () => {
    begin();
    cutover.setHealth('unhealthy');
    await expect(run()).rejects.toThrow(/did not prove/);
    cutover.setHealth('healthy');
    const pid = cutover.launchServer(docker);
    rows.find(row => row.name === 'portos-server').pid = pid;
    await vi.waitFor(async () => expect(journal.readTargetProof(operation.id, pid, await processStart(pid))).not.toBeNull(), { timeout: 15_000, interval: 20 });
    successor();
    journal.enterCoordinatorWorker(operation.id, token);
    journal.transition(operation.id, token, 'verifying', 'verified');
    writeFileSync(join(root, '.env'), readFileSync(join(root, '.env'), 'utf8').replace('PGMODE=docker', 'PGMODE=native'));
    successor();
    await expect(run()).rejects.toThrow(/saved configuration does not resolve/);
    expect(journal.read().stage).toBe('verified');
    expect(() => journal.assertAdmission()).toThrow();
  }, 60_000);

  it('reuses one persisted successor across repeated recovery requests', async () => {
    begin();
    writeFileSync(join(root, 'data', 'database-maintenance', 'worker-' + token, 'exit'), '1\n');
    const first = journal.prepareRecovery(operation.id);
    // A retry before the successor launched gets the SAME token, not a second owner.
    expect(journal.prepareRecovery(operation.id)).toBe(first);
    journal.reserveCoordinatorWorker(operation.id, first);
    expect(journal.prepareRecovery(operation.id)).toBeNull();
    expect(() => journal.reserveCoordinatorWorker(operation.id, first)).toThrow();
    expect(journal.coordinatorStatus(operation.id)).toEqual({ state: 'awaiting-exit' });
  });
});
