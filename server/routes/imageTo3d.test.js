import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Mock the services so the route test is deterministic regardless of the test
// host's real arch/memory and never touches a real subprocess.
vi.mock('../services/imageTo3d/targets.js', () => ({
  detectHostCapabilities: vi.fn(() => ({ appleSilicon: true, unifiedMemoryGb: 128, cuda: false })),
  listTargets: vi.fn((caps) => [
    {
      id: 'trellis2',
      label: 'TRELLIS.2',
      executionLane: 'local-mps',
      outputKind: 'glb-mesh',
      available: caps.appleSilicon && caps.unifiedMemoryGb >= 24,
      unavailableReason: null,
    },
  ]),
  isTargetAvailable: vi.fn(() => true),
  unavailableReason: vi.fn(() => 'requires-apple-silicon'),
}));

vi.mock('../services/imageTo3d/trellis2.js', () => ({
  isTrellis2Installed: vi.fn(() => false),
  trellis2Root: vi.fn(() => '/tmp/trellis2'),
  installTrellis2: vi.fn(({ onEvent }) => {
    onEvent({ type: 'stage', stage: 'clone', message: 'git clone …' });
    onEvent({ type: 'complete', message: 'TRELLIS.2 installed.' });
    return { promise: Promise.resolve({ ok: true }), kill: vi.fn() };
  }),
}));

import * as targets from '../services/imageTo3d/targets.js';
import * as trellis2 from '../services/imageTo3d/trellis2.js';
import routes from './imageTo3d.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/image-to-3d', routes);
  app.use(errorMiddleware);
  return app;
};

// Parse `data: {json}\n\n` SSE frames out of a buffered response body.
const sseFrames = (text) => text
  .split('\n')
  .filter((l) => l.startsWith('data: '))
  .map((l) => JSON.parse(l.slice(6)));

describe('image-to-3d routes', () => {
  it('GET /targets returns host capabilities and annotated targets', async () => {
    const res = await request(makeApp()).get('/api/image-to-3d/targets');
    expect(res.status).toBe(200);
    expect(res.body.capabilities).toMatchObject({ appleSilicon: true, unifiedMemoryGb: 128 });
    expect(Array.isArray(res.body.targets)).toBe(true);
    expect(res.body.targets[0]).toMatchObject({ id: 'trellis2', available: true, installed: false });
  });
});

describe('GET /trellis2/install (SSE)', () => {
  it('streams stage → complete on the happy path', async () => {
    trellis2.isTrellis2Installed.mockReturnValueOnce(false);
    targets.isTargetAvailable.mockReturnValueOnce(true);
    const res = await request(makeApp()).get('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames).toContainEqual({ type: 'stage', stage: 'clone', message: 'git clone …' });
    expect(frames.at(-1)).toMatchObject({ type: 'complete' });
    expect(trellis2.installTrellis2).toHaveBeenCalled();
  });

  it('short-circuits with complete when already installed (no install spawned)', async () => {
    trellis2.installTrellis2.mockClear();
    trellis2.isTrellis2Installed.mockReturnValueOnce(true);
    const res = await request(makeApp()).get('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames.at(-1)).toMatchObject({ type: 'complete', message: expect.stringMatching(/already/i) });
    expect(trellis2.installTrellis2).not.toHaveBeenCalled();
  });

  it('appends a resume hint when the install fails with a transient network error', async () => {
    trellis2.isTrellis2Installed.mockReturnValueOnce(false);
    targets.isTargetAvailable.mockReturnValueOnce(true);
    trellis2.installTrellis2.mockImplementationOnce(() => ({
      promise: Promise.reject(Object.assign(
        new Error("TRELLIS.2 install step 'setup' exited 128"),
        { code: 'TRELLIS2_INSTALL_FAILED', stage: 'setup', transient: true },
      )),
      kill: vi.fn(),
    }));
    const res = await request(makeApp()).get('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames.at(-1)).toMatchObject({
      type: 'error',
      stage: 'setup',
      message: expect.stringMatching(/exited 128.*network hiccup — click Install again to resume/is),
    });
  });

  it('does NOT append the resume hint for a non-transient failure', async () => {
    trellis2.isTrellis2Installed.mockReturnValueOnce(false);
    targets.isTargetAvailable.mockReturnValueOnce(true);
    trellis2.installTrellis2.mockImplementationOnce(() => ({
      promise: Promise.reject(Object.assign(
        new Error('TRELLIS.2 install step \'setup\' exited 1'),
        { code: 'TRELLIS2_INSTALL_FAILED', stage: 'setup', transient: false },
      )),
      kill: vi.fn(),
    }));
    const res = await request(makeApp()).get('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/exited 1$/) });
    expect(frames.at(-1).message).not.toMatch(/network hiccup/i);
  });

  it('refuses on unsupported hardware', async () => {
    trellis2.installTrellis2.mockClear();
    trellis2.isTrellis2Installed.mockReturnValueOnce(false);
    targets.isTargetAvailable.mockReturnValueOnce(false);
    targets.unavailableReason.mockReturnValueOnce('requires-apple-silicon');
    const res = await request(makeApp()).get('/api/image-to-3d/trellis2/install');
    const frames = sseFrames(res.text);
    expect(frames.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/requires-apple-silicon/) });
    expect(trellis2.installTrellis2).not.toHaveBeenCalled();
  });
});
