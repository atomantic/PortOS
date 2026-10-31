/** Real archive trees, primary index and state snapshots under synthetic cuts. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { RELEASE_SYNC_OBLIGATIONS } from '../lib/releaseSynchronization.js';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
const fixture = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createFileWriteQueue } = await import('../lib/fileWriteQueue.js');
  const base = await mkdtemp(join(tmpdir(), 'cos-archive-backup-'));
  return { base, root: join(base, 'agents'), state: null, beforeIndex: null, bypass: false, withStateLock: createFileWriteQueue() };
});
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: fixture.root,
  loadState: async () => structuredClone(fixture.state),
  saveState: async state => { fixture.state = structuredClone(state); await writeFile(join(fixture.root, 'state.json'), JSON.stringify(state)); },
  withStateLock: fn => fixture.withStateLock(fn),
  readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: fixture.state.agents }),
}));
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, cos: fixture.base }, atomicWrite: async (path, data) => {
    if (path === join(fixture.root, 'index.json')) await fixture.beforeIndex?.();
    return actual.atomicWrite(path, data);
  } };
});
vi.mock('../lib/backupSnapshotBoundary.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, withBackupAssetPublication: work => fixture.bypass ? work() : actual.withBackupAssetPublication(work) };
});
vi.mock('./domainUsage.js', () => ({ recordDomainUsage: async () => {} }));
vi.mock('./codexSummaryRepair.js', () => ({ repairCodexTaskSummary: async () => null }));
vi.mock('./cosRunnerClient.js', () => ({ getActiveAgentsFromRunner: async () => [] }));
const deferred = () => {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
let api;
let index;
let acquireCut;
const date = '2001-01-01';
const id = 'agent-example';
let taskStore;
let taskRepo;
const readIndex = async () => JSON.parse(await readFile(join(fixture.root, 'index.json'), 'utf8'));
const assertIndexedTrees = async () => {
  for (const [agentId, bucket] of Object.entries(await readIndex())) {
    expect(await readFile(join(fixture.root, bucket, agentId, 'output.txt'), 'utf8')).toBe('Example preserved output');
    expect(JSON.parse(await readFile(join(fixture.root, bucket, agentId, 'metadata.json'), 'utf8')).id).toBe(agentId);
  }
};
async function seedAgent(agentId, { completed = false, indexed = false, resident = true, bucketDate = date, result = { success: true } } = {}) {
  const record = {
    id: agentId,
    status: completed ? 'completed' : 'running',
    startedAt: `${bucketDate}T01:00:00Z`,
    ...(completed ? { completedAt: `${bucketDate}T02:00:00Z`, result } : {}),
    metadata: {},
  };
  if (resident) fixture.state.agents[agentId] = record;
  const dir = indexed ? join(fixture.root, bucketDate, agentId) : join(fixture.root, agentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'output.txt'), 'Example preserved output');
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(record));
  if (indexed) { (await index.loadAgentIndex()).set(agentId, bucketDate); await index.saveAgentIndex(); }
}
async function seed({ completed = false, indexed = false } = {}) {
  await seedAgent(id, { completed, indexed });
}
beforeEach(async () => {
  vi.resetModules(); fixture.beforeIndex = null; fixture.bypass = false;
  fixture.state = { agents: {}, config: { completedAgentRetentionMs: 1 }, stats: { tasksCompleted: 0, errors: 0 } };
  await rm(fixture.root, { recursive: true, force: true }); await mkdir(fixture.root);
  await rm(join(fixture.base, 'release-synchronization.json'), { force: true });
  await writeFile(join(fixture.root, 'index.json'), '{}');
  ({ acquireBackupSnapshotCut: acquireCut } = await import('../lib/backupSnapshotBoundary.js'));
  taskRepo = await import('./cosTaskRepository.js');
  taskRepo.__resetCosTaskRepository();
  taskStore = await import('./cosTaskStore.js');
  taskStore.__resetTaskCache();
  index = await import('./cosAgentIndex.js');
  api = { ...await import('./cosAgentLifecycle.js'), ...await import('./cosAgentArchive.js') };
});
afterAll(() => rm(fixture.base, { recursive: true, force: true }));

it('retains publisher and continuation history until the outbox verifies synchronization', async () => {
  const publisher = 'agent-publisher';
  const continuation = 'agent-continuation';
  const unrelated = 'agent-unrelated';
  const unknown = 'agent-unknown';
  const identity = 'a'.repeat(64);
  const taskId = `task-release-sync-${identity}`;
  await seedAgent(publisher, { completed: true, indexed: true, resident: false });
  await seedAgent(continuation, { completed: true, indexed: true });
  await seedAgent(unrelated, { completed: true, indexed: true });
  await seedAgent(unknown, { completed: true, indexed: true, resident: false });
  const publisherPath = join(fixture.root, date, publisher, 'metadata.json');
  const publisherRecord = JSON.parse(await readFile(publisherPath, 'utf8'));
  publisherRecord.taskId = 'publisher-task';
  await writeFile(publisherPath, JSON.stringify(publisherRecord));
  fixture.state.agents[continuation].taskId = taskId;
  await writeFile(join(fixture.root, date, continuation, 'metadata.json'), JSON.stringify(fixture.state.agents[continuation]));
  fixture.state.agents[unrelated].taskId = 'unrelated-task';
  await writeFile(join(fixture.root, date, unrelated, 'metadata.json'), JSON.stringify(fixture.state.agents[unrelated]));
  const pointer = { dev: '1', ino: '2', birthtimeNs: '3' };
  const seed = { version: 1, agentId: publisher, startedAt: publisherRecord.startedAt, seededAt: '2001-01-01T01:00:01Z',
    repoPath: '/repo', path: '/candidate', branch: 'codex/release-publisher', repository: pointer, checkout: pointer,
    incarnation: { pointer, gitdir: { path: '/repo/.git/worktrees/candidate', ...pointer } } };
  const candidateHead = 'b'.repeat(40);
  const entry = {
    version: 1, identity,
    owner: { agentId: publisher, taskId: 'publisher-task', startedAt: publisherRecord.startedAt, workspace: '/repo' },
    publication: { identity, status: 'verified', repository: 'example/repo', promotionPrNumber: 12,
      candidateBranch: seed.branch, candidateHead },
    task: { id: taskId, metadata: { releaseSynchronization: { identity } } },
    obligations: Object.fromEntries(RELEASE_SYNC_OBLIGATIONS.map(name => [name, { status: 'pending' }])),
    checkouts: [seed], registeredAt: '2001-01-01T02:00:00Z', attempts: 1, lastAttemptAt: null, blocker: null, retryAt: null,
  };
  const { saveReleaseSynchronization } = await import('./releaseSynchronizationStore.js');
  await saveReleaseSynchronization(entry);

  for (const id of [publisher, continuation]) {
    await expect(api.deleteAgent(id)).rejects.toMatchObject({ status: 409, code: 'AGENT_CLEANUP_OWNED' });
  }
  // The same ownership survives eviction of the continuation from live state.
  delete fixture.state.agents[continuation];
  await expect(api.deleteAgent(continuation)).rejects.toMatchObject({ status: 409, code: 'AGENT_CLEANUP_OWNED' });
  // Missing archived task ownership cannot prove that this is not a continuation.
  expect(await api.clearCompletedAgents()).toEqual({ cleared: 1, retained: 3 });
  await assertIndexedTrees();

  entry.obligations = Object.fromEntries(RELEASE_SYNC_OBLIGATIONS.map(name => [name, {
    status: 'verified', verifiedAt: '2001-01-01T03:00:00Z', evidence: { receipt: name },
  }]));
  entry.synchronization = { status: 'blocked', attempts: 1, checkedAt: '2001-01-01T03:00:00Z',
    verifiedAt: null, retryAt: null, blocker: 'publisher-candidate-checkout-unverified' };
  await saveReleaseSynchronization(entry);
  expect(await api.clearCompletedAgents()).toEqual({ cleared: 0, retained: 3 });
  await assertIndexedTrees();
  const target = { agentId: publisher, repoPath: seed.repoPath, branch: seed.branch, path: seed.path, head: candidateHead,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(pointer), createdAt: seed.seededAt };
  entry.obligations.retirement.evidence = {
    checkouts: [target],
    receipts: [{ ...target, branchDeleted: true, archiveDir: null, retiredAt: '2001-01-01T02:30:00Z' }],
    publisherReview: { branch: seed.branch, path: seed.path, head: candidateHead, checkoutIdentity: target.checkoutIdentity,
      prUrl: 'https://github.com/example/repo/pull/12', receipt: null, models: [] },
  };
  entry.synchronization = { status: 'verified', attempts: 1, checkedAt: '2001-01-01T03:00:00Z',
    verifiedAt: '2001-01-01T03:00:00Z', retryAt: null, blocker: null };
  await saveReleaseSynchronization(entry);
  expect(await api.clearCompletedAgents()).toEqual({ cleared: 3, retained: 0 });
});

it('retains an enrolled publication before outbox registration and refuses cleanup when that outbox is unreadable', async () => {
  await seed({ completed: true, indexed: true });
  fixture.state.agents[id].taskId = 'publisher-task';
  fixture.state.agents[id].metadata.releasePublication = {
    status: 'verified', identity: 'b'.repeat(64), synchronizationHandoffVersion: 1,
  };
  await writeFile(join(fixture.root, date, id, 'metadata.json'), JSON.stringify(fixture.state.agents[id]));
  await expect(api.deleteAgent(id)).rejects.toMatchObject({ status: 409, code: 'AGENT_CLEANUP_OWNED' });
  expect(await api.clearCompletedAgents()).toEqual({ cleared: 0, retained: 1 });
  await writeFile(join(fixture.base, 'release-synchronization.json'), '{broken');
  await expect(api.deleteAgent(id)).rejects.toMatchObject({ status: 503, code: 'CLEANUP_OWNERSHIP_UNAVAILABLE' });
  await assertIndexedTrees();
});

it('preserves pending verification before the task hold is written and after archival', async () => {
  await seed({ completed: true, indexed: true });
  const agent = fixture.state.agents[id];
  agent.result.cleanupPending = true;
  agent.metadata.repoStateVerification = { status: 'pending' };
  const metadataPath = join(fixture.root, date, id, 'metadata.json');
  await writeFile(metadataPath, JSON.stringify(agent));

  expect(await api.clearCompletedAgents()).toEqual({ cleared: 0, retained: 1 });
  expect(fixture.state.agents[id]).toEqual(agent);
  delete fixture.state.agents[id];
  expect(await api.clearCompletedAgents()).toEqual({ cleared: 0, retained: 1 });
  await assertIndexedTrees();

  agent.metadata.repoStateVerification.status = 'completed';
  await writeFile(metadataPath, JSON.stringify(agent));
  expect(await api.clearCompletedAgents()).toEqual({ cleared: 1, retained: 0 });
});

it.each(['user', 'cos'])('preserves cleanup-owner evidence in the %s queue until delivery settles', async source => {
  await seed({ completed: true, indexed: true });
  // An archived owner is absent from resident state but still required after restart.
  delete fixture.state.agents[id];
  const taskType = source === 'cos' ? 'internal' : 'user';
  await taskStore.addTask({
    id: 'task-example',
    status: 'in_progress',
    priority: 'MEDIUM',
    priorityValue: 2,
    description: 'Cleanup task',
    metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: id },
  }, taskType, { raw: true });
  const beforeState = structuredClone(fixture.state);
  const beforeIndex = await readIndex();

  expect(await api.clearCompletedAgents()).toEqual({ cleared: 0, retained: 1 });
  expect(fixture.state).toEqual(beforeState);
  expect(await readIndex()).toEqual(beforeIndex);
  await assertIndexedTrees();

  await taskStore.updateTask('task-example', { status: 'completed' }, taskType);
  expect(await api.clearCompletedAgents()).toEqual({ cleared: 1, retained: 0 });
  expect(await readIndex()).toEqual({});
  expect(await readdir(fixture.root)).not.toContain(date);
});

const cases = [
  { name: 'completion', setup: () => seed(), run: () => api.completeAgent(id, { success: true }) },
  { name: 'zombie archive', setup: () => seed(), run: () => api.cleanupZombieAgents() },
  { name: 'stale archive', setup: () => seed({ completed: true }), run: () => api.archiveStaleAgents() },
  { name: 'single deletion', setup: () => seed({ completed: true, indexed: true }), run: () => api.deleteAgent(id) },
  { name: 'clear completed', setup: () => seed({ completed: true, indexed: true }), run: () => api.clearCompletedAgents() },
];
describe.each(cases)('$name', ({ setup, run }) => {
  it('keeps archive trees and the primary index behind an open cut', async () => {
    await setup();
    const beforeIndex = await readIndex();
    const beforeState = structuredClone(fixture.state);
    const beforeNames = await readdir(fixture.root);
    const release = await acquireCut();
    const work = run();
    try { await settle(); await settle(); expect(await readIndex()).toEqual(beforeIndex); expect(fixture.state).toEqual(beforeState); expect(await readdir(fixture.root)).toEqual(beforeNames); }
    finally { release(); }
    await work; await assertIndexedTrees();
  });

  it('drains directory changes through the last primary-index commit', async () => {
    await setup();
    const reached = deferred(); const commit = deferred();
    fixture.beforeIndex = async () => { reached.resolve(); await commit.promise; };
    const work = run(); await Promise.race([reached.promise, work.then(() => { throw new Error('workflow missed index seam'); })]);
    let ready = false;
    const cut = acquireCut().then(release => { ready = true; return release; });
    try { await settle(); expect(ready).toBe(false); }
    finally { commit.resolve(); }
    await work;
    const release = await cut;
    try { await assertIndexedTrees(); } finally { release(); }
  });
});
it('legacy migration holds moved directories and its new index in one publication', async () => {
  await seed({ completed: true });
  await rm(join(fixture.root, 'index.json'));
  const reached = deferred(); const commit = deferred();
  fixture.beforeIndex = async () => { reached.resolve(); await commit.promise; };
  const work = index.loadAgentIndex(); await Promise.race([reached.promise, work.then(() => { throw new Error('migration missed index seam'); })]);
  let ready = false;
  const cut = acquireCut().then(release => { ready = true; return release; });
  try { await settle(); expect(ready).toBe(false); } finally { commit.resolve(); }
  await work;
  const release = await cut;
  try { await assertIndexedTrees(); } finally { release(); }
});
it('index publication failure remains retryable for peer reconciliation', async () => {
  const pairs = [{ agentId: id, date }];
  fixture.beforeIndex = async () => { throw new Error('synthetic index write failure'); };
  await expect(index.addAgentArchivesToIndex(pairs)).rejects.toThrow('synthetic index write failure');
  expect(await readIndex()).toEqual({});
  fixture.beforeIndex = null;
  expect(await index.addAgentArchivesToIndex(pairs)).toBe(0);
  expect(await readIndex()).toEqual({ [id]: date });
});
it('negative control exposes an index naming a relocated tree missing from the earlier copy', async () => {
  await seed(); fixture.bypass = true;
  const copiedNames = await readdir(fixture.root);
  const release = await acquireCut();
  try {
    await api.completeAgent(id, { success: true });
    const bucket = (await readIndex())[id];
    expect(bucket).toBeTruthy(); expect(copiedNames).not.toContain(bucket);
  } finally { release(); }
});

describe.each([
  { name: 'single deletion', run: () => api.deleteAgent(id) },
  { name: 'clear completed', run: () => api.clearCompletedAgents() },
])('$name failure', ({ run }) => {
  it('retains indexed archive bytes and retries after a primary-index write failure', async () => {
    await seed({ completed: true, indexed: true });
    fixture.beforeIndex = async () => { throw new Error('synthetic index write failure'); };
    await expect(run()).rejects.toThrow('synthetic index write failure');
    await assertIndexedTrees();
    expect((await index.loadAgentIndex()).get(id)).toBe(date);
    fixture.beforeIndex = null;
    await run();
    expect(await readIndex()).toEqual({});
  });
});

it('does not let a cold reader queue its shared initialization ahead of an admitted publisher', async () => {
  await seed({ completed: true });
  await rm(join(fixture.root, 'index.json'));
  const { withBackupAssetPublication } = await import('../lib/backupSnapshotBoundary.js');
  const entered = deferred(); const proceed = deferred();
  const publisher = withBackupAssetPublication(async () => {
    entered.resolve(); await proceed.promise;
    return index.loadAgentIndex();
  });
  await entered.promise;
  const cut = acquireCut();
  const reader = index.loadAgentIndex();
  proceed.resolve();
  await publisher;
  const release = await cut;
  try { await assertIndexedTrees(); } finally { release(); }
  await reader;
});

describe('active cleanup and retry owner preservation (#13430)', () => {
  async function seedCleanupTask(taskId, metadata, taskType = 'internal') {
    return taskStore.addTask({
      id: taskId,
      status: 'in_progress',
      priority: 'MEDIUM',
      priorityValue: 2,
      description: `Cleanup task ${taskId}`,
      metadata,
    }, taskType, { raw: true });
  }

  it.each([
    { label: 'resident record', indexed: false, resident: true },
    { label: 'indexed archive', indexed: true, resident: false },
  ])('refuses single delete and retains $label while task holds deliveryRecovery cleanup', async ({ indexed, resident }) => {
    await seedAgent(id, { completed: true, indexed, resident });
    await seedCleanupTask('sys-rl-example', {
      deliveryRecovery: 'cleanup',
      deliveryRecoveryAgentId: id,
    });

    await expect(api.deleteAgent(id)).rejects.toMatchObject({
      status: 409,
      code: 'AGENT_CLEANUP_OWNED',
    });

    const record = await api.getAgent(id);
    expect(record?.id).toBe(id);
    if (resident) expect(fixture.state.agents[id]?.id).toBe(id);
    if (indexed) await assertIndexedTrees();

    await taskStore.updateTask('sys-rl-example', {
      status: 'completed',
      metadata: { deliveryRecovery: undefined, deliveryRecoveryAgentId: undefined },
    }, 'internal');

    await expect(api.deleteAgent(id)).resolves.toEqual({ success: true, agentId: id });
    expect(await api.getAgent(id)).toBeNull();
  });

  it('retains protected resident and archived runs across mixed buckets during clearCompletedAgents', async () => {
    const protectedResident = 'agent-protected-resident';
    const protectedArchived = 'agent-protected-archived';
    const unprotectedSameBucket = 'agent-unprotected-same-bucket';
    const unprotectedOtherBucket = 'agent-unprotected-other-bucket';
    const otherDate = '2001-01-02';

    await seedAgent(protectedResident, { completed: true, indexed: false, resident: true });
    await seedAgent(protectedArchived, { completed: true, indexed: true, resident: false, bucketDate: date });
    await seedAgent(unprotectedSameBucket, { completed: true, indexed: true, resident: true, bucketDate: date });
    await seedAgent(unprotectedOtherBucket, { completed: true, indexed: true, resident: false, bucketDate: otherDate });

    await seedCleanupTask('sys-rl-example', {
      deliveryRecovery: 'cleanup',
      deliveryRecoveryAgentId: protectedResident,
    }, 'internal');
    await seedCleanupTask('task-retry-example', {
      retryPendingCleanup: protectedArchived,
      retryPendingSince: `${date}T02:00:00.000Z`,
    }, 'user');

    const cleared = await api.clearCompletedAgents();
    expect(cleared).toEqual({ cleared: 2, retained: 2 });

    expect(fixture.state.agents[protectedResident]?.id).toBe(protectedResident);
    expect(fixture.state.agents[unprotectedSameBucket]).toBeUndefined();
    expect(await readIndex()).toEqual({ [protectedArchived]: date });
    await assertIndexedTrees();
    await expect(readFile(join(fixture.root, date, unprotectedSameBucket, 'metadata.json'), 'utf8')).rejects.toThrow();
    await expect(readdir(join(fixture.root, otherDate))).rejects.toThrow();

    await taskStore.updateTask('sys-rl-example', { status: 'completed' }, 'internal');
    await taskStore.updateTask('task-retry-example', { status: 'pending' }, 'user');

    const secondClear = await api.clearCompletedAgents();
    expect(secondClear).toEqual({ cleared: 2, retained: 0 });
    expect(fixture.state.agents).toEqual({});
    expect(await readIndex()).toEqual({});
  });

  it('does not retain completed history solely because a stale agent result still carries cleanupPending', async () => {
    await seedAgent(id, {
      completed: true,
      indexed: true,
      resident: true,
      result: { success: true, cleanupPending: true },
    });
    await taskStore.addTask({
      id: 'sys-rl-settled',
      status: 'completed',
      priority: 'MEDIUM',
      priorityValue: 2,
      description: 'Already settled task',
      metadata: {},
    }, 'internal', { raw: true });

    await expect(api.clearCompletedAgents()).resolves.toEqual({ cleared: 1, retained: 0 });
    expect(await api.getAgent(id)).toBeNull();
  });

  it('revalidates current task ownership under the state lock so a concurrent reassignment is not deleted', async () => {
    const oldOwner = 'agent-old-owner';
    const newOwner = 'agent-new-owner';
    await seedAgent(oldOwner, { completed: true, indexed: true, resident: true });
    await seedAgent(newOwner, { completed: true, indexed: true, resident: true });
    await seedCleanupTask('sys-rl-race', {
      deliveryRecovery: 'cleanup',
      deliveryRecoveryAgentId: oldOwner,
    }, 'internal');

    // Start clearCompletedAgents while an earlier task reassignment is holding the shared
    // state lock; clearCompletedAgents must read task ownership AFTER acquiring the lock,
    // not from a stale pre-lock snapshot.
    const entered = deferred();
    const release = deferred();
    const blocker = fixture.withStateLock(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const reassign = taskStore.updateTask('sys-rl-race', {
      status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: newOwner },
    }, 'internal');
    await settle();
    const clear = api.clearCompletedAgents();
    await settle();

    release.resolve();
    await blocker;
    const [, clearResult] = await Promise.all([reassign, clear]);
    expect(clearResult).toEqual({ cleared: 1, retained: 1 });
    expect((await api.getAgent(newOwner))?.id).toBe(newOwner);
    expect(await api.getAgent(oldOwner)).toBeNull();
  });

  it('preserves evidence when task cleanup ownership cannot be verified', async () => {
    await seedAgent(id, { completed: true, indexed: true, resident: true });
    const spy = vi.spyOn(taskStore, 'getTaskView').mockRejectedValueOnce(new Error('task store unavailable'));
    try {
      await expect(api.deleteAgent(id)).rejects.toMatchObject({
        status: 503,
        code: 'CLEANUP_OWNERSHIP_UNAVAILABLE',
      });
      expect((await api.getAgent(id))?.id).toBe(id);
      await assertIndexedTrees();
    } finally {
      spy.mockRestore();
    }
  });
});
