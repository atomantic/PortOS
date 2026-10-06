import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ beforeWrite: null, root: null }));
state.root = await mkdtemp(join(tmpdir(), 'runtime-recording-publication-'));
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return { ...actual, atomicWrite: async (path, data) => {
    await state.beforeWrite?.(path, data);
    return actual.atomicWrite(path, data);
  } };
});
vi.mock('./cosAgentLifecycle.js', () => ({
  appendAgentOutputLines: async (_id, lines) => {
    const { atomicWrite } = await import('../lib/fileUtils.js');
    await atomicWrite(join(state.root, 'state.json'), { lines });
  },
  updateAgent: async (_id, patch) => {
    const { atomicWrite } = await import('../lib/fileUtils.js');
    await atomicWrite(join(state.root, 'state.json'), patch);
  },
}));
vi.mock('../lib/tuiHandshake.js', () => ({ OUTPUT_BUFFER_CAP: 50, OUTPUT_BUFFER_HEADROOM: 100, RAW_SPOOL_MAX_BYTES: 10 }));

const { finalizeRunRecord, setAIToolkit } = await import('./runner.js');
const { persistRunnerCompletion } = await import('../cos-runner/completion.js');
const { createTuiExitHandler } = await import('../cos-runner/tuiExit.js');
const { createOutputSpooler } = await import('./agentTuiSpawning/outputSpooler.js');
const { acquireBackupSnapshotCut } = await import('../lib/backupSnapshotBoundary.js');
const { atomicWrite } = await import('../lib/fileUtils.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

beforeEach(async () => {
  state.beforeWrite = null;
  await rm(state.root, { recursive: true, force: true }); await mkdir(state.root);
  setAIToolkit({ services: { runner: {} } }, { dataDir: state.root });
});
afterAll(async () => { await rm(state.root, { recursive: true, force: true }); });

async function snapshotAfterDraining(work, reached, finish, verify) {
  await reached;
  let acquired = false;
  const cut = acquireBackupSnapshotCut().then(release => { acquired = true; return release; });
  try { await turn(); expect(acquired, 'the snapshot must drain the whole recording publication').toBe(false); }
  finally { finish(); }
  await work;
  const release = await cut;
  try { await verify(); } finally { release(); }
}

it('drains the host TUI/failed-run finalizer through output plus metadata', async () => {
  const dir = join(state.root, 'runs', 'example'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'output.txt'), 'old');
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ id: 'example', outputSize: 3 }));
  const reached = deferred(); const finish = deferred();
  state.beforeWrite = async path => { if (path.endsWith('metadata.json')) { reached.resolve(); await finish.promise; } };
  const work = finalizeRunRecord({ runId: 'example', output: 'new result', success: true, exitCode: 0, startTime: Date.now() });
  await snapshotAfterDraining(work, reached.promise, finish.resolve, async () => {
    expect(await readFile(join(dir, 'output.txt'), 'utf8')).toBe('new result');
    expect(await readJson(join(dir, 'metadata.json'))).toMatchObject({ success: true, outputSize: 10 });
  });
});

it('rolls back the previous recording when completion metadata fails', async () => {
  const dir = join(state.root, 'runs', 'example'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'output.txt'), 'old');
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ id: 'example', outputSize: 3 }));
  state.beforeWrite = async (path, data) => {
    if (path.endsWith('metadata.json') && data.success === true) throw new Error('injected metadata failure');
  };
  await expect(finalizeRunRecord({ runId: 'example', output: 'new result', success: true, exitCode: 0, startTime: Date.now() }))
    .rejects.toThrow('injected metadata failure');
  const release = await acquireBackupSnapshotCut();
  try {
    expect(await readFile(join(dir, 'output.txt'), 'utf8')).toBe('old');
    expect(await readJson(join(dir, 'metadata.json'))).toEqual({ id: 'example', outputSize: 3 });
  } finally { release(); }
});

