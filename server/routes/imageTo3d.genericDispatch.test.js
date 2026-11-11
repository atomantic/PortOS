import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Proves GET /targets and the install SSE route dispatch purely through the
// target-descriptor (targets.js) + adapter-registry (adapters.js) contracts — a
// second, unrelated target needs zero new branches in routes/imageTo3d.js
// (#3080). These fakes deliberately share no code with TRELLIS.2.

const FAKE_TARGET = Object.freeze({
  id: 'fakegen',
  label: 'FakeGen',
  executionLane: 'hosted-api',
  outputKind: 'glb-mesh',
  available: true,
  unavailableReason: null,
});

// Partial mock — the registry resolvers are stubbed to the synthetic target, but
// the reason→label helpers stay real (the install-refusal message renders them).
vi.mock('../services/imageTo3d/targets.js', async (importOriginal) => ({
  ...(await importOriginal()),
  detectHostCapabilities: vi.fn(() => ({ appleSilicon: true, unifiedMemoryGb: 128, cuda: false })),
  getTarget: vi.fn((id) => (id === 'fakegen' ? FAKE_TARGET : null)),
  listTargets: vi.fn(() => [FAKE_TARGET]),
  unavailableReason: vi.fn(() => null),
  IMAGE_TO_3D_TARGET_IDS: ['fakegen'],
}));

const fakeIsInstalled = vi.fn(() => false);
const fakeInstall = vi.fn(({ onEvent }) => {
  onEvent({ type: 'stage', stage: 'fake-step', message: 'installing FakeGen…' });
  onEvent({ type: 'complete', message: 'FakeGen installed.' });
  return { promise: Promise.resolve({ ok: true }), kill: vi.fn() };
});
const fakeDescribeInstallState = vi.fn(async () => ({ fields: { fakeDiag: 'ok' }, warnings: [] }));
const fakeAdapter = {
  isInstalled: fakeIsInstalled,
  install: fakeInstall,
  run: vi.fn(),
  describeInstallState: fakeDescribeInstallState,
};

vi.mock('../services/imageTo3d/adapters.js', () => ({
  getTargetAdapter: vi.fn((id) => (id === 'fakegen' ? fakeAdapter : null)),
}));

vi.mock('../services/hfToken.js', () => ({ hfChildEnv: vi.fn(async () => ({})) }));

vi.mock('../services/imageTo3d/models.js', () => ({
  listModels: vi.fn(),
  getModel: vi.fn(),
  createModel: vi.fn(),
  startGeneration: vi.fn(),
  deleteModel: vi.fn(),
  getModelAsset: vi.fn(),
  // Read at module scope by the USDZ body parser, so — unlike the handler-only
  // exports above — omitting it fails the IMPORT, not a test.
  USDZ_MAX_BYTES: 64 * 1024 * 1024,
}));

import { hfChildEnv } from '../services/hfToken.js';
import { getTargetAdapter } from '../services/imageTo3d/adapters.js';
import { unavailableReason } from '../services/imageTo3d/targets.js';
import routes from './imageTo3d.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/image-to-3d', routes);
  app.use(errorMiddleware);
  return app;
};

const sseFrames = (text) => text
  .split('\n')
  .filter((l) => l.startsWith('data: '))
  .map((l) => JSON.parse(l.slice(6)));

describe('image-to-3d generic target dispatch (#3080)', () => {
  it('GET /targets resolves installed-state through the adapter registry alone', async () => {
    const res = await request(makeApp()).get('/api/image-to-3d/targets');
    expect(res.status).toBe(200);
    expect(res.body.targets[0]).toMatchObject({ id: 'fakegen', installed: false });
    expect(fakeDescribeInstallState).not.toHaveBeenCalled();
  });

  it('GET /targets merges describeInstallState fields once installed', async () => {
    fakeIsInstalled.mockReturnValueOnce(true);
    const res = await request(makeApp()).get('/api/image-to-3d/targets');
    expect(res.body.targets[0]).toMatchObject({ installed: true, fakeDiag: 'ok' });
  });

  it('POST /targets/:targetId/install dispatches to the registered adapter', async () => {
    const res = await request(makeApp()).post('/api/image-to-3d/targets/fakegen/install');
    const frames = sseFrames(res.text);
    expect(frames).toContainEqual({ type: 'stage', stage: 'fake-step', message: 'installing FakeGen…' });
    expect(frames.at(-1)).toMatchObject({ type: 'complete' });
    expect(fakeInstall).toHaveBeenCalled();
  });

  // #3080: env/credential resolution is adapter-owned (`resolveEnv`), not a
  // dispatch-layer assumption that every target wants a Hugging Face token —
  // a target that declares no `resolveEnv` must never trigger one.
  it('never resolves the Hugging Face token env for a target with no resolveEnv hook', async () => {
    await request(makeApp()).post('/api/image-to-3d/targets/fakegen/install');
    expect(hfChildEnv).not.toHaveBeenCalled();
    expect(fakeInstall).toHaveBeenCalledWith(expect.objectContaining({ env: undefined }));
  });

  it('streams Repair for an installed runtime and passes the adapter environment', async () => {
    const env = { HF_TOKEN: 'hf_test' };
    fakeIsInstalled.mockReturnValueOnce(true);
    getTargetAdapter.mockReturnValueOnce({ ...fakeAdapter, resolveEnv: async () => env });
    const res = await request(makeApp()).post('/api/image-to-3d/targets/fakegen/install?repair=1');
    expect(sseFrames(res.text).at(-1)).toMatchObject({ type: 'complete' });
    expect(fakeInstall).toHaveBeenLastCalledWith(expect.objectContaining({ env }));
  });

  it('ends the stream when the install environment cannot be prepared', async () => {
    fakeInstall.mockClear();
    const resolveEnv = vi.fn().mockRejectedValue(new Error('bad settings'));
    getTargetAdapter.mockReturnValueOnce({ ...fakeAdapter, resolveEnv });
    const res = await request(makeApp()).post('/api/image-to-3d/targets/fakegen/install');
    expect(sseFrames(res.text).at(-1)).toMatchObject({
      type: 'error', message: expect.stringMatching(/Could not prepare.*bad settings/),
    });
    expect(fakeInstall).not.toHaveBeenCalled();
  });

  it('refuses installation on an unsupported host before dispatch', async () => {
    fakeInstall.mockClear();
    unavailableReason.mockReturnValueOnce('requires-apple-silicon');
    const res = await request(makeApp()).post('/api/image-to-3d/targets/fakegen/install');
    expect(sseFrames(res.text).at(-1)).toMatchObject({
      type: 'error', message: expect.stringContaining('Requires an Apple Silicon Mac'),
    });
    expect(fakeInstall).not.toHaveBeenCalled();
  });

  it.each([false, true])('offers a resume hint only for a transient failure (%s)', async (transient) => {
    fakeInstall.mockReturnValueOnce({
      promise: Promise.reject(Object.assign(new Error('setup failed'), { stage: 'setup', transient })),
      kill: vi.fn(),
    });
    const res = await request(makeApp()).post('/api/image-to-3d/targets/fakegen/install');
    const frame = sseFrames(res.text).at(-1);
    expect(frame).toMatchObject({ type: 'error', stage: 'setup' });
    expect(frame.message.includes('click Install again to resume')).toBe(transient);
  });

  it('errors on install for a target id with no registered adapter', async () => {
    const res = await request(makeApp()).post('/api/image-to-3d/targets/nope/install');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringMatching(/Unknown/),
      code: 'IMAGE_TO_3D_TARGET_NOT_INSTALLABLE',
      timestamp: expect.any(Number),
    });
  });
});
