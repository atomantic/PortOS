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
// `fast` shortens the proof deadline for a run that is MEANT to hit it. A run
// that must succeed uses `patient` instead: its restarted server is a real
// subprocess whose startup is CPU-bound — 1-2s idle, but 4-5s once the host is
// ~13x oversubscribed, with a valid proof published just AFTER a 4s deadline
// (#9368). Racing a clock against that startup made recovery flaky without
// exercising the cutover; `patient` returns the moment the proof lands, so it
// costs nothing when the host is healthy.
import { isProcessAlive } from '../test/processAlive.js';

const fast = { graceMs: 1500, pollMs: 20, proofTimeoutMs: 4000 };
const patient = { ...fast, proofTimeoutMs: 30_000 };
const alive = isProcessAlive;
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
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await cutover?.stopSurrogates();
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

// Defaults to `patient`; pass `fast` only where the run is expected to time out.
const run = async (options = patient) => {
  try {
    return await runDatabaseCutover(operation.id, token, options);
  } catch (err) {
    err.message += `\n--- cutover evidence ---\n${await evidence()}`;
    throw err;
  }
};
const savedMode = () => /^PGMODE=(\S+)/m.exec(readFileSync(join(root, '.env'), 'utf8'))?.[1];
const serverEvents = () => stubs.events().filter(line => line.startsWith('server '));
// Bounded, synthetic-only failure evidence, read BEFORE afterEach removes the
// disposable root (#8929): every fixture event, the operation's stage and
// coordinator state, the authority record's operation, each surrogate
// server's liveness, and the tail of their timestamped stderr trace — enough
// to tell a refused boot from one still waiting (or never started).
const bounded = read => { try { return read(); } catch (err) { return 'unreadable (' + (err.code ?? 'error') + ')'; } };
async function evidence() {
  // A signal-0 probe cannot distinguish a booting process from one suspended
  // before its first line. Keep only fixture-owned identities, never commands
  // or the rest of the host's process table.
  const processes = await snapshotProcesses().catch(() => null);
  const surrogates = (cutover?.surrogatePids() ?? []).slice(-20).map(pid => {
    const row = processes?.find(value => value.pid === pid);
    return { pid, alive: alive(pid), state: processes === null ? 'unavailable' : row?.state ?? 'gone',
      startedAt: row?.startedAt ?? null,
      targetProof: processes === null ? 'unavailable'
        : row ? bounded(() => journal.readTargetProof(operation.id, pid, row.startedAt) !== null) : 'process-gone' };
  });
  const log = join(stubs.dir, 'surrogate-stderr.log');
  return [
    `events (last 80): ${JSON.stringify(stubs.events().slice(-80))}`,
    `fenced: ${bounded(() => journal.isFenced())}; stage: ${bounded(() => journal.read()?.stage ?? 'none')}`,
    `coordinator: ${bounded(() => JSON.stringify(journal.coordinatorStatus(operation.id)))}`,
    `authority for this operation: ${bounded(() => createDatabaseAuthority(join(root, 'data')).read()?.operationId === operation.id)}`,
    `surrogates: ${JSON.stringify(surrogates)}`,
    `surrogate stderr: ${existsSync(log) ? readFileSync(log, 'utf8').slice(-3_000) : ''}`,
  ].join('\n');
}
// vi.waitFor that appends the evidence above when its deadline expires.
async function waitWithEvidence(assertion) {
  try {
    await vi.waitFor(assertion, { timeout: 15_000, interval: 20 });
  } catch (err) {
    err.message += `\n--- cutover evidence ---\n${await evidence()}`;
    throw err;
  }
}
const waitForEvent = (line) => waitWithEvidence(() => expect(stubs.events()).toContain(line));
const waitForProof = (pid) => waitWithEvidence(async () => expect(journal.readTargetProof(operation.id, pid, await processStart(pid))).not.toBeNull());

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
    await expect(run(fast)).rejects.toThrow(/did not prove the target backend[\s\S]*--- cutover evidence ---[\s\S]*events \(last 80\)[\s\S]*coordinator:[\s\S]*surrogate stderr:/);
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

  it('diagnoses a suspended server before startup, stays fenced, then recovers the same operation', async () => {
    begin();
    const restart = context.restart.getMockImplementation();
    context.restart.mockImplementation(async (...args) => {
      const result = await restart(...args);
      if (args[0] === 'portos-server') {
        // Delay the actual process, not a mock handshake or a longer deadline.
        process.kill(rows.find(row => row.name === 'portos-server').pid, 'SIGSTOP');
      }
      return result;
    });
    await expect(run(fast)).rejects.toThrow(/did not prove the target backend[\s\S]*"state":"T[^"]*"[\s\S]*"targetProof":false/);
    expect(journal.read().stage).toBe('verifying');
    expect(() => journal.assertAdmission()).toThrow();
    expect(context.restart).not.toHaveBeenCalledWith('portos-cos');

    // The already-started incarnation publishes its own proof after the
    // operator unblocks startup; recovery must neither restart nor re-import.
    const pid = rows.find(row => row.name === 'portos-server').pid;
    process.kill(pid, 'SIGCONT');
    await waitForProof(pid);
    successor();
    expect(await run()).toMatchObject({ stage: 'released', restartVerified: true });
    await waitForEvent(`server booted ${docker.port}`);
    expect(context.restart.mock.calls.filter(([name]) => name === 'portos-server')).toHaveLength(1);
    expect(stubs.invocations('pg_dump')).toHaveLength(1);
    expect(stubs.invocations('psql')).toHaveLength(1);
  }, 60_000);

  it('waits out a restarted server slower than the short proof deadline instead of racing it', async () => {
    begin();
    const restart = context.restart.getMockImplementation();
    let resume;
    context.restart.mockImplementation(async (...args) => {
      const result = await restart(...args);
      if (args[0] === 'portos-server') {
        // Hold the real process past `fast`'s deadline, as a CPU-starved host
        // does (#9368): the proof cannot exist until this timer resumes it.
        const { pid } = rows.find(row => row.name === 'portos-server');
        process.kill(pid, 'SIGSTOP');
        resume = setTimeout(() => process.kill(pid, 'SIGCONT'), fast.proofTimeoutMs + 500);
      }
      return result;
    });
    try {
      // Regression caught: a success-expected run abandoning a live, merely
      // slow server at the refusal deadline (the old flaky recovery).
      expect(await run()).toMatchObject({ stage: 'released', restartVerified: true });
    } finally {
      clearTimeout(resume);
    }
    await waitForEvent(`server booted ${docker.port}`);
    expect(context.restart.mock.calls.filter(([name]) => name === 'portos-server')).toHaveLength(1);
    expect(stubs.invocations('pg_dump')).toHaveLength(1);
    expect(stubs.invocations('psql')).toHaveLength(1);
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
    await expect(run(fast)).rejects.toThrow(/did not prove/);
    cutover.setHealth('healthy');
    // A healthy restarted server proves the target and waits at the fence.
    const pid = cutover.launchServer(docker);
    rows.find(row => row.name === 'portos-server').pid = pid;
    await waitForProof(pid);
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
    await expect(run(fast)).rejects.toThrow(/did not prove/);
    // PM2 now reports a process that never verified anything, holding a pid for
    // which an earlier (verified) process left a proof with its own start time.
    const impostor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    impostor.unref();
    try {
      const server = rows.find(row => row.name === 'portos-server');
      Object.assign(server, { pid: impostor.pid, status: 'online', surrogate: true });
      journal.recordTargetProof(operation.id, impostor.pid, Date.now() - 3_600_000);
      successor();
      await expect(run(fast)).rejects.toThrow(/did not prove the target backend/);
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
    await expect(run(fast)).rejects.toThrow(/did not prove/);
    cutover.setHealth('healthy');
    const pid = cutover.launchServer(docker);
    rows.find(row => row.name === 'portos-server').pid = pid;
    await waitForProof(pid);
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