it('keeps a separate-runner TUI recording and durable ownership removal in one cut', async () => {
  const reached = deferred(); const finish = deferred();
  const runnerState = { agents: { example: {} }, stats: { completed: 0, failed: 0 } };
  const runnerStatePath = join(state.root, 'runner-state.json');
  await writeFile(runnerStatePath, JSON.stringify(runnerState));
  state.beforeWrite = async path => { if (path === runnerStatePath) { reached.resolve(); await finish.promise; } };
  const agent = { startedAt: Date.now(), outputBuffer: 'terminal tail', completedBySentinel: true, completionOutput: 'finished' };
  const exit = createTuiExitHandler({ agentId: 'example', taskId: 'task', sessionId: 'session', agent,
    activeAgents: new Map([['example', agent]]), io: { emit() {} }, emitToServer() {},
    persistCompletion: (...args) => persistRunnerCompletion(state.root, ...args),
    withState: async work => { await work(runnerState); await atomicWrite(runnerStatePath, runnerState); },
  });
  await snapshotAfterDraining(exit({ exitCode: 0 }), reached.promise, finish.resolve, async () => {
    expect(await readFile(join(state.root, 'example', 'output.txt'), 'utf8')).toBe('finished');
    expect(await readJson(join(state.root, 'example', 'metadata.json'))).toMatchObject({ success: true, outputSize: 8 });
    expect((await readJson(runnerStatePath)).agents).toEqual({});
  });
});

it('holds parsed spool bytes and state through the same snapshot drain', async () => {
  const reached = deferred(); const finish = deferred();
  state.beforeWrite = async path => { if (path.endsWith('state.json')) { reached.resolve(); await finish.promise; } };
  const spool = createOutputSpooler({ agentId: 'example', outputFile: join(state.root, 'output.txt'), rawFile: join(state.root, 'raw.txt') });
  spool.appendLine('example line');
  await snapshotAfterDraining(spool.drainLines(), reached.promise, finish.resolve, async () => {
    expect(await readFile(join(state.root, 'output.txt'), 'utf8')).toBe('example line\n');
    expect(await readJson(join(state.root, 'state.json'))).toEqual({ lines: ['example line'] });
  });
});

it('holds raw truncation and its durable warning through the same snapshot drain', async () => {
  const reached = deferred(); const finish = deferred();
  const spool = createOutputSpooler({ agentId: 'example', outputFile: join(state.root, 'output.txt'), rawFile: join(state.root, 'raw.txt') });
  spool.pushRaw('old bytes'); await spool.drainRaw();
  state.beforeWrite = async path => { if (path.endsWith('state.json')) { reached.resolve(); await finish.promise; } };
  spool.pushRaw('new bytes');
  await snapshotAfterDraining(spool.drainRaw(), reached.promise, finish.resolve, async () => {
    expect(await readFile(join(state.root, 'raw.txt'), 'utf8')).toBe('new bytes');
    expect(await readJson(join(state.root, 'state.json'))).toEqual({ metadata: { rawSpoolTruncated: true } });
  });
});


it('preserves the old raw spool when the truncation warning cannot persist', async () => {
  const spool = createOutputSpooler({ agentId: 'example', outputFile: join(state.root, 'output.txt'), rawFile: join(state.root, 'raw.txt') });
  spool.pushRaw('old bytes'); await spool.drainRaw();
  state.beforeWrite = async path => { if (path.endsWith('state.json')) throw new Error('warning write refused'); };
  spool.pushRaw('new bytes');
  await expect(spool.drainRaw()).rejects.toThrow('warning write refused');
  expect(await readFile(join(state.root, 'raw.txt'), 'utf8')).toBe('old bytes');
  state.beforeWrite = null;
  spool.pushRaw('retry'); await spool.drainRaw();
  expect(await readFile(join(state.root, 'raw.txt'), 'utf8')).toBe('retry');
  expect(await readJson(join(state.root, 'state.json'))).toEqual({ metadata: { rawSpoolTruncated: true } });
});
