import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _createBlockedSystemInvestigationRecovery } from './blockedSystemInvestigation.js';
import { resolveUndeliveredTaskUpdate, MAX_TASK_RETRIES } from './agentErrorAnalysis.js';
import { buildInvestigationFingerprint, couldReleaseBlockedTasks } from '../lib/investigationTasks.js';

const identity = vi.hoisted(() => ({ agent: null }));
vi.mock('./cosAgentLifecycle.js', () => ({ getAgentRecord: vi.fn(async () => identity.agent) }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn(async () => 'fixture-local'), UNKNOWN_INSTANCE_ID: 'unknown' }));

let root, path, time, created, calls, hold, failAfterCreate, race, failLink;
const read = async () => JSON.parse(await readFile(path, 'utf8'));
const write = queues => writeFile(path, JSON.stringify(queues));
const source = () => ({ id: 'system-original', taskType: 'internal', status: 'in_progress', priority: 'MEDIUM',
  description: 'Finish retained claims, including unfinished source work.', metadata: { app: 'fixture', analysisType: 'claim-issue',
    failureCount: String(MAX_TASK_RETRIES - 1), totalSpawnCount: '1' } });
const blocked = () => {
  const task = source();
  const update = resolveUndeliveredTaskUpdate(task, { status: 'incomplete', reason: 'Merged delivery still has unfinished siblings.' }, 'agent-original', time);
  return { ...task, ...update };
};
const create = async (task, analysis) => {
  calls++;
  expect(analysis.preserveOriginalBudget).toBe(true);
  const queues = await read();
  const fingerprint = buildInvestigationFingerprint(task, analysis);
  let child = queues.cos.tasks.find(row => row.metadata?.investigationFingerprint === fingerprint && row.status !== 'completed');
  if (!child) {
    created++;
    child = { id: `investigator-${created}`, status: 'pending', taskType: 'internal', metadata: {
      isInvestigation: true, preserveOriginalBudget: true, investigationFingerprint: fingerprint, affectedTasks: [] } };
    queues.cos.tasks.push(child);
  }
  child.metadata.affectedTasks = [...new Set([...child.metadata.affectedTasks, task.id])];
  await write(queues);
  if (failAfterCreate) { failAfterCreate = false; throw new Error('interrupted after durable creation'); }
  return child;
};
const update = async (task, state) => {
  const queues = await read();
  const current = queues.cos.tasks.find(row => row.id === task.id);
  if (current.status !== 'blocked' || JSON.stringify(current.metadata) !== JSON.stringify(task.metadata)) return { statusChanged: true };
  if (failLink && state.taskId) { failLink = false; throw new Error('link interrupted'); }
  current.metadata = { ...current.metadata, blockedInvestigation: state };
  if (race && state.phase === 'creating') { race = false; current.status = 'completed'; }
  await write(queues);
  return current;
};
const factory = (realOwner = false) => _createBlockedSystemInvestigationRecovery({ read, update, create, now: () => time,
  ...(!realOwner && { ownerFor: async task => task.metadata?.foreign ? null : { agentId: 'agent-original', instanceId: 'fixture-local' } }),
  permission: async () => hold });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'blocked-investigation-'));
  path = join(root, 'queues.json');
  time = Date.parse('2026-01-01T00:00:00.000Z');
  created = calls = 0; hold = null; failAfterCreate = race = failLink = false;
  await write({ user: { tasks: [] }, cos: { tasks: [blocked()] } });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('blocked system recovery persisted workflow', () => {
  it('investigates exhausted incomplete delivery once, groups duplicate observations and preserves original budgets', async () => {
    const recovery = factory();
    await Promise.all([recovery.recover('system-original'), recovery.recover('system-original')]);
    let queues = await read();
    const original = queues.cos.tasks.find(row => row.id === 'system-original');
    expect(original.status).toBe('blocked');
    expect(original.metadata).toMatchObject({ failureCount: MAX_TASK_RETRIES, totalSpawnCount: '1',
      taskOutcome: { status: 'incomplete' }, blockedInvestigation: { phase: 'queued', attempts: 1, taskId: 'investigator-1' } });
    expect(original.description).toBe(source().description);
    queues.cos.tasks.push({ ...blocked(), id: 'same-cause', metadata: { ...blocked().metadata } });
    await write(queues);
    await factory().recover('same-cause');
    queues = await read();
    expect(created).toBe(1);
    expect(queues.cos.tasks.find(row => row.id === 'investigator-1').metadata.affectedTasks).toEqual(['system-original', 'same-cause']);
    await factory().sweep();
    expect(created).toBe(1);
  });

  it.each(['creation', 'link'])('recovers from a crash after durable %s without minting another investigator', async cut => {
    failAfterCreate = cut === 'creation'; failLink = cut === 'link';
    await factory().recover('system-original').catch(() => {});
    await factory().recover('system-original');
    const original = (await read()).cos.tasks.find(row => row.id === 'system-original');
    expect(created).toBe(1);
    expect(original.metadata.blockedInvestigation).toMatchObject({ phase: 'queued', attempts: 1, taskId: 'investigator-1' });
  });

  it('backs off a loop/circuit without creating a blocked approval task, and resumes after the persisted window', async () => {
    hold = 'repeat-fingerprint';
    await factory().recover('system-original');
    let state = (await read()).cos.tasks[0].metadata.blockedInvestigation;
    expect(state.phase).toBe('waiting');
    expect(Date.parse(state.retryAt)).toBeGreaterThan(time);
    hold = null;
    await factory().recover('system-original');
    expect(calls).toBe(0);
    time = Date.parse(state.retryAt) + 1;
    await factory().recover('system-original');
    expect(created).toBe(1);
  });

  it('keeps an investigator failure with its existing owner and never creates a successor or auto-revives originals', async () => {
    await factory().recover('system-original');
    const queues = await read();
    const investigator = queues.cos.tasks.find(row => row.id === 'investigator-1');
    investigator.status = 'blocked';
    investigator.metadata.blockedCategory = 'task-recovery-exhausted';
    await write(queues);
    await factory().sweep();
    expect(created).toBe(1);
    const original = (await read()).cos.tasks.find(row => row.id === 'system-original');
    expect(original.metadata.blockedInvestigation.phase).toBe('investigation-blocked');
    expect(original.metadata.failureCount).toBe(MAX_TASK_RETRIES);
    expect(couldReleaseBlockedTasks({ ...investigator, status: 'completed' })).toBe(false);
    expect(couldReleaseBlockedTasks({ ...investigator, status: 'completed', metadata: { ...investigator.metadata, preserveOriginalBudget: 'true' } })).toBe(false);
  });

  it.each(['task-approval', 'agent-paused', 'provider-config', 'auth-error', 'usage-limit', 'content-refusal', 'worktree-busy', 'foreign-owner', 'cleanup-owner', 'user-blocker', 'user-task'])(
    'preserves the real %s boundary without filing another task', async boundary => {
      const task = blocked();
      if (boundary === 'foreign-owner') task.metadata.foreign = true;
      else if (boundary === 'cleanup-owner') task.metadata.recoveryOrigin = { subsystem: 'repository-cleanup' };
      else if (boundary === 'user-blocker') task.metadata.blocker = 'Wait for my decision.';
      else task.metadata.blockedCategory = boundary;
      const queues = { user: { tasks: boundary === 'user-task' ? [task] : [] }, cos: { tasks: boundary === 'user-task' ? [] : [task] } };
      await write(queues);
      await factory().sweep();
      expect(await read()).toEqual(queues);
      expect(created).toBe(0);
    });

  it('does not starve later failures behind already-owned investigations', async () => {
    const queues = await read();
    queues.cos.tasks = Array.from({ length: 5 }, (_, i) => ({ ...blocked(), id: `source-${i}` }));
    await write(queues);
    const recovery = factory();
    await recovery.sweep();
    await recovery.sweep();
    const originals = (await read()).cos.tasks.filter(task => task.id.startsWith('source-'));
    expect(originals.every(task => task.metadata.blockedInvestigation?.taskId === 'investigator-1')).toBe(true);
    expect(created).toBe(1);
  });

  it('requires the actual completed local agent record before owning a historical blocked task', async () => {
    const queues = await read();
    queues.cos.tasks[0].metadata.deliveryDecisionAgentId = 'agent-original';
    await write(queues);
    const good = { status: 'completed', taskId: 'system-original', metadata: { instanceId: 'fixture-local' } };
    for (const record of [null, { ...good, status: 'running' }, { ...good, taskId: 'other-task' },
      { ...good, metadata: { instanceId: 'another-instance' } }]) {
      identity.agent = record;
      expect(await factory(true).recover('system-original')).toMatchObject({ handled: false, reason: 'local-owner-unverified' });
      expect(created).toBe(0);
    }
    identity.agent = good;
    expect(await factory(true).recover('system-original')).toMatchObject({ handled: true, taskId: 'investigator-1' });
    expect(created).toBe(1);
  });

  it.each([[2, '1'], ['2', 1]])('holds a blocked task when its local owner receipt charged %s but its record retained %s', async (charged, retained) => {
    const queues = await read();
    queues.cos.tasks[0].metadata.deliveryDecisionAgentId = 'agent-original';
    queues.cos.tasks[0].metadata.totalSpawnCount = retained;
    await write(queues);
    identity.agent = { id: 'agent-original', status: 'completed', taskId: 'system-original', metadata: {
      instanceId: 'fixture-local', completionTaskDispatch: { taskId: 'system-original', taskType: 'internal',
        expected: [['claimedBy', 'fixture-local'], ['claimedAt', 'claimed'], ['lastSpawnedAt', 'spawned'], ['totalSpawnCount', charged]] } } };
    const recovery = factory(true);
    expect(await recovery.recover('system-original')).toEqual({ handled: false, reason: 'spawn-budget-reconciliation-required' });
    expect(await recovery.recover('system-original')).toEqual({ handled: false, reason: 'spawn-budget-reconciliation-required' });
    expect(await read()).toEqual(queues);
    expect(created).toBe(0);
  });

  it('lets a user/owner transition win before creation', async () => {
    race = true;
    expect(await factory().recover('system-original')).toMatchObject({ handled: false, reason: 'task-changed' });
    expect(created).toBe(0);
    expect((await read()).cos.tasks[0].status).toBe('completed');
  });
});
