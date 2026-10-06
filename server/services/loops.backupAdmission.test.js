import { afterAll, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ root: null, beforeWrite: null, providerFinish: null, providerReached: null }));
state.root = await mkdtemp(join(tmpdir(), 'loop-recording-publication-'));
const provider = { id: 'example', name: 'Example', defaultModel: 'example-model' };
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: { ...actual.PATHS, data: state.root }, atomicWrite: async (path, data) => {
    await state.beforeWrite?.(path, data); return actual.atomicWrite(path, data);
  } };
});
vi.mock('./runner.js', () => ({ createRun: async () => ({ metadata: { id: 'example-run' }, provider }) }));
vi.mock('./providers.js', () => ({ getActiveProvider: async () => provider, listSelectableProviders: async () => [provider] }));
vi.mock('./promptRunner.js', () => ({
  assertProvider() {}, resolveProviderAndModel: async () => ({ provider }),
  runPromptThroughProvider: async ({ onData }) => {
    state.providerReached(); await state.providerFinish;
    onData('example result'); return { text: 'example result', model: 'example-model' };
  },
}));
const { createLoop, triggerLoop, stopLoop, loopEvents } = await import('./loops.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
afterAll(async () => { await rm(state.root, { recursive: true, force: true }); });

it('allows backup during the model run, then drains the loop result through iteration metadata', async () => {
  const providerReached = deferred(); const providerFinish = deferred();
  state.providerReached = providerReached.resolve; state.providerFinish = providerFinish.promise;
  const loop = await createLoop({ prompt: 'example', interval: '1h', runImmediately: false });
  const reached = deferred(); const finish = deferred();
  const completed = new Promise(resolve => loopEvents.once('iteration:complete', resolve));
  try {
    await triggerLoop(loop.id); await providerReached.promise;
    const releaseDuringModel = await acquireBackupSnapshotCut(); releaseDuringModel();
    state.beforeWrite = async (path, data) => {
      if (path.endsWith('loops.json') && data[0]?.iterationCount === 1) { reached.resolve(); await finish.promise; }
    };
    providerFinish.resolve(); await reached.promise;
    let acquired = false;
    const cut = acquireBackupSnapshotCut().then(release => { acquired = true; return release; });
    try { await turn(); expect(acquired).toBe(false); } finally { finish.resolve(); }
    await completed;
    const release = await cut;
    try {
      expect(await readFile(join(state.root, 'loops', `${loop.id}-1.txt`), 'utf8')).toBe('example result');
      const loops = JSON.parse(await readFile(join(state.root, 'loops.json'), 'utf8'));
      expect(loops[0]).toMatchObject({ iterationCount: 1, lastExitCode: 0 });
    } finally { release(); }
  } finally { state.beforeWrite = null; await stopLoop(loop.id); }
});
