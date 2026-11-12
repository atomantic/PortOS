import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
const state = vi.hoisted(() => ({ settings: {}, workers: [], blenderProbe: 'passes', hold: null, onReadSettings: null }));
vi.mock('../settings.js', () => ({ getSettings: async () => {
  const settings = state.settings;
  await state.onReadSettings?.();
  return settings;
}, updateSettings: async patch => { state.settings = { ...state.settings, ...patch }; } }));
vi.mock('../browserService.js', () => ({ cdpRequest: async () => ({ ok: false }) }));
vi.mock('./containedWorker.js', () => ({
  currentContainmentMechanism: async () => ({ supported: false, reason: 'Synthetic unavailable sandbox' }),
  runContainedWorker: vi.fn(() => { throw new Error('No contained fallback'); }),
  runTrustedLocalWorker: vi.fn(async options => {
    state.workers.push(options);
    await state.hold;
    const source = options.files[0].content;
    const reason = source.includes('Buffer.alloc(512') ? 'memory' : source.includes('setInterval') ? 'disk' : options.limits.wallSeconds === 1 ? 'time' : 'canceled';
    return { status: 'terminated', reason, processGroupClear: true };
  }),
}));
vi.mock('./blenderProbe.js', () => ({ probeBlenderRender: async (tool, _root, options) => {
  if (state.blenderProbe === 'throws') throw new Error('Synthetic check fault');
  return { ...tool, executionMode: options.executionMode, engine: options.engine,
    passed: true, version: '4.2.0', render: { engine: options.engine, device: 'CPU', backend: 'CPU' } };
} }));

const root = await mkdtemp(join(tmpdir(), 'blender-authority-test-'));
afterAll(() => rm(root, { recursive: true, force: true }));
const executable = join(root, 'Example.app', 'Contents', 'MacOS', 'Blender');
const writeExecutable = async (content = 'synthetic runtime') => {
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, content);
  await chmod(executable, 0o755);
};
const renderer = { kind: 'blender', version: '4.2.0', engine: 'CYCLES' };
const trustedLocal = { executable, executionMode: 'trusted-local' };
const UNCHECKED = { ready: false, reason: expect.stringMatching(/^Run the execution check/) };

// A fresh module graph stands in for a fresh server process: the check lives in
// module memory, and the settings double is the only thing a restart keeps.
const startProcess = async () => {
  vi.resetModules();
  state.workers.length = 0;
  const [{ default: router }, execution, { errorMiddleware }, { request }] = await Promise.all([
    import('../../routes/codeAnimationExecution.js'), import('./execution.js'), import('../../lib/errorHandler.js'), import('../../lib/testHelper.js'),
  ]);
  const app = express(); app.use(express.json()); app.use('/execution', router); app.use(errorMiddleware);
  return {
    execution,
    read: () => request(app).get('/execution'),
    save: blender => request(app).put('/execution/tools').send({ blender }),
    check: () => request(app).post('/execution/probe'),
  };
};
// One process in which the operator saved Trusted local and passed the check.
const checkedProcess = async () => {
  const server = await startProcess();
  expect((await server.save(trustedLocal)).status).toBe(200);
  expect((await server.check()).body.lanes.blender.ready).toBe(true);
  return server;
};

beforeEach(async () => {
  state.settings = {};
  state.blenderProbe = 'passes';
  state.hold = null;
  state.onReadSettings = null;
  await writeExecutable();
});

