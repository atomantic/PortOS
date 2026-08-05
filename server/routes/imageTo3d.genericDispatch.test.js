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

vi.mock('../services/imageTo3d/adapters.js', () => ({
  getTargetAdapter: vi.fn((id) => (id === 'fakegen' ? {
    isInstalled: fakeIsInstalled,
    install: fakeInstall,
    run: vi.fn(),
    describeInstallState: fakeDescribeInstallState,
  } : null)),
}));

vi.mock('../lib/hfToken.js', () => ({ hfChildEnv: vi.fn(async () => ({})) }));

vi.mock('../services/imageTo3d/models.js', () => ({
  listModels: vi.fn(),
  getModel: vi.fn(),
  createModel: vi.fn(),
  startGeneration: vi.fn(),
  deleteModel: vi.fn(),
  getModelAsset: vi.fn(),
}));

import { hfChildEnv } from '../lib/hfToken.js';
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

  it('GET /targets/:targetId/install dispatches to the registered adapter', async () => {
    const res = await request(makeApp()).get('/api/image-to-3d/targets/fakegen/install');
    const frames = sseFrames(res.text);
    expect(frames).toContainEqual({ type: 'stage', stage: 'fake-step', message: 'installing FakeGen…' });
    expect(frames.at(-1)).toMatchObject({ type: 'complete' });
    expect(fakeInstall).toHaveBeenCalled();
  });

  // #3080: env/credential resolution is adapter-owned (`resolveEnv`), not a
  // dispatch-layer assumption that every target wants a Hugging Face token —
  // a target that declares no `resolveEnv` must never trigger one.
  it('never resolves the Hugging Face token env for a target with no resolveEnv hook', async () => {
    await request(makeApp()).get('/api/image-to-3d/targets/fakegen/install');
    expect(hfChildEnv).not.toHaveBeenCalled();
    expect(fakeInstall).toHaveBeenCalledWith(expect.objectContaining({ env: undefined }));
  });

  it('errors on install for a target id with no registered adapter', async () => {
    const res = await request(makeApp()).get('/api/image-to-3d/targets/nope/install');
    const frames = sseFrames(res.text);
    expect(frames.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/Unknown/) });
  });
});
