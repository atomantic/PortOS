import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { createMaintenanceJournal } from '../lib/maintenanceJournal.js';
import { __resetAppOperations, claimAppOperation, handOffAppOperation, listActiveAppOperations } from './appOperations.js';

const fixture = vi.hoisted(() => ({ runnerFails: false, restorePending: false, processes: [], runnerCwds: new Map(), media: { trusted: true, pending: false }, jobs: [], owners: {}, tasks: {} }));
vi.mock('../lib/db.js', () => ({ databaseRestoreRecovery: { isFenced: () => fixture.restorePending } }));
vi.mock('./backupRestoreRecovery.js', () => ({ resumeDatabaseRestore: async () => {
  fixture.restorePending = false;
  return { status: 'ok' };
} }));
vi.mock('./activeProcessing.js', async () => ({ getSystemActivity: async () => {
  const { listActiveAppOperations } = await import('./appOperations.js');
  return { jobs: [], agents: { trusted: true, active: 0 }, mind: { trusted: true, thinking: false },
    llm: { trusted: true, active: 0 }, extras: { imageTo3d: [] }, appOperations: listActiveAppOperations(),
    renders: [], update: { inProgress: true }, backup: { inProgress: false } };
} }));
vi.mock('./cosRunnerClient.js', () => ({ getActiveAgentsFromRunner: async () => {
  if (fixture.runnerFails) throw new Error('runner unavailable');
  return [];
} }));
vi.mock('./cosAgentLifecycle.js', () => ({ getAgentRecord: async id => fixture.owners[id] ?? null }));
vi.mock('./cosTaskStore.js', () => ({ getTaskById: async id => fixture.tasks[id] ?? null }));
vi.mock('./mediaJobQueue/index.js', () => ({ getMediaRecoveryActivity: () => fixture.media, listJobs: () => fixture.jobs }));
vi.mock('./videoGen/topazJob.js', () => ({ reconcileTopazStatus: async id => {
  if (id.startsWith('terminal-topaz')) fixture.media = { trusted: true, pending: false };
} }));
vi.mock('./maintenanceProcessInventory.js', async original => ({
  ...await original(), snapshotMaintenanceProcesses: async () => fixture.processes,
}));
vi.mock('./maintenanceScopedProcesses.js', async original => ({
  ...await original(), getProcessWorkingDirectories: async () => fixture.runnerCwds,
}));
import { checkActivity, __createAutomaticUpdateReservationRecovery } from './automaticUpdateReservationRecovery.js';

afterEach(() => {
  __resetAppOperations();
  fixture.runnerFails = false;
  fixture.restorePending = false;
  fixture.processes = [];
  fixture.runnerCwds = new Map();
  fixture.media = { trusted: true, pending: false };
  fixture.jobs = [];
  fixture.owners = {};
  fixture.tasks = {};
});