describe.skipIf(!['darwin', 'linux'].includes(process.platform))('machine-owned Blender execution authority', () => {
  it('defaults closed, saves Trusted local on the mode alone, binds successful checks, and revokes them on save', async () => {
    const server = await startProcess();
    expect((await server.save({ executable })).body.executionMode).toBe('contained');
    expect((await server.check()).body.lanes.blender.ready).toBe(false);
    expect(state.workers).toHaveLength(0);
    // The saved mode is the grant: no acknowledgement field is required, and
    // the one an older client still sends is accepted and never stored.
    const stored = { executable: await realpath(executable), executionMode: 'trusted-local', engine: 'CYCLES' };
    expect((await server.save(trustedLocal)).status).toBe(200);
    expect(state.settings.codeAnimationExecution.blender).toEqual(stored);
    expect((await server.save({ ...trustedLocal, acknowledgeHostAccess: true })).status).toBe(200);
    expect(state.settings.codeAnimationExecution.blender).toEqual(stored);
    expect((await server.save({ ...trustedLocal, unknownField: true })).status).toBe(400);
    const ready = (await server.check()).body;
    expect(ready).toMatchObject({ contained: false, executionMode: 'trusted-local', lanes: { blender: { ready: true } } });
    expect(state.workers).toHaveLength(4);
    const { resolveBlenderExecution } = server.execution;
    const bound = await resolveBlenderExecution(renderer);
    expect(bound.provenance).toMatchObject({ executionMode: 'trusted-local', contained: false });
    await expect(resolveBlenderExecution({ ...renderer, version: '4.3.0' })).rejects.toMatchObject({ code: 'CODE_ANIMATION_BLENDER_RUNTIME_MISMATCH' });
    // A patch update of the checked executable keeps projects on the same series renderable.
    expect((await resolveBlenderExecution({ ...renderer, version: '4.2.5' })).provenance.version).toBe('4.2.0');
    await expect(resolveBlenderExecution(renderer, { binding: 'old-check' })).rejects.toMatchObject({ code: 'CODE_ANIMATION_BLENDER_READINESS_CHANGED' });
    await server.save(trustedLocal);
    await expect(resolveBlenderExecution(renderer, bound.provenance)).rejects.toMatchObject({ code: 'CODE_ANIMATION_BLENDER_NOT_READY' });
  });

  // Regression: every restart left the Blender lane refused until someone pressed "Run execution check".
  it('re-runs an unchanged, already checked configuration on the first read after a restart', async () => {
    await checkedProcess();
    expect(state.settings.codeAnimationExecutionArmed).toEqual({
      executable: await realpath(executable), fingerprint: expect.any(String), executionMode: 'trusted-local', engine: 'CYCLES',
    });

    // Readers that arrive together wait on one run instead of starting two or reading "not ready" mid-check.
    const restarted = await startProcess();
    const reads = await Promise.all([restarted.read(), restarted.read()]);
    for (const { body } of reads) expect(body).toMatchObject({ probe: { passed: true }, lanes: { blender: { ready: true, reason: null } } });
    expect(state.workers).toHaveLength(4);

    // A render that is the first thing to ask after a restart is covered the same way.
    const rendering = await startProcess();
    await expect(rendering.execution.resolveBlenderExecution(renderer)).resolves.toMatchObject({ provenance: { executionMode: 'trusted-local', version: '4.2.0' } });
    expect(state.workers).toHaveLength(4);

    // Server boot calls this hook, so the run is usually over before anything reads the lane.
    const booted = await startProcess();
    await booted.execution.rearmCodeAnimationExecution();
    expect(state.workers).toHaveLength(4);
    expect((await booted.read()).body.lanes.blender.ready).toBe(true);
    expect(state.workers).toHaveLength(4);
  });

  // Regression guard for the rule the automatic re-check must not loosen: a changed configuration needs an explicit check.
  it('keeps a configuration saved or replaced since its check refused after a restart until an explicit check', async () => {
    const server = await checkedProcess();
    expect((await server.save(trustedLocal)).status).toBe(200);
    expect(state.settings.codeAnimationExecutionArmed).toBeNull();
    const resaved = await startProcess();
    expect((await resaved.read()).body).toMatchObject({ probe: null, lanes: { blender: UNCHECKED } });
    expect(state.workers).toHaveLength(0);
    expect((await resaved.check()).body.lanes.blender.ready).toBe(true);

    // The same path now holds a different file (an in-place update): its saved check does not carry over.
    await writeExecutable('synthetic runtime, replaced');
    const replaced = await startProcess();
    expect((await replaced.read()).body).toMatchObject({ probe: null, lanes: { blender: UNCHECKED } });
    await expect(replaced.execution.resolveBlenderTool()).rejects.toMatchObject({ code: 'CODE_ANIMATION_BLENDER_NOT_READY' });
    expect(state.workers).toHaveLength(0);
    expect((await replaced.check()).body.lanes.blender.ready).toBe(true);

    // The stored tools moved without the tools route (a generic settings save, a restored file): the record no longer describes them.
    const checked = state.settings;
    for (const change of [{ engine: 'BLENDER_EEVEE_NEXT' }, { executionMode: 'contained' }]) {
      state.settings = { ...checked, codeAnimationExecution: { blender: { ...checked.codeAnimationExecution.blender, ...change } } };
      const edited = await startProcess();
      expect((await edited.read()).body.probe, JSON.stringify(change)).toBeNull();
      expect(state.workers, JSON.stringify(change)).toHaveLength(0);
    }
  });

  // Regression: a check asked for right after a save joined the older run still in flight, whose result that save
  // had revoked, and came back "not checked" for a configuration nobody had tested.
  it('gives a check requested after a save its own run while an older one is still finishing', async () => {
    await checkedProcess();
    const restarted = await startProcess();
    let release;
    state.hold = new Promise(resolve => { release = resolve; });
    // The request helper sends on then(), so each in-flight call is started explicitly.
    const reading = restarted.read().then(response => response);
    await vi.waitFor(() => expect(state.workers).toHaveLength(1));
    expect((await restarted.save(trustedLocal)).body.lanes.blender).toEqual(UNCHECKED);
    const checking = restarted.check().then(response => response);
    // Its own run starts while the older one is still held.
    await vi.waitFor(() => expect(state.workers).toHaveLength(2));
    release();
    expect((await checking).body.lanes.blender.ready).toBe(true);
    // The revoked run ends without a result and without disturbing the one that answered.
    expect((await reading).status).toBe(200);
    expect((await restarted.read()).body.lanes.blender.ready).toBe(true);
    expect(state.settings.codeAnimationExecutionArmed).toMatchObject({ executionMode: 'trusted-local' });
  });

  it('does not automatically check a configuration saved while inspecting the previously armed one', async () => {
    await checkedProcess();
    const restarted = await startProcess();
    let releaseInspection;
    const holdInspection = new Promise(resolve => { releaseInspection = resolve; });
    let reads = 0;
    let inspecting;
    const inspected = new Promise(resolve => { inspecting = resolve; });
    state.onReadSettings = async () => {
      if (++reads === 2) { inspecting(); await holdInspection; }
    };
    const rearming = restarted.execution.rearmCodeAnimationExecution();
    await inspected;
    expect((await restarted.save({ ...trustedLocal, engine: 'BLENDER_EEVEE_NEXT' })).body.lanes.blender).toEqual(UNCHECKED);
    releaseInspection();
    await rearming;
    expect(state.workers).toHaveLength(0);
    expect((await restarted.read()).body.lanes.blender).toEqual(UNCHECKED);
    expect(state.settings.codeAnimationExecutionArmed).toBeNull();
    expect((await restarted.check()).body.lanes.blender.ready).toBe(true);
  });

  // Regression: a check that cannot complete must not be started again by every readiness read.
  it('attempts a failing automatic re-check once per process and leaves the explicit check working', async () => {
    await checkedProcess();
    state.blenderProbe = 'throws';
    const restarted = await startProcess();
    const first = await restarted.read();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ probe: null, lanes: { blender: UNCHECKED } });
    expect(state.workers).toHaveLength(4);

    state.blenderProbe = 'passes';
    expect((await restarted.read()).body.lanes.blender).toEqual(UNCHECKED);
    expect(state.workers).toHaveLength(4);
    expect((await restarted.check()).body.lanes.blender.ready).toBe(true);
    expect(state.workers).toHaveLength(8);
  });
});
