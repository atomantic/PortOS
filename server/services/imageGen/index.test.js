import { describe, expect, it, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => ({ value: {} }));
const models = vi.hoisted(() => ({ value: [] }));

vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => settings.value) }));
vi.mock('./local.js', () => ({
  listImageModels: vi.fn(() => models.value),
  getActiveJob: () => null,
  attachSseClient: () => false,
  cancel: () => false,
}));
vi.mock('./external.js', () => ({ checkConnection: vi.fn(), getActiveJob: () => null }));
vi.mock('./codex.js', () => ({ checkConnection: vi.fn(), getActiveJob: () => null, cancelAll: () => false }));
vi.mock('./grok.js', () => ({ checkConnection: vi.fn(), getActiveJob: () => null, cancelAll: () => false }));
vi.mock('./agy.js', () => ({ checkConnection: vi.fn(), getActiveJob: () => null, cancelAll: () => false }));
vi.mock('./setup.js', () => ({ getSetupCheck: vi.fn() }));
vi.mock('../../lib/pythonSetup.js', () => ({ isFlux2VenvHealthy: vi.fn() }));

import { checkConnection } from './index.js';
import { getSetupCheck } from './setup.js';
import { isFlux2VenvHealthy } from '../../lib/pythonSetup.js';

const mfluxModel = {
  id: 'dev',
  name: 'FLUX.1 Dev',
  runner: 'mflux',
  hardwareCompatibility: { state: 'available', reasons: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  models.value = [mfluxModel];
  settings.value = { imageGen: { mode: 'local', local: { pythonPath: '/test/python3' } } };
});

describe('local image connection readiness', () => {
  it('reports ready only after the selected mflux model and interpreter health both pass', async () => {
    getSetupCheck.mockResolvedValue({ missing: [], archMismatch: false });

    await expect(checkConnection()).resolves.toMatchObject({
      connected: true,
      mode: 'local',
      model: 'FLUX.1 Dev',
      modelId: 'dev',
      readiness: 'ready',
    });
    expect(getSetupCheck).toHaveBeenCalledWith('/test/python3');
  });

  it('reports missing interpreter packages as unavailable instead of configured', async () => {
    getSetupCheck.mockResolvedValue({ missing: ['mflux', 'mlx'], archMismatch: false });

    await expect(checkConnection()).resolves.toMatchObject({
      connected: false,
      readiness: 'unavailable',
      reason: 'Missing required packages: mflux, mlx',
    });
  });

  it('reports architecture incompatibility as unavailable', async () => {
    getSetupCheck.mockResolvedValue({ missing: [], archMismatch: true, interpreterArch: 'x86_64', hostArch: 'arm64' });

    await expect(checkConnection()).resolves.toMatchObject({
      connected: false,
      readiness: 'unavailable',
      reason: expect.stringMatching(/architecture x86_64/i),
    });
  });

  it('keeps failed interpreter probes distinct from missing packages', async () => {
    getSetupCheck.mockRejectedValue(new Error('spawn failed'));

    await expect(checkConnection()).resolves.toMatchObject({
      connected: false,
      readiness: 'unknown',
      reason: 'Could not verify the configured Python runtime',
    });
  });

  it('uses the selected model hardware requirements before probing Python', async () => {
    models.value = [{ ...mfluxModel, hardwareCompatibility: { state: 'unavailable', reasons: ['Requires Apple Silicon'] } }];

    await expect(checkConnection()).resolves.toMatchObject({
      connected: false,
      readiness: 'unavailable',
      reason: 'Requires Apple Silicon',
    });
    expect(getSetupCheck).not.toHaveBeenCalled();
  });

  it('checks the dedicated runtime for FLUX.2-family models', async () => {
    models.value = [{ ...mfluxModel, id: 'flux2-klein-4b', name: 'FLUX.2 Klein', runner: 'flux2' }];
    settings.value = { imageGen: { mode: 'local', local: { modelId: 'flux2-klein-4b' } } };
    isFlux2VenvHealthy.mockResolvedValue(true);

    await expect(checkConnection()).resolves.toMatchObject({ connected: true, readiness: 'ready', runner: 'flux2' });
    expect(getSetupCheck).not.toHaveBeenCalled();
  });

  it('uses a per-request local model selection when evaluating readiness', async () => {
    models.value = [
      mfluxModel,
      { ...mfluxModel, id: 'flux2-klein-4b', name: 'FLUX.2 Klein', runner: 'flux2' },
    ];
    isFlux2VenvHealthy.mockResolvedValue(false);

    await expect(checkConnection({ mode: 'local', modelId: 'flux2-klein-4b' })).resolves.toMatchObject({
      connected: false,
      modelId: 'flux2-klein-4b',
      readiness: 'unavailable',
    });
    expect(getSetupCheck).not.toHaveBeenCalled();
  });

  it('reports an unhealthy dedicated runtime as unavailable', async () => {
    models.value = [{ ...mfluxModel, id: 'z-image', runner: 'z-image' }];
    settings.value = { imageGen: { mode: 'local', local: { modelId: 'z-image' } } };
    isFlux2VenvHealthy.mockResolvedValue(false);

    await expect(checkConnection()).resolves.toMatchObject({
      connected: false,
      readiness: 'unavailable',
      reason: 'The FLUX.2 image runtime is not installed or healthy',
    });
  });
});
