/** Real archive trees, primary index and state snapshots under synthetic cuts. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
const fixture = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: await mkdtemp(join(tmpdir(), 'cos-archive-backup-')), state: null, beforeIndex: null, bypass: false };
});
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: fixture.root,
  loadState: async () => structuredClone(fixture.state),
  saveState: async state => { fixture.state = structuredClone(state); await writeFile(join(fixture.root, 'state.json'), JSON.stringify(state)); },
  withStateLock: createFileWriteQueue(),
  readAgentsStateForSafetyCheck: async () => ({ trusted: true, agents: fixture.state.agents }),
}));
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, atomicWrite: async (path, data) => {
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
const readIndex = async () => JSON.parse(await readFile(join(fixture.root, 'index.json'), 'utf8'));
const assertIndexedTrees = async () => {
  for (const [agentId, bucket] of Object.entries(await readIndex())) {
    expect(await readFile(join(fixture.root, bucket, agentId, 'output.txt'), 'utf8')).toBe('Example preserved output');
    expect(JSON.parse(await readFile(join(fixture.root, bucket, agentId, 'metadata.json'), 'utf8')).id).toBe(agentId);
  }
};
async function seed({ completed = false, indexed = false } = {}) {
  fixture.state.agents[id] = { id, status: completed ? 'completed' : 'running', startedAt: `${date}T01:00:00Z`,
    ...(completed ? { completedAt: `${date}T02:00:00Z`, result: { success: true } } : {}), metadata: {} };
  const dir = indexed ? join(fixture.root, date, id) : join(fixture.root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'output.txt'), 'Example preserved output');
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(fixture.state.agents[id]));
  if (indexed) { (await index.loadAgentIndex()).set(id, date); await index.saveAgentIndex(); }
}
beforeEach(async () => {
  vi.resetModules(); fixture.beforeIndex = null; fixture.bypass = false;
  fixture.state = { agents: {}, config: { completedAgentRetentionMs: 1 }, stats: { tasksCompleted: 0, errors: 0 } };
  await rm(fixture.root, { recursive: true, force: true }); await mkdir(fixture.root);
  await writeFile(join(fixture.root, 'index.json'), '{}');
  ({ acquireBackupSnapshotCut: acquireCut } = await import('../lib/backupSnapshotBoundary.js'));
  index = await import('./cosAgentIndex.js');
  api = { ...await import('./cosAgentLifecycle.js'), ...await import('./cosAgentArchive.js') };
});
afterAll(() => rm(fixture.root, { recursive: true, force: true }));
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
