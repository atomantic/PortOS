import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import { createMaintenanceJournal } from '../lib/maintenanceJournal.js';
import { assertInactiveActivity, isOrdinaryAgentRecord } from './maintenanceReservationDisposition.js';
import { __createAutomaticUpdateReservationRecovery } from './automaticUpdateReservationRecovery.js';

let root, gate;
const oldPid = 2147483647;
const idle = () => ({ jobs: [], agents: { trusted: true, active: 0 }, mind: { trusted: true, thinking: false },
  llm: { trusted: true, active: 0 }, extras: { imageTo3d: [] }, appOperations: [], renders: [],
  update: { inProgress: true }, backup: { inProgress: false } });
const recovery = check => __createAutomaticUpdateReservationRecovery({ gate, check: async (update, operations) => {
  const result = await check(update, operations);
  if (result && !Array.isArray(result) && Object.hasOwn(result, 'ordinaryOwnerIds')) return result;
  return { pids: Array.isArray(result) ? result : [], processes: [],
    ordinaryOwnerIds: operations.filter(op => op.kind === 'runner').map(op => op.id) };
},
  isDead: pid => pid === oldPid, isAlive: pid => pid === process.pid });
const waitForUpdate = () => gate.deferredUpdate.request();

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'automatic-admission-recovery-'));
  gate = createMaintenanceAdmission(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedHistoricalReservations() {
  const journal = createMaintenanceJournal(root);
  journal.transaction(state => {
    for (const [kind, count, uncertain] of [
      ['media', 25, 20], ['settlement', 9, 9], ['runner', 8, 3],
      ['api-run', 4, 0], ['provider', 3, 0], ['music-video', 4, 0],
    ]) {
      for (let i = 0; i < count; i++) state.operations.push({ id: randomUUID(), kind,
        resource: kind === 'settlement' ? 'Output publication' : kind === 'runner' ? `agent-${i}` : `${kind}-${i}`,
        pid: oldPid, startedAt: '2026-10-07T04:40:53.785Z',
        ...(i < uncertain ? { unsettled: true, uncertaintyStamp: randomUUID() } : {}) });
    }
  });
}

describe('automatic recovery for a waiting update', () => {
  it('retires finished same-process bookkeeping without claiming the output was saved', async () => {
    const permit = gate.admit('shell-job', 'completed-shell-job');
    permit.markUnsettled();
    await permit.finish();
    const update = waitForUpdate();
    const receipt = await recovery(async () => []).run();
    expect(receipt).toMatchObject({ disposition: 'automatically-abandoned', outputCompleteness: 'unknown' });
    expect(receipt.request.operations).toHaveLength(1);
    expect(gate.deferredUpdate.acquire(update.id)).toBe(true);
    gate.deferredUpdate.finish(update.id, false);
  });

  it('does not retire the same reservation once a service reconnects to it', async () => {
    const permit = gate.admit('shell-job', 'resumed-shell-job');
    permit.markUnsettled();
    await permit.finish();
    gate.recoverOwned('shell-job', 'resumed-shell-job');
    waitForUpdate();
    expect(await recovery(async () => []).run()).toBeNull();
    expect(gate.operations().map(op => op.kind)).toContain('shell-job');
  });

  it('does not let an old permit finish a newer owner of the same reservation', async () => {
    const old = gate.admit('shell-job', 'reconnected-shell-job');
    old.markUnsettled();
    const current = gate.recoverOwned('shell-job', 'reconnected-shell-job');
    expect(await old.finish()).toBe(false);
    waitForUpdate();
    expect(await recovery(async () => []).run()).toBeNull();
    expect(gate.operations().some(op => op.id === current.id)).toBe(true);
  });

  it('does not let an old recovery permit remove a reservation adopted by a newer owner', async () => {
    const initial = gate.admit('shell-job', 'recovery-shell-job');
    initial.markUnsettled();
    await initial.finish();
    const previous = gate.recoverOwned('shell-job', 'recovery-shell-job');
    const current = gate.recoverOwned('shell-job', 'recovery-shell-job');
    expect(previous.completeRecovery()).toBe(false);
    expect(gate.operations().some(op => op.id === current.id)).toBe(true);
  });

  it('preserves an adopted reservation across separate admission instances', async () => {
    const initial = gate.admit('shell-job', 'cross-process-shell-job');
    initial.markUnsettled();
    await initial.finish();
    const previous = gate.recoverOwned('shell-job', 'cross-process-shell-job');
    const otherProcess = createMaintenanceAdmission(root);
    const current = otherProcess.recoverOwned('shell-job', 'cross-process-shell-job');
    expect(previous.completeRecovery()).toBe(false);
    expect(await previous.finish()).toBe(false);
    waitForUpdate();
    expect(await recovery(async () => []).run()).toBeNull();
    expect(gate.operations().some(op => op.id === current.id)).toBe(true);
  });

  it('never auto-disposes an unstamped legacy reservation adopted by another instance', async () => {
    const initial = gate.admit('shell-job', 'legacy-cross-process-job');
    initial.markUnsettled();
    await initial.finish();
    createMaintenanceJournal(root).transaction(state => { delete state.operations.find(op => op.id === initial.id).uncertaintyStamp; });
    const previous = gate.recoverOwned('shell-job', 'legacy-cross-process-job');
    const current = createMaintenanceAdmission(root).recoverOwned('shell-job', 'legacy-cross-process-job');
    expect(previous.completeRecovery()).toBe(false);
    await previous.finish();
    waitForUpdate();
    expect(await recovery(async () => []).run()).toBeNull();
    expect(gate.operations().some(op => op.id === current.id)).toBe(true);
  });

  it('records unknown output when the current owner finishes an unstamped legacy reservation', async () => {
    const initial = gate.admit('shell-job', 'legacy-finished-job');
    initial.markUnsettled();
    await initial.finish();
    createMaintenanceJournal(root).transaction(state => { delete state.operations.find(op => op.id === initial.id).uncertaintyStamp; });
    const current = gate.recoverOwned('shell-job', 'legacy-finished-job');
    expect(current.completeRecovery()).toBe(false);
    await current.finish();
    const update = waitForUpdate();
    const receipt = await recovery(async () => []).run();
    expect(receipt).toMatchObject({ disposition: 'automatically-abandoned', outputCompleteness: 'unknown' });
    expect(gate.deferredUpdate.acquire(update.id)).toBe(true);
    gate.deferredUpdate.finish(update.id, false);
  });

  it('does not treat another gate instance’s live same-PID reservation as locally finished', async () => {
    const other = createMaintenanceAdmission(root).admit('shell-job', 'other-instance-job');
    waitForUpdate();
    expect(await recovery(async () => []).run()).toBeNull();
    expect(gate.operations().some(op => op.id === other.id)).toBe(true);
  });

  it('preserves an unsettled mark made through another instance’s resource context', async () => {
    const otherGate = createMaintenanceAdmission(root);
    const operation = otherGate.admit('shell-job', 'shell-context');
    await gate.withResource('shell-job', 'shell-context', async () => gate.markCurrentUnsettled());
    expect(await operation.finish()).toBe(true);
    expect(gate.operations().find(op => op.id === operation.id)).toMatchObject({ unsettled: true });
    const update = otherGate.deferredUpdate.request();
    const worker = __createAutomaticUpdateReservationRecovery({ gate: otherGate, check: async () => [],
      isDead: pid => pid === oldPid, isAlive: pid => pid === process.pid });
    expect(await worker.run()).toMatchObject({ outputCompleteness: 'unknown' });
    expect(otherGate.deferredUpdate.acquire(update.id)).toBe(true);
    otherGate.deferredUpdate.finish(update.id, false);
  });

  it('does not let an old resource callback finish an agent adopted by another instance', async () => {
    const otherGate = createMaintenanceAdmission(root);
    otherGate.admit('agent', 'agent-adopted');
    let release, entered;
    const paused = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const old = gate.withResource('agent', 'agent-adopted', async () => {
      entered(); await paused; await gate.finishResource('agent', 'agent-adopted');
    });
    await ready;
    const current = otherGate.recoverOwned('agent', 'agent-adopted');
    release();
    await old;
    expect(gate.operations().some(op => op.id === current.id)).toBe(true);
  });
  it('records all 53 inactive reservations, then leaves the update fence to arbitrate a racing render', async () => {
    seedHistoricalReservations();
    const update = waitForUpdate();
    const before = gate.operations().filter(op => op.id !== update.id);
    const worker = recovery(async () => assertInactiveActivity(idle(), [], { waitingUpdate: true }));
    const receipt = await worker.run();
    expect(receipt).toMatchObject({ disposition: 'automatically-abandoned', outputCompleteness: 'unknown' });
    expect(receipt.request.operations).toEqual(before);
    expect(gate.operations().map(op => op.id)).toEqual([update.id]);
    expect(JSON.parse(fs.readFileSync(join(gate.directory, `reservation-disposition-${receipt.request.requestId}.json`), 'utf8'))).toEqual(receipt);

    const late = gate.admit('media', 'late-render');
    const revision = gate.status().revision;
    expect(gate.deferredUpdate.acquire(update.id)).toBe(false);
    expect(gate.status().revision).toBe(revision);
    await late.finish();
    expect(gate.deferredUpdate.acquire(update.id)).toBe(true);
    expect(() => gate.admit('media', 'after-hold')).toThrow();
    gate.deferredUpdate.finish(update.id, false);
  });

  it('keeps every reservation when a live job appears or activity is unreadable', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    const worker = recovery(async () => assertInactiveActivity({ ...idle(), jobs: [{ status: 'running' }] }, [], { waitingUpdate: true }));
    expect(await worker.run()).toBeNull();
    expect(gate.operations()).toHaveLength(54);
    const unreadable = recovery(async () => assertInactiveActivity({ ...idle(), llm: { trusted: false, active: 0 } }, [], { waitingUpdate: true }));
    expect(await unreadable.run()).toBeNull();
    expect(gate.operations()).toHaveLength(54);
  });

  it('does not confuse an unrelated reused PID with the recorded owner', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    const worker = __createAutomaticUpdateReservationRecovery({ gate,
      check: async (_update, operations) => ({ pids: [], processes: [{ pid: oldPid, startedAt: Date.parse('2026-10-08T00:00:00Z') }],
        ordinaryOwnerIds: operations.filter(op => op.kind === 'runner').map(op => op.id) }),
      isDead: () => false, isAlive: pid => pid === process.pid });
    const receipt = await worker.run();
    expect(receipt.request.operations).toHaveLength(53);
    expect(gate.operations().map(op => op.kind)).toEqual(['deferred-update']);
  });

  it('keeps a recorded owner when the observed PID could still be the original process', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    const worker = __createAutomaticUpdateReservationRecovery({ gate,
      check: async (_update, operations) => ({ pids: [], processes: [{ pid: oldPid, startedAt: Date.parse('2026-10-07T04:40:53Z') }],
        ordinaryOwnerIds: operations.filter(op => op.kind === 'runner').map(op => op.id) }),
      isDead: () => false, isAlive: pid => pid === process.pid });
    expect(await worker.run()).toBeNull();
    expect(gate.operations()).toHaveLength(54);
  });

  it('keeps reservations when an archived agent child PID is still live', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    const directory = join(root, 'cos', 'agents', '2026-10-07', 'agent-0');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ id: 'agent-0', pid: process.pid }));
    const worker = recovery(async () => []);
    expect(await worker.run()).toBeNull();
    expect(gate.operations()).toHaveLength(54);
  });

  it('does not block on an unrelated process that reused a completed agent child PID', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    const directory = join(root, 'cos', 'agents', '2026-10-07', 'agent-0');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ id: 'agent-0', pid: process.pid,
      completedAt: '2026-10-07T05:00:00Z' }));
    const worker = recovery(async (_update, operations) => ({ pids: [],
      processes: [{ pid: process.pid, startedAt: Date.parse('2026-10-08T00:00:00Z') }],
      ordinaryOwnerIds: operations.filter(op => op.kind === 'runner').map(op => op.id) }));
    const receipt = await worker.run();
    expect(receipt.request.operations).toHaveLength(53);
    expect(gate.operations().map(op => op.kind)).toEqual(['deferred-update']);
  });

  it('checks a surviving runner PID recorded outside its in-memory agent map', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    fs.mkdirSync(join(root, 'cos'), { recursive: true });
    fs.writeFileSync(join(root, 'cos', 'runner-state.json'), JSON.stringify({ agents: { 'agent-0': { pid: process.pid } } }));
    expect(await recovery(async () => []).run()).toBeNull();
    expect(gate.operations()).toHaveLength(54);
  });

  it('does not let an unclassifiable runner row prevent inspection of other rows', async () => {
    seedHistoricalReservations();
    const journal = createMaintenanceJournal(root);
    journal.transaction(state => state.operations.push({ id: randomUUID(), kind: 'runner', resource: '',
      pid: oldPid, startedAt: '2026-10-07T04:40:53.785Z' }));
    const update = waitForUpdate();
    const receipt = await recovery(async () => []).run();
    expect(receipt.request.operations).toHaveLength(53);
    expect(gate.operations().map(op => op.kind)).toEqual(['runner', 'deferred-update']);
    expect(gate.deferredUpdate.acquire(update.id)).toBe(false);
  });

  it('does not retire records while a detached accelerator claimant is live', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    fs.writeFileSync(join(root, 'heavy-local-job.claim.json'), JSON.stringify({ pid: process.pid }));
    expect(await recovery(async () => []).run()).toBeNull();
    expect(gate.operations()).toHaveLength(54);
  });

  it.each(['completed', 'malformed', 'zombie'])('reconciles stale reservations with a %s accelerator claim', async kind => {
    seedHistoricalReservations();
    const update = waitForUpdate();
    const path = join(root, 'heavy-local-job.claim.json');
    const token = 'completion-token';
    fs.writeFileSync(path, kind === 'malformed' ? '{' : JSON.stringify({ pid: process.pid, token }));
    if (kind === 'completed') fs.writeFileSync(`${path}.completed.json`, JSON.stringify({ token, pid: process.pid,
      ownerPid: process.pid, finishedAt: new Date().toISOString() }));
    const worker = recovery(async (_update, operations) => ({ pids: [],
      processes: [{ pid: process.pid, state: kind === 'zombie' ? 'Z' : 'S', startedAt: Date.now() - 10000 }],
      ordinaryOwnerIds: operations.filter(op => op.kind === 'runner').map(op => op.id) }));
    expect(await worker.run()).toMatchObject({ disposition: 'automatically-abandoned', outputCompleteness: 'unknown' });
    expect(gate.deferredUpdate.acquire(update.id)).toBe(true);
    gate.deferredUpdate.finish(update.id, false);
  });

  it('distinguishes a reused accelerator PID from a child handed off before the claim file was written', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    const claimPath = join(root, 'heavy-local-job.claim.json');
    fs.writeFileSync(claimPath, JSON.stringify({ pid: process.pid }));
    const claimed = recovery(async (_update, operations) => ({ pids: [],
      processes: [{ pid: process.pid, startedAt: Date.parse('2026-10-08T00:00:00Z') }],
      ordinaryOwnerIds: operations.filter(op => op.kind === 'runner').map(op => op.id) }));
    fs.utimesSync(claimPath, new Date('2026-10-09T00:00:00Z'), new Date('2026-10-09T00:00:00Z'));
    expect(await claimed.run()).toBeNull();
    fs.utimesSync(claimPath, new Date('2026-10-07T00:00:00Z'), new Date('2026-10-07T00:00:00Z'));
    expect(await claimed.run()).toMatchObject({ outputCompleteness: 'unknown' });
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO claim without blocking or damaging the journal', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    execFileSync('mkfifo', [join(root, 'heavy-local-job.claim.json')]);
    expect(await recovery(async () => []).run()).toBeNull();
    expect(gate.operations()).toHaveLength(54);
    expect(gate.status().state).toBe('normal');
  });

  it('keeps release-agent ownership separate from ordinary residue', async () => {
    seedHistoricalReservations();
    const journal = createMaintenanceJournal(root);
    journal.transaction(state => state.operations.push({ id: randomUUID(), kind: 'agent', resource: 'release-agent',
      pid: oldPid, startedAt: '2026-10-07T04:40:53.785Z' }));
    const update = waitForUpdate();
    const receipt = await recovery(async () => []).run();
    expect(receipt.request.operations).toHaveLength(53);
    expect(gate.operations().map(op => op.kind)).toEqual(['agent', 'deferred-update']);
    expect(gate.deferredUpdate.acquire(update.id)).toBe(false);
  });

  it('reconciles a positively identified ordinary agent while retaining protected agents', async () => {
    seedHistoricalReservations();
    const journal = createMaintenanceJournal(root);
    const ordinaryId = randomUUID();
    journal.transaction(state => {
      state.operations.push({ id: ordinaryId, kind: 'agent', resource: 'agent-ordinary',
        pid: oldPid, startedAt: '2026-10-07T04:40:53.785Z', unsettled: true });
      state.operations.push({ id: randomUUID(), kind: 'agent', resource: 'agent-release',
        pid: oldPid, startedAt: '2026-10-07T04:40:53.785Z' });
    });
    const update = waitForUpdate();
    const worker = recovery(async (_update, operations) => ({ pids: [], processes: [],
      ordinaryOwnerIds: [ordinaryId, ...operations.filter(op => op.kind === 'runner').map(op => op.id)] }));
    const receipt = await worker.run();
    expect(receipt.request.operations).toHaveLength(54);
    expect(gate.operations().map(op => op.resource)).toContain('agent-release');
    expect(gate.deferredUpdate.acquire(update.id)).toBe(false);
  });

  it('never classifies release or unknown agent records as ordinary', () => {
    const op = { resource: 'agent-1' };
    expect(isOrdinaryAgentRecord(op, null)).toBe(false);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', metadata: { taskAnalysisType: 'do-release' } })).toBe(false);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', metadata: { taskAnalysisType: 'claim-issue', analysisType: 'do-release' } })).toBe(false);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', metadata: { taskAnalysisType: 'claim-issue', releaseSynchronization: {} } })).toBe(false);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', metadata: { taskAnalysisType: 'future-release-kind' } })).toBe(false);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', metadata: { taskAnalysisType: 'claim-issue', releaseAttempts: {} } })).toBe(false);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', taskId: 'task-1', metadata: { taskAnalysisType: 'claim-issue' } })).toBe(false);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', taskId: 'task-1', metadata: { taskAnalysisType: 'claim-issue' } },
      { id: 'task-1', metadata: { analysisType: 'do-release' } })).toBe(false);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', metadata: { taskDescription: 'Run /do:release now' } })).toBe(false);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', status: 'running', metadata: { taskAnalysisType: 'claim-issue' } })).toBe(false);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', status: 'completed', metadata: { taskAnalysisType: 'claim-issue' } })).toBe(true);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', taskId: 'task-1', status: 'completed', metadata: {} },
      { id: 'task-1', taskType: 'user', description: 'Fix the dashboard layout', metadata: {} })).toBe(true);
    expect(isOrdinaryAgentRecord(op, { id: 'agent-1', taskId: 'task-1', status: 'completed', metadata: {} },
      { id: 'task-1', taskType: 'user', description: 'Prepare a release', metadata: {} })).toBe(false);
  });

  it('does not retire a runner reservation identified as release work', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    const directory = join(root, 'cos', 'agents', '2026-10-07', 'agent-0');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(join(directory, 'metadata.json'), JSON.stringify({ id: 'agent-0', pid: oldPid,
      metadata: { taskAnalysisType: 'do-release' } }));
    expect(await recovery(async () => []).run()).toBeNull();
    expect(gate.operations()).toHaveLength(54);
  });

  it('keeps records when a new reservation races the idle check', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    let injected = false;
    const worker = recovery(async () => {
      if (!injected) { injected = true; gate.admit('media', 'racing-render'); }
    });
    expect(await worker.run()).toBeNull();
    expect(gate.operations()).toHaveLength(55);
  });

  it('does not retire work when shutdown starts during the activity check', async () => {
    seedHistoricalReservations();
    waitForUpdate();
    let release;
    const checking = new Promise(resolve => { release = resolve; });
    const worker = recovery(() => checking);
    const pending = worker.run();
    worker.stop();
    release();
    expect(await pending).toBeNull();
    expect(gate.operations()).toHaveLength(54);
  });
});