describe('real automatic activity check', () => {
  it('repairs a pending database restore before allowing a waiting update', async () => {
    fixture.restorePending = true;
    await expect(checkActivity({ ownerPid: process.pid }, [])).resolves.toMatchObject({ pids: [] });
    expect(fixture.restorePending).toBe(false);
  });
  it('detects a surviving child segment of a failed chained render', async () => {
    const child = '12345678-1234-4234-8234-123456789abc';
    fixture.jobs = [{ id: 'outer', status: 'failed', videoExecutions: [{ childJobId: child }] }];
    fixture.processes = [{ pid: 123, state: 'S', command: `python render.py --output /tmp/${child}.mp4` }];
    await expect(checkActivity({ ownerPid: process.pid }, [])).rejects.toMatchObject({ code: 'MAINTENANCE_STALE' });
  });
  it('clears stale ordinary work while the exact managed update owns its visible operation', async () => {
    const oldPid = 2147483647;
    createMaintenanceJournal(dirname(maintenance.directory)).transaction(state => state.operations.push({
      id: randomUUID(), kind: 'media', resource: 'old-job', pid: oldPid, startedAt: '2026-10-07T04:40:53.785Z',
    }));
    const { operation } = claimAppOperation({ emit: vi.fn() }, { id: 'portos-default', name: 'PortOS' }, 'update');
    const update = maintenance.deferredUpdate.request();
    await handOffAppOperation(operation, update.ownerPid);
    expect(listActiveAppOperations()).toHaveLength(1);
    const worker = __createAutomaticUpdateReservationRecovery({ gate: maintenance, check: checkActivity,
      isDead: pid => pid === oldPid, isAlive: pid => pid === process.pid });
    const receipt = await worker.run();
    expect(receipt).toMatchObject({ disposition: 'automatically-abandoned', outputCompleteness: 'unknown' });
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
    maintenance.deferredUpdate.finish(update.id, false);
  });

  it('allows direct mode only when the local runner process is absent', async () => {
    fixture.runnerFails = true;
    await expect(checkActivity({ ownerPid: process.pid }, [])).resolves.toMatchObject({ pids: [] });
    const { PATHS } = await import('../lib/paths.js');
    fixture.processes = [{ pid: 123, state: 'S', command: `node ${PATHS.root}/server/cos-runner/index.js` }];
    await expect(checkActivity({ ownerPid: process.pid }, [])).rejects.toThrow('runner unavailable');
    fixture.processes = [{ pid: 123, state: 'S', command: 'node server/cos-runner/index.js' }];
    fixture.runnerCwds = new Map([[123, PATHS.root]]);
    await expect(checkActivity({ ownerPid: process.pid }, [])).rejects.toThrow('runner unavailable');
    fixture.runnerCwds = new Map();
    await expect(checkActivity({ ownerPid: process.pid }, [])).resolves.toMatchObject({ limitations: ['runner-cwd-unavailable'] });
  });

  it('checks an archived uncertain Topaz request before deciding whether remote work remains', async () => {
    fixture.media = { trusted: true, pending: true };
    fixture.jobs = [{ id: 'terminal-topaz', kind: 'video-upscale', status: 'failed',
      params: { mode: 'topaz', requestId: '22222222-2222-4222-8222-222222222222' }, result: { topazUncertain: true } }];
    await expect(checkActivity({ ownerPid: process.pid }, [])).resolves.toMatchObject({ pids: [] });
    fixture.media = { trusted: true, pending: true };
    fixture.jobs = [{ id: 'active-topaz', kind: 'video-upscale', status: 'failed', params: { mode: 'topaz' }, result: { topazUncertain: true } }];
    await expect(checkActivity({ ownerPid: process.pid }, [])).rejects.toThrow('Media recovery is active');
  });

  it('reconciles an uncertain archived request even when the waiting update is the only reservation', async () => {
    fixture.media = { trusted: true, pending: true };
    fixture.jobs = [{ id: 'terminal-topaz-no-reservation', kind: 'video-upscale', status: 'failed',
      params: { mode: 'topaz', requestId: '22222222-2222-4222-8222-222222222222' }, result: { topazUncertain: true } }];
    const update = maintenance.deferredUpdate.request();
    const worker = __createAutomaticUpdateReservationRecovery({ gate: maintenance, check: checkActivity });
    expect(await worker.run()).toBeNull();
    expect(fixture.media.pending).toBe(false);
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
    maintenance.deferredUpdate.finish(update.id, false);
  });

  it('classifies archived runner and task records before clearing an inactive reservation', async () => {
    const oldPid = 2147483647;
    const operation = { id: randomUUID(), kind: 'runner', resource: 'agent-archived', pid: oldPid,
      startedAt: '2026-10-07T04:40:53.785Z' };
    fixture.owners['agent-archived'] = { id: 'agent-archived', taskId: 'task-ordinary', status: 'completed',
      pid: oldPid, completedAt: '2026-10-07T05:00:00Z', metadata: { taskAnalysisType: 'claim-issue' } };
    fixture.tasks['task-ordinary'] = { id: 'task-ordinary', metadata: { analysisType: 'claim-issue' } };
    createMaintenanceJournal(dirname(maintenance.directory)).transaction(state => state.operations.push(operation));
    const update = maintenance.deferredUpdate.request();
    const worker = __createAutomaticUpdateReservationRecovery({ gate: maintenance, check: checkActivity,
      isDead: pid => pid === oldPid, isAlive: pid => pid === process.pid });
    const receipt = await worker.run();
    expect(receipt).toMatchObject({ disposition: 'automatically-abandoned', outputCompleteness: 'unknown' });
    expect(receipt.request.operations).toEqual([operation]);
    expect(maintenance.deferredUpdate.acquire(update.id)).toBe(true);
    maintenance.deferredUpdate.finish(update.id, false);
  });
});
