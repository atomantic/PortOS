import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync as fsReaddir } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createMaintenanceAdmission } from '../server/lib/maintenanceAdmission.js';
import { createMaintenanceJournal } from '../server/lib/maintenanceJournal.js';
import { processAbsent, reconcileReusedLaunch } from '../server/lib/maintenanceDeferredUpdate.js';
import { trackedRenderMap } from '../server/services/renderActivity.js';
import { runDeferredUpdate, settleInterruptedUpdate } from './deferred-update.mjs';
import { installUpdateTestSupervisor } from './lib/updateTestSupervisor.js';
import { portosServiceListeners } from './lib/legacyUpdateActivity.mjs';

const roots = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'deferred-update-test-'));
  roots.push(root);
  return { root, admission: createMaintenanceAdmission(join(root, 'data')) };
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const completedLaunch = admission => (_command, _args, options) => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.kill = vi.fn();
  const id = options.env.PORTOS_DEFERRED_UPDATE_ID;
  admission.deferredUpdate.enter(id, child.pid);
  admission.deferredUpdate.terminal(id, child.pid, true);
  setImmediate(() => child.emit('close', 0));
  return child;
};

describe('deferred update admission', () => {
  it('allows the first handoff activity cache to refresh before asking an idle manual caller to interrupt', async () => {
    const { root, admission } = fixture(); let clock = 0;
    const confirmInterruption = vi.fn(async () => false);
    await expect(runDeferredUpdate({ admission, cwd: root, policy: 'manual', launch: completedLaunch(admission),
      recoverReservations: async () => { if (clock < 5000) throw new Error('initial handoff activity is cached'); },
      legacyRunning: async () => false, wait: async () => { clock += 1000; }, confirmInterruption, absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(confirmInterruption).not.toHaveBeenCalled();
  });
  it.each([false, true])('gives a transferred childless waiter time to exit while protecting real installer=%s', async realInstaller => {
    const { root, admission } = fixture();
    const previous = admission.deferredUpdate.request();
    createMaintenanceJournal(join(root, 'data')).transaction(state => { state.operations.find(op => op.id === previous.id).pid = 2468; });
    const reconcile = admission.deferredUpdate.reconcile;
    vi.spyOn(admission.deferredUpdate, 'reconcile').mockImplementation(options => reconcile({ ...options,
      absent: pid => pid === 2468 ? false : processAbsent(pid) }));
    let waiting = true;
    const wait = vi.fn(async () => { waiting = false; });
    const launch = vi.fn(completedLaunch(admission));
    const options = { admission, cwd: root, policy: 'interrupt', launch, emit: vi.fn(),
      legacySnapshot: async () => [
        { pid: process.pid, ppid: 1, state: 'S', command: 'node updater' },
        ...(waiting ? [{ pid: 2468, ppid: 1, state: 'S', command: 'node scripts/deferred-update.mjs --automatic' }] : []),
        ...(realInstaller ? [{ pid: 2469, ppid: 2468, state: 'S', command: 'npm install' }] : []),
      ], legacyCwds: async () => new Map([[2468, root], [2469, root]]), legacyGroups: async () => [],
      wait, absent: () => true };
    if (realInstaller) {
      await expect(runDeferredUpdate(options)).rejects.toMatchObject({ code: 'MAINTENANCE_HELD' });
      expect(launch).not.toHaveBeenCalled();
    } else {
      await expect(runDeferredUpdate(options)).resolves.toBe(0);
      expect(launch).toHaveBeenCalledOnce();
      expect(wait).toHaveBeenCalledOnce();
    }
  });
  it.each(['node start.js', 'node --watch start.js', 'node "C:\\npm\\pm2\\lib\\ProcessContainerFork.js"'])('attributes a Windows runtime without a cwd by its actual listener: %s', async command => {
    const { root, admission } = fixture();
    const operation = admission.deferredUpdate.request();
    admission.deferredUpdate.acquire(operation.id, { interrupt: true }); admission.deferredUpdate.enter(operation.id, process.pid);
    const options = { admission, cwd: root, platform: 'win32', snapshot: async () => [
      { pid: process.pid, command: 'node updater', state: 'S' }, { pid: 2468, command, state: 'S' },
    ], probeCwds: async () => new Map() };
    await expect(settleInterruptedUpdate(operation.id, { ...options, listeners: async () => [{ pid: 2468, port: 6003 }] })).rejects.toThrow('PID 2468 still owns service port 6003');
    await expect(settleInterruptedUpdate(operation.id, { ...options, listeners: async () => { throw new Error('denied'); } })).rejects.toThrow('listener ownership could not be inspected');
    // A generic relative Node command is not attributed to PortOS by name.
    await expect(settleInterruptedUpdate(operation.id, { ...options, listeners: async () => [{ pid: 9999, port: 6003 }] })).resolves.toBeUndefined();
  });

  it('uses configured mirror and runner listener ports and excludes standalone Chrome CDP', async () => {
    const { root } = fixture();
    writeFileSync(join(root, '.env'), 'PORTOS_HTTP_PORT=6003\nCOS_RUNNER_URL=http://127.0.0.1:6008\n');
    const result = await portosServiceListeners(root, { platform: 'win32', env: {}, run: async () => ({ stdout: JSON.stringify([
      { OwningProcess: 1, LocalPort: 6003 }, { OwningProcess: 2, LocalPort: 6008 },
      { OwningProcess: 3, LocalPort: 5553 }, { OwningProcess: 4, LocalPort: 5558 }, { OwningProcess: 5, LocalPort: 5556 },
    ]) }) });
    expect(result).toEqual([{ pid: 1, port: 6003 }, { pid: 2, port: 6008 }]);
  });

  it('allows acknowledged manual recovery without an activity API, fences new work, and records dead reservations as interrupted', async () => {
    const { root, admission } = fixture();
    const journal = createMaintenanceJournal(join(root, 'data'));
    const stale = admission.admit('api-run', 'old-provider-call');
    journal.transaction(state => { state.operations.find(op => op.id === stale.id).pid = 2147483647; });
    const recover = vi.fn(async () => { throw new Error('old API unavailable'); });
    const launch = vi.fn((_command, _args, options) => {
      const child = new EventEmitter(); child.pid = 4321; child.kill = vi.fn();
      const id = options.env.PORTOS_DEFERRED_UPDATE_ID;
      admission.deferredUpdate.enter(id, child.pid);
      expect(options.env.PORTOS_UPDATE_INTERRUPT).toBe('1');
      expect(() => admission.admit('agent', 'new-task')).toThrow();
      setImmediate(async () => {
        await settleInterruptedUpdate(id, { admission, cwd: root, snapshot: async () => [{ pid: process.pid, command: 'node updater', state: 'S' }], probeCwds: async () => new Map() });
        admission.deferredUpdate.terminal(id, child.pid, true);
        child.emit('close', 0);
      });
      return child;
    });
    await expect(runDeferredUpdate({ admission, policy: 'interrupt', launch, recoverReservations: recover,
      legacyRunning: async () => false, absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(recover).not.toHaveBeenCalled();
    const receipt = JSON.parse(readFileSync(join(admission.directory, fsReaddir(admission.directory).find(name => name.startsWith('update-interrupted-'))), 'utf8'));
    expect(receipt).toMatchObject({ disposition: 'interrupted', outputCompleteness: 'unknown', operations: [expect.objectContaining({ id: stale.id })] });
    expect(admission.operations()).toEqual([]);
  });

  it('returns an actionable manual warning instead of waiting indefinitely on unavailable activity', async () => {
    const { root, admission } = fixture();
    const launch = vi.fn();
    await expect(runDeferredUpdate({ admission, cwd: root, policy: 'manual', launch, recoverReservations: async () => { throw new Error('unavailable'); },
      legacyRunning: async () => false, wait: async () => {}, confirmInterruption: async () => false, emit: vi.fn() }))
      .rejects.toMatchObject({ code: 'UPDATE_INTERRUPTION_REQUIRED' });
    expect(launch).not.toHaveBeenCalled();
    expect(admission.deferredUpdate.operation()).toBeNull();
  });

  it.each(['database-maintenance', 'database-restore-recovery.json'])('does not bypass %s under manual acknowledgment', async name => {
    const { root, admission } = fixture();
    mkdirSync(join(root, 'data'), { recursive: true });
    if (name.endsWith('.json')) writeFileSync(join(root, 'data', name), '{}');
    else mkdirSync(join(root, 'data', name));
    const launch = vi.fn();
    await expect(runDeferredUpdate({ admission, policy: 'interrupt', launch, legacyRunning: async () => false, emit: vi.fn() }))
      .rejects.toMatchObject({ code: 'MAINTENANCE_HELD' });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['node /install/server/start.js', 'node start.js', 'node --watch start.js'])('requires the actual runtime to stop before retirement: %s', async command => {
    const { admission } = fixture();
    const operation = admission.deferredUpdate.request();
    admission.deferredUpdate.acquire(operation.id, { interrupt: true });
    admission.deferredUpdate.enter(operation.id, process.pid);
    await expect(settleInterruptedUpdate(operation.id, { admission, cwd: '/install', snapshot: async () => [{ pid: process.pid, command: 'node updater', state: 'S' }, { pid: 2468, command, state: 'S' }],
      probeCwds: async () => new Map([[2468, '/install/server']]) })).rejects.toThrow('runtime PID 2468');
    expect(admission.deferredUpdate.operation().phase).toBe('running');
  });
  it('waits on positively observed legacy activity even when no work reservation remains', async () => {
    const { admission } = fixture();
    let active = true;
    const launch = vi.fn(completedLaunch(admission));
    const recoverReservations = vi.fn(async () => {
      if (active) throw new Error('PortOS has running work');
    });
    const wait = vi.fn(async () => { expect(launch).not.toHaveBeenCalled(); active = false; });
    await expect(runDeferredUpdate({ admission, launch, wait, recoverReservations,
      legacyRunning: async () => false, absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
    expect(recoverReservations).toHaveBeenCalledTimes(2);
  });

  it('hands a childless waiting owner to new scripts and preserves its interrupted history', () => {
    const { root, admission } = fixture();
    const previous = admission.deferredUpdate.request();
    const next = admission.deferredUpdate.request({ recoverWaiting: true });
    expect(next.id).not.toBe(previous.id);
    expect(next.requestedAt).toBe(previous.requestedAt);
    expect(() => admission.deferredUpdate.acquire(previous.id)).toThrow(/ownership changed/);
    expect(() => admission.deferredUpdate.finish(previous.id, false)).toThrow(/ownership changed/);
    expect(admission.deferredUpdate.operation()).toEqual(next);
    expect(admission.deferredUpdate.get().result).toMatchObject({ id: previous.id, success: false, interrupted: true });
    expect(JSON.parse(readFileSync(join(root, 'data/workflow-maintenance', `update-handoff-${next.id}.json`), 'utf8')))
      .toMatchObject({ previous, successorId: next.id, disposition: 'waiting-update-replaced' });
    admission.deferredUpdate.finish(next.id, false);
  });

  it('hands off a UI retry through a launch ticket without losing the original request identity', () => {
    const { admission } = fixture();
    const previous = admission.deferredUpdate.request();
    const ticket = admission.deferredUpdate.reserveLaunch({ recoverWaiting: true });
    admission.deferredUpdate.bindLaunch(ticket, process.pid);
    expect(admission.deferredUpdate.reconcile().operation).toBeNull();
    const next = admission.deferredUpdate.claimLaunch(ticket);
    expect(next.requestedAt).toBe(previous.requestedAt);
    expect(() => admission.deferredUpdate.acquire(previous.id)).toThrow();
    expect(admission.deferredUpdate.acquire(next.id)).toBe(true);
    expect(() => admission.deferredUpdate.reserveLaunch({ recoverWaiting: true })).toThrow();
    expect(() => admission.deferredUpdate.request({ recoverWaiting: true })).toThrow();
    expect(admission.deferredUpdate.operation().phase).toBe('starting');
    admission.deferredUpdate.enter(next.id, process.pid);
    expect(() => admission.deferredUpdate.request({ recoverWaiting: true })).toThrow();
    admission.deferredUpdate.finish(next.id, false);
  });

  it('ignores exact empty legacy media rows while retaining real recovery jobs and the original file', async () => {
    const { root, admission } = fixture();
    mkdirSync(join(root, 'data'), { recursive: true });
    const path = join(root, 'data/media-jobs.json');
    const original = JSON.stringify({ jobs: [{}, { id: 'remote-job', status: 'failed', result: { topazUncertain: true } }] });
    writeFileSync(path, original);
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => {
      expect(launch).not.toHaveBeenCalled();
      expect(readFileSync(path, 'utf8')).toBe(original);
      writeFileSync(path, JSON.stringify({ jobs: [{}, { id: 'remote-job', status: 'completed' }] }));
    });
    await expect(runDeferredUpdate({ admission, launch, wait, legacyRunning: async () => false,
      absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(path, 'utf8')).jobs).toHaveLength(2);
  });

  it('atomically cancels a pending launch so a late supervisor cannot start', () => {
    const { admission } = fixture();
    const first = admission.deferredUpdate.reserveLaunch();
    expect(() => admission.deferredUpdate.request()).toThrow();
    expect(admission.deferredUpdate.cancelLaunch(first)).toEqual({ state: 'canceled' });
    expect(() => admission.deferredUpdate.claimLaunch(first)).toThrow();
    const second = admission.deferredUpdate.reserveLaunch();
    expect(second).not.toBe(first);
    expect(admission.deferredUpdate.cancelLaunch(second)).toEqual({ state: 'canceled' });
  });

  it('preserves a claimed launch when cancellation loses the race', () => {
    const { admission } = fixture();
    const ticket = admission.deferredUpdate.reserveLaunch();
    const operation = admission.deferredUpdate.claimLaunch(ticket);
    expect(admission.deferredUpdate.cancelLaunch(ticket)).toEqual({ state: 'claimed', ownerPid: process.pid });
    expect(admission.deferredUpdate.acquire(operation.id)).toBe(true);
    admission.deferredUpdate.finish(operation.id, false);
    expect(admission.deferredUpdate.cancelLaunch(ticket)).toMatchObject({ state: 'finished', result: { success: false } });
  });

  it('cancels an orphaned prelaunch ticket before accepting a new update', () => {
    const { root, admission } = fixture();
    const ticket = admission.deferredUpdate.reserveLaunch();
    const journal = createMaintenanceJournal(join(root, 'data'));
    journal.transaction(state => { state.operations.find(op => op.id === ticket).pid = 2147483647; });
    admission.deferredUpdate.reconcile({ absent: () => true });
    expect(() => admission.deferredUpdate.claimLaunch(ticket)).toThrow();
    const next = admission.deferredUpdate.request();
    admission.deferredUpdate.finish(next.id, false);
  });

  it('reconciles a dead pre-claim child without waiting for its still-live launcher', () => {
    const { admission } = fixture();
    const ticket = admission.deferredUpdate.reserveLaunch();
    admission.deferredUpdate.bindLaunch(ticket, 2147483647);
    admission.deferredUpdate.reconcile({ absent: pid => pid === 2147483647 });
    expect(admission.deferredUpdate.launch()).toBeNull();
    expect(() => admission.deferredUpdate.claimLaunch(ticket)).toThrow();
  });

  it.each([false, true])('retires an unclaimed launch whose launcher PID was reused (bound child: %s)', async bound => {
    const { root, admission } = fixture();
    const ticket = admission.deferredUpdate.reserveLaunch();
    if (bound) admission.deferredUpdate.bindLaunch(ticket, process.pid);
    const journal = createMaintenanceJournal(join(root, 'data'));
    journal.transaction(state => { state.operations.find(op => op.id === ticket).startedAt = new Date(Date.now() - 10000).toISOString(); });
    await reconcileReusedLaunch(admission, async () => [{ pid: process.pid, startedAt: Date.now() }]);
    expect(admission.deferredUpdate.launch()).toBeNull();
    expect(() => admission.deferredUpdate.claimLaunch(ticket)).toThrow();
    const next = admission.deferredUpdate.request();
    admission.deferredUpdate.finish(next.id, false);
  });

  it('preserves a launch that is claimed while process identity is inspected', async () => {
    const { root, admission } = fixture();
    const ticket = admission.deferredUpdate.reserveLaunch();
    const journal = createMaintenanceJournal(join(root, 'data'));
    journal.transaction(state => { state.operations.find(op => op.id === ticket).startedAt = new Date(Date.now() - 10000).toISOString(); });
    await reconcileReusedLaunch(admission, async () => {
      admission.deferredUpdate.claimLaunch(ticket);
      return [{ pid: process.pid, startedAt: Date.now() }];
    });
    expect(admission.deferredUpdate.operation()?.id).toBe(ticket);
    admission.deferredUpdate.finish(ticket, false);
  });
  it('does not rewrite the journal while blocked, but still rechecks before taking a hold', async () => {
    const { admission } = fixture();
    const work = admission.admit('media', 'render');
    const update = admission.deferredUpdate.request();
    const revision = admission.status().revision;
    expect(admission.deferredUpdate.acquire(update.id)).toBe(false);
    expect(admission.deferredUpdate.acquire(update.id)).toBe(false);
    expect(admission.status().revision).toBe(revision);
    await work.finish();
    expect(admission.deferredUpdate.acquire(update.id)).toBe(true);
    expect(() => admission.admit('media', 'late-render')).toThrow();
    admission.deferredUpdate.finish(update.id, false);
  });

  it('does not hide an interrupted journal transaction behind a blocked poll', () => {
    const { root, admission } = fixture();
    admission.admit('media', 'render');
    const update = admission.deferredUpdate.request();
    mkdirSync(join(root, 'data/workflow-maintenance/transaction'));
    expect(() => admission.deferredUpdate.acquire(update.id)).toThrow(/maintenance state needs recovery/i);
  });
  it('waits for saved remote recovery even when there is no admission reservation', async () => {
    const { root, admission } = fixture();
    mkdirSync(join(root, 'data'), { recursive: true });
    const mediaPath = join(root, 'data/media-jobs.json');
    const job = { status: 'failed', result: { topazUncertain: true } };
    writeFileSync(mediaPath, JSON.stringify({ jobs: [job] }));
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => {
      expect(launch).not.toHaveBeenCalled();
      job.result.topazUncertain = false;
      writeFileSync(mediaPath, JSON.stringify({ jobs: [job] }));
    });
    await expect(runDeferredUpdate({ admission, launch, wait, absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
  });
  it('leaves the journal usable if saved media changes before the locked check', async () => {
    const { root, admission } = fixture();
    mkdirSync(join(root, 'data'), { recursive: true });
    const mediaPath = join(root, 'data/media-jobs.json');
    writeFileSync(mediaPath, JSON.stringify({ jobs: [] }));
    await expect(runDeferredUpdate({ admission, launch: completedLaunch(admission), emit: vi.fn(),
      legacyRunning: async () => { writeFileSync(mediaPath, '{'); return false; } })).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
    expect(admission.status().state).toBe('normal');
    writeFileSync(mediaPath, JSON.stringify({ jobs: [] }));
    const next = admission.deferredUpdate.request();
    expect(admission.deferredUpdate.acquire(next.id)).toBe(true);
    admission.deferredUpdate.finish(next.id, false);
  });
  it('does not treat a saved local running status as a live offline job', async () => {
    const { root, admission } = fixture();
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data/media-jobs.json'), JSON.stringify({ jobs: [{ status: 'running', kind: 'video' }] }));
    const wait = vi.fn();
    await expect(runDeferredUpdate({ admission, launch: completedLaunch(admission), wait, legacyRunning: async () => false,
      absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).not.toHaveBeenCalled();
  });
  it('waits for an older live accelerator claimant even without an admission row', async () => {
    const { root, admission } = fixture();
    mkdirSync(join(root, 'data'), { recursive: true });
    const claim = join(root, 'data/heavy-local-job.claim.json');
    writeFileSync(claim, JSON.stringify({ pid: process.pid, kind: 'assessment', id: 'model' }));
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => { expect(launch).not.toHaveBeenCalled(); rmSync(claim); });
    await expect(runDeferredUpdate({ admission, launch, wait, legacyRunning: async () => false,
      legacySnapshot: async () => [{ pid: process.pid, startedAt: Date.now() - 10000 }],
      absent: pid => pid !== process.pid, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
  });
  it('waits through an incomplete claim handoff, then the actual claimant', async () => {
    const { root, admission } = fixture();
    mkdirSync(join(root, 'data'), { recursive: true });
    const path = join(root, 'data/heavy-local-job.claim.json');
    writeFileSync(path, '');
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => {
      expect(launch).not.toHaveBeenCalled();
      if (wait.mock.calls.length === 1) writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'example' }));
      else rmSync(path);
    });
    await expect(runDeferredUpdate({ admission, launch, wait, legacyRunning: async () => false,
      legacySnapshot: async () => [{ pid: process.pid, startedAt: Date.now() - 10000 }],
      absent: pid => pid !== process.pid, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledTimes(2);
  });
  it('does not let a completed claim or zombie owner hold a new update', async () => {
    for (const zombie of [false, true]) {
      const { root, admission } = fixture();
      mkdirSync(join(root, 'data'), { recursive: true });
      const path = join(root, 'data/heavy-local-job.claim.json');
      writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'completed-token' }));
      if (!zombie) writeFileSync(`${path}.completed.json`, JSON.stringify({ token: 'completed-token', pid: process.pid, ownerPid: process.pid, finishedAt: new Date().toISOString() }));
      const wait = vi.fn();
      await expect(runDeferredUpdate({ admission, launch: completedLaunch(admission), wait, legacyRunning: async () => false,
        legacySnapshot: async () => [{ pid: process.pid, startedAt: Date.now() - 10000, state: zombie ? 'Z' : 'S' }],
        absent: pid => pid !== process.pid, emit: vi.fn() })).resolves.toBe(0);
      expect(wait).not.toHaveBeenCalled();
    }
  });
  it('still waits for a live child after its parent recorded claim cleanup', async () => {
    const { root, admission } = fixture();
    mkdirSync(join(root, 'data'), { recursive: true });
    const path = join(root, 'data/heavy-local-job.claim.json');
    writeFileSync(path, JSON.stringify({ pid: 4002, token: 'handoff-token' }));
    writeFileSync(`${path}.completed.json`, JSON.stringify({ token: 'handoff-token', pid: 4002,
      ownerPid: process.pid, finishedAt: new Date().toISOString() }));
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => { expect(launch).not.toHaveBeenCalled(); rmSync(path); });
    await expect(runDeferredUpdate({ admission, launch, wait, legacyRunning: async () => false,
      legacySnapshot: async () => [{ pid: 4002, state: 'S', startedAt: Date.now() - 10000 }],
      absent: pid => pid !== 4002, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
  });
  it('waits for pending database restore repair before taking the update hold', async () => {
    const { root, admission } = fixture();
    mkdirSync(join(root, 'data'), { recursive: true });
    const journal = join(root, 'data/database-restore-recovery.json');
    writeFileSync(journal, '{}');
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => { expect(launch).not.toHaveBeenCalled(); rmSync(journal); });
    await expect(runDeferredUpdate({ admission, launch, wait, legacyRunning: async () => false, absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
  });
  it.each(['render', 'trainer', 'grok', 'grok-failed', 'segment-failed', 'database-restore'])('waits when a saved local %s still has an observable child process', async kind => {
    const { root, admission } = fixture();
    mkdirSync(join(root, 'data'), { recursive: true });
    const id = '12345678-1234-4234-8234-123456789abc';
    const runId = '87654321-4321-4321-8321-cba987654321';
    const childId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    writeFileSync(join(root, 'data/media-jobs.json'), JSON.stringify({ jobs: [{ id, status: kind.endsWith('-failed') ? 'failed' : 'running', kind,
      params: { runId }, ...(kind === 'segment-failed' ? { videoExecutions: [{ childJobId: childId }] } : {}) }] }));
    let running = true;
    const legacySnapshot = async () => [{ pid: process.pid, ppid: 1, command: 'node supervisor' },
      ...(running ? [{ pid: 4002, ppid: 1, command: kind === 'render' ? `ffmpeg -i ${root}/data/videos/${id}.mp4`
        : kind === 'trainer' ? `python ${root}/data/training-runs/${runId}/trainer.py`
          : kind === 'segment-failed' ? `python render.py --output ${root}/data/videos/${childId}.mp4`
            : kind === 'database-restore' ? 'psql -f /tmp/portos-restore-ABC123/dump.sql.replay' : 'grok -p -' }] : [])];
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => { expect(launch).not.toHaveBeenCalled(); running = false; });
    await expect(runDeferredUpdate({ admission, launch, wait, cwd: root, legacySnapshot,
      legacyCwds: async () => kind.startsWith('grok') ? new Map([[4002, join(tmpdir(), `portos-grok-video-${id}`)]]) : new Map(),
      absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
  });
  it('lets a release launch children while waiting, then atomically fences a late render through final saving', async () => {
    const { admission } = fixture();
    const release = admission.admit('agent', 'release-example');
    const renders = trackedRenderMap('deferred-test', { admission });
    const launch = vi.fn(completedLaunch(admission));
    let turn = 0;
    await expect(runDeferredUpdate({ admission, launch, absent: () => true, emit: vi.fn(), wait: async () => {
      turn++;
      expect(admission.held()).toBe(false);
      if (turn === 1) {
        const child = admission.admit('agent', 'release-child-example');
        await release.finish();
        renders.set('final-render', 'job-example');
        await child.finish();
      } else {
        expect(launch).not.toHaveBeenCalled();
        // Encoding ended, but the render owns the delayed final write too.
        expect(admission.deferredUpdate.acquire(admission.deferredUpdate.get().operation.id)).toBe(false);
        renders.delete('final-render');
      }
    } })).resolves.toBe(0);
    expect(turn).toBe(2);
    expect(launch).toHaveBeenCalledOnce();
    expect(admission.status().state).toBe('normal');
    expect(admission.deferredUpdate.get().result.success).toBe(true);
    const next = admission.deferredUpdate.request();
    expect(admission.deferredUpdate.acquire(next.id)).toBe(true);
    expect(() => renders.set('racing-render', 'job')).toThrow(/holding new work/);
    expect(() => admission.resume(admission.status().hold)).toThrow();
    admission.deferredUpdate.finish(next.id, false);
  });

  it('continues past stale legacy control files without claiming success for the old update', async () => {
    const { root, admission } = fixture();
    const control = join(root, 'data/update-detached');
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'pid'), '4001');
    const launch = vi.fn(completedLaunch(admission));
    const legacySnapshot = async () => [{ pid: process.pid, ppid: 1, command: 'node supervisor' },
      { pid: 4001, ppid: 1, command: `bash ${root}-copy/update.sh` }];
    const wait = vi.fn();
    await expect(runDeferredUpdate({ admission, launch, wait, cwd: root, legacySnapshot,
      legacyCwds: async () => new Map([[4001, `${root}-copy`]]), absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).not.toHaveBeenCalled();
    expect(readFileSync(join(control, 'pid'), 'utf8')).toBe('4001');
  });

  it.each(['relative updater', 'surviving npm child'])('waits for a live same-install %s despite a legacy exit file', async kind => {
    const { root, admission } = fixture();
    const control = join(root, 'data/update-detached');
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'pid'), '4001');
    writeFileSync(join(control, 'exit'), '1');
    if (kind === 'surviving npm child') {
      const writer = join(root, 'data/database-writers/00000000-0000-4000-8000-000000000001');
      mkdirSync(writer, { recursive: true });
      writeFileSync(join(writer, 'reservation.json'), JSON.stringify({ controlDir: control, createdAt: '2026-11-01T00:00:00Z' }));
      writeFileSync(join(writer, 'launcher.json'), JSON.stringify({ pid: 5001 }));
      writeFileSync(join(writer, 'launch.json'), JSON.stringify({ pid: 4001, launchedAt: '2026-11-01T00:00:01Z' }));
    }
    let alive = true;
    const legacySnapshot = async () => [{ pid: process.pid, ppid: 1, command: 'node supervisor' },
      ...(alive && kind === 'surviving npm child' ? [{ pid: 5002, ppid: 1, pgid: 5001,
        startedAt: Date.parse('2026-11-01T00:00:00Z'), command: `sh supervisor ${control}` }] : []),
      ...(alive ? [{ pid: 4002, ppid: 1, pgid: 5001,
        command: kind === 'relative updater' ? 'bash ./update.sh' : 'npm install --no-save' }] : [])];
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => { expect(launch).not.toHaveBeenCalled(); alive = false; });
    await expect(runDeferredUpdate({ admission, launch, wait, cwd: root, legacySnapshot,
      legacyCwds: async () => new Map([[4002, root]]), absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
  });

  it.each(['no control file', 'current PID'])('detects a legacy updater with %s', async kind => {
    const { root, admission } = fixture();
    if (kind === 'current PID') {
      const control = join(root, 'data/update-detached');
      mkdirSync(control, { recursive: true });
      writeFileSync(join(control, 'pid'), String(process.pid));
    }
    let alive = true;
    const legacySnapshot = async () => [{ pid: process.pid, ppid: 1, command: 'node supervisor' },
      ...(alive ? [{ pid: 4002, ppid: 1, command: 'bash ./update.sh' }] : [])];
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => { expect(launch).not.toHaveBeenCalled(); alive = false; });
    await expect(runDeferredUpdate({ admission, launch, wait, cwd: root, legacySnapshot,
      legacyCwds: async () => new Map([[4002, root]]), absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('waits for an observed Windows relative updater when its cwd is unavailable', async () => {
    const { root, admission } = fixture();
    let alive = true;
    const legacySnapshot = async () => [{ pid: process.pid, ppid: 1, command: 'node supervisor' },
      ...(alive ? [{ pid: 4002, ppid: 1, command: 'powershell.exe -File .\\update.ps1' }] : [])];
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => { expect(launch).not.toHaveBeenCalled(); alive = false; });
    await expect(runDeferredUpdate({ admission, launch, wait, cwd: root, platform: 'win32', legacySnapshot,
      legacyCwds: async () => new Map(), absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('does not attribute an unrelated npm process in the same checkout to old update control', async () => {
    const { root, admission } = fixture();
    const control = join(root, 'data/update-detached');
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'pid'), '4001');
    const legacySnapshot = async () => [{ pid: process.pid, ppid: 1, command: 'node supervisor' },
      { pid: 4002, ppid: 1, pgid: 4002, command: 'npm run dev' }];
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn();
    await expect(runDeferredUpdate({ admission, launch, wait, cwd: root, legacySnapshot,
      legacyCwds: async () => new Map([[4002, root]]), absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).not.toHaveBeenCalled();
  });

  it('waits for an actual npm install in the checkout even without launcher evidence', async () => {
    const { root, admission } = fixture();
    let alive = true;
    const legacySnapshot = async () => [{ pid: process.pid, ppid: 1, command: 'node supervisor' },
      ...(alive ? [{ pid: 4002, ppid: 1, command: 'npm install --no-save' }] : [])];
    const launch = vi.fn(completedLaunch(admission));
    const wait = vi.fn(async () => { expect(launch).not.toHaveBeenCalled(); alive = false; });
    await expect(runDeferredUpdate({ admission, launch, wait, cwd: root, legacySnapshot,
      legacyCwds: async () => new Map([[4002, root]]), absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('does not attribute a nested project updater to this installation', async () => {
    const { root, admission } = fixture();
    const legacySnapshot = async () => [{ pid: process.pid, ppid: 1, command: 'node supervisor' },
      { pid: 4002, ppid: 1, command: 'bash ./update.sh' }];
    const wait = vi.fn();
    await expect(runDeferredUpdate({ admission, launch: completedLaunch(admission), wait, cwd: root,
      legacySnapshot, legacyCwds: async () => new Map([[4002, join(root, 'other-project')]]),
      absent: () => true, emit: vi.fn() })).resolves.toBe(0);
    expect(wait).not.toHaveBeenCalled();
  });

  it('does not attribute an unverified reused process group to an old updater', async () => {
    const { root, admission } = fixture();
    const control = join(root, 'data/update-detached');
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'pid'), '4001');
    const writer = join(root, 'data/database-writers/00000000-0000-4000-8000-000000000001');
    mkdirSync(writer, { recursive: true });
    writeFileSync(join(writer, 'reservation.json'), JSON.stringify({ controlDir: control, createdAt: '2026-11-01T00:00:00Z' }));
    writeFileSync(join(writer, 'launcher.json'), JSON.stringify({ pid: 5001 }));
    writeFileSync(join(writer, 'launch.json'), JSON.stringify({ pid: 4001, launchedAt: '2026-11-01T00:00:01Z' }));
    const legacySnapshot = async () => [{ pid: process.pid, ppid: 1, command: 'node supervisor' },
      { pid: 5002, ppid: 1, pgid: 5001, command: 'npm run dev', startedAt: Date.parse('2026-11-02T00:00:00Z') }];
    const wait = vi.fn();
    const emit = vi.fn();
    await expect(runDeferredUpdate({ admission, launch: completedLaunch(admission), wait, cwd: root,
      legacySnapshot, legacyCwds: async () => new Map([[5002, root]]), absent: () => true, emit })).resolves.toBe(0);
    expect(wait).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('could not be inspected'));
  });

  it('reports a partial cwd inspection while honoring an observed recorded updater PID', async () => {
    const { root, admission } = fixture();
    const control = join(root, 'data/update-detached');
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'pid'), '4001');
    let alive = true;
    const legacySnapshot = async () => [{ pid: process.pid, ppid: 1, command: 'node supervisor' },
      ...(alive ? [{ pid: 4001, ppid: 1, command: 'bash ./update.sh' },
        { pid: 4002, ppid: 1, command: 'bash ./update.sh' }] : [])];
    const emit = vi.fn();
    const wait = vi.fn(async () => { alive = false; });
    await expect(runDeferredUpdate({ admission, launch: completedLaunch(admission), wait, cwd: root,
      legacySnapshot, legacyCwds: async () => new Map(), absent: () => true, emit })).resolves.toBe(0);
    expect(wait).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(expect.stringContaining('could not be inspected'));
  });

  it('releases an interrupted wait without taking a hold or launching an update', async () => {
    const { admission } = fixture();
    const release = admission.admit('agent', 'release-example');
    const controller = new AbortController();
    const launch = vi.fn();
    await expect(runDeferredUpdate({ admission, launch, emit: vi.fn(), signal: controller.signal,
      wait: async () => controller.abort(new Error('interrupted')) })).rejects.toThrow('interrupted');
    expect(admission.held()).toBe(false);
    expect(admission.deferredUpdate.get().operation).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    await release.finish();
  });

  it.each([false, true])('lets maintenance supersede a waiting update without deadlocking its drain (legacy work: %s)', async legacyPending => {
    const { admission } = fixture();
    const release = admission.admit('agent', 'release-example');
    let hold;
    const launch = vi.fn();
    await expect(runDeferredUpdate({ admission, launch, emit: vi.fn(), legacyRunning: async () => legacyPending, wait: async () => {
      hold = admission.begin({ reason: 'Peer maintenance', owner: 'operator-example' }).hold;
      await release.finish();
    } })).rejects.toThrow('superseded');
    expect(launch).not.toHaveBeenCalled();
    expect(admission.status()).toMatchObject({ state: 'ready', hold, blockers: [] });
    expect(() => admission.observeIdle()).not.toThrow();
    admission.resume({ id: hold.id, revision: hold.revision });
  });

  it('retains unknown liveness and orphan descendants, and reconciles only after proved settlement', () => {
    const { admission } = fixture();
    const operation = admission.deferredUpdate.request();
    admission.deferredUpdate.acquire(operation.id);
    admission.deferredUpdate.enter(operation.id, 4321);
    expect(processAbsent(4321, () => { throw Object.assign(new Error('unknown'), { code: 'EPERM' }); })).toBe(false);
    admission.deferredUpdate.reconcile({ absent: () => false });
    expect(admission.held()).toBe(true);
    admission.deferredUpdate.reconcile({ absent: pid => pid > 0, platform: 'darwin' });
    expect(admission.held()).toBe(true);
    admission.deferredUpdate.reconcile({ absent: () => true, platform: 'darwin' });
    expect(admission.held()).toBe(false);
    expect(admission.deferredUpdate.get().result).toMatchObject({ success: false, interrupted: true });
  });

  it('requires exact Windows terminal evidence and recovers a crash after terminal publication', async () => {
    const { admission } = fixture();
    await expect(runDeferredUpdate({ admission, platform: 'win32', legacyRunning: async () => false, emit: vi.fn(), launch: (_command, _args, options) => {
      const child = new EventEmitter(); child.pid = 4321;
      admission.deferredUpdate.enter(options.env.PORTOS_DEFERRED_UPDATE_ID, child.pid);
      setImmediate(() => child.emit('close', 0));
      return child;
    } })).rejects.toThrow('settlement is unverified');
    const { operation } = admission.deferredUpdate.get();
    admission.deferredUpdate.reconcile({ absent: () => true, platform: 'win32' });
    expect(admission.held()).toBe(true);
    expect(() => admission.deferredUpdate.terminal(operation.id, 1234, true)).toThrow();
    expect(() => admission.deferredUpdate.terminal('stale-operation', 4321, true)).toThrow();
    admission.deferredUpdate.terminal(operation.id, 4321, false);
    admission.deferredUpdate.reconcile({ absent: () => true, platform: 'win32' });
    expect(admission.held()).toBe(false);
    expect(admission.deferredUpdate.get().result).toMatchObject({ id: operation.id, success: false, interrupted: false });
    await expect(runDeferredUpdate({ admission, platform: 'win32', legacyRunning: async () => false, emit: vi.fn(), launch: completedLaunch(admission) })).resolves.toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('direct update script offline boundary', () => {
  const start = root => {
    installUpdateTestSupervisor(root, { standalone: true });
    const source = readFileSync(new URL('../update.sh', import.meta.url), 'utf8');
    const header = source.slice(0, source.indexOf('mkdir -p "$ROOT_DIR/data"'));
    writeFileSync(join(root, 'update.sh'), `${header}\ntouch applied\nnode scripts/deferred-update.mjs --terminal "$PORTOS_DEFERRED_UPDATE_ID" "$$" 0\n`);
    // This is a standalone process in a copied disposable install, not a Vitest
    // worker writing the executing checkout's data tree (same as boot smoke).
    const env = { ...process.env, PORTOS_DATA_ROOT: root };
    delete env.VITEST;
    const child = spawn('bash', [join(root, 'update.sh')], { cwd: root, env, stdio: 'ignore' });
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  };

  it('does not mutate before a release and its children finish, without requiring a running API', async () => {
    const { root, admission } = fixture();
    const release = admission.admit('agent', 'release-example');
    const done = start(root);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'server/node_modules'))).toBe(false);
    await vi.waitFor(() => expect(admission.deferredUpdate.get().operation?.phase).toBe('waiting'), { timeout: 10000 });
    const child = admission.admit('agent', 'release-child-example');
    await release.finish();
    expect(existsSync(join(root, 'applied'))).toBe(false);
    await child.finish();
    expect(await done).toBe(0);
    expect(existsSync(join(root, 'applied'))).toBe(true);
    expect(admission.held()).toBe(false);
  });

  it.each(['images', 'corrupt'])('rechecks %s state at the acquired hold and refuses before mutation', async kind => {
    const { root, admission } = fixture();
    const release = admission.admit('agent', 'release-example');
    const done = start(root);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'server/node_modules'))).toBe(false);
    await vi.waitFor(() => expect(admission.deferredUpdate.get().operation?.phase).toBe('waiting'), { timeout: 10000 });
    mkdirSync(join(root, 'data/cos'), { recursive: true });
    writeFileSync(join(root, 'data/cos/state.json'), kind === 'corrupt' ? '{' : JSON.stringify({ persistentMind: { queuedMessages: [{ images: ['example.png'] }] } }));
    await release.finish();
    expect(await done).toBe(1);
    expect(existsSync(join(root, 'applied'))).toBe(false);
    expect(admission.held()).toBe(false);
  });
});
