import { afterAll, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile, utimes, access } from 'node:fs/promises';
import { join } from 'node:path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'runtime-deletion-' });
const seam = vi.hoisted(() => ({ beforeRemove: null }));
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return { ...makeProxy(actual), rmGuarded: async (...args) => { await seam.beforeRemove?.(args[0]); return actual.rmGuarded(...args); } };
});
vi.mock('./apps.js', () => ({ getAppById: async () => null }));
vi.mock('./providerStatus.js', () => ({ initProviderStatus: async () => {} }));
vi.mock('./cosRunnerClient.js', () => ({ isRunnerAvailable: async () => false, isRunnerReachable: async () => false,
  initCosRunnerConnection() {}, onCosRunnerEvent() {} }));
vi.mock('./agentManagement.js', () => ({ cleanupOrphanedAgents: async () => {} }));
vi.mock('./agentOrchestrator.js', () => ({ spawnAgentForTask: async () => {}, terminateAgent: async () => {} }));
vi.mock('./agentLifecycle.js', () => ({ handleAgentCompletion: async () => {} }));
vi.mock('./agentRunTracking.js', () => ({ completeAgentRun: async () => {} }));
const { createFeatureAgent, deleteFeatureAgent } = await import('./featureAgents.js');
const { initSpawner } = await import('./subAgentSpawner.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { PATHS } = await import('../lib/fileUtils.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
afterAll(cleanup);

it('drains feature-agent row removal through deletion of its run directory', async () => {
  const agent = await createFeatureAgent({ name: 'Example', appId: 'example' });
  const dir = join(tempRoot, 'cos', 'feature-agents', agent.id); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'recording.txt'), 'example recording');
  const reached = deferred(); const finish = deferred();
  seam.beforeRemove = async path => { if (path === dir) { reached.resolve(); await finish.promise; } };
  const deletion = deleteFeatureAgent(agent.id); await reached.promise;
  let acquired = false;
  const cut = acquireBackupSnapshotCut().then(release => { acquired = true; return release; });
  try { await turn(); expect(acquired).toBe(false); } finally { finish.resolve(); }
  await deletion;
  const release = await cut;
  try {
    expect(JSON.parse(await readFile(join(tempRoot, 'cos', 'feature-agents.json'), 'utf8')).agents).toEqual([]);
    await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { release(); seam.beforeRemove = null; }
});

it('defers startup recording pruning until the active backup cut finishes', async () => {
  const dir = join(PATHS.runs, 'old-run'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ id: 'old-run', outputSize: 7 }));
  await writeFile(join(dir, 'output.txt'), 'example');
  const old = new Date(Date.now() - 40 * 24 * 3600000); await utimes(dir, old, old);
  const release = await acquireBackupSnapshotCut();
  let settled = false;
  const init = initSpawner().then(() => { settled = true; });
  try {
    await turn(); await turn();
    expect(settled).toBe(false);
    expect(await readFile(join(dir, 'output.txt'), 'utf8')).toBe('example');
  } finally { release(); }
  await init;
  await expect(access(dir)).rejects.toMatchObject({ code: 'ENOENT' });
});
