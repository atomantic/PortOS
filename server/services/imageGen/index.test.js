import { describe, expect, it, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => ({ value: {} }));
const models = vi.hoisted(() => ({ value: [] }));

vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => settings.value) }));
const localMock = vi.hoisted(() => ({ activeJob: null, cancel: vi.fn(() => true) }));
vi.mock('./local.js', () => ({
  getActiveJob: () => localMock.activeJob,
  attachSseClient: () => false,
  cancel: localMock.cancel,
}));
// The model registry moved behind the shared diagnosis in localRuntime.js, which
// reads it from the lib leaf rather than through the renderer.
vi.mock('../../lib/mediaModels.js', () => ({ getImageModels: vi.fn(() => models.value) }));
vi.mock('./external.js', () => ({ checkConnection: vi.fn(), getActiveJob: () => null }));
const codexMock = vi.hoisted(() => ({ cancel: vi.fn(() => false), cancelAll: vi.fn(() => false) }));
vi.mock('./codex.js', () => ({ checkConnection: vi.fn(), getActiveJob: () => null, cancel: codexMock.cancel, cancelAll: codexMock.cancelAll }));
const grokMock = vi.hoisted(() => ({ cancel: vi.fn(() => false), cancelAll: vi.fn(() => false) }));
vi.mock('./grok.js', () => ({ checkConnection: vi.fn(), getActiveJob: () => null, cancel: grokMock.cancel, cancelAll: grokMock.cancelAll }));
const agyMock = vi.hoisted(() => ({ cancel: vi.fn(() => false), cancelAll: vi.fn(() => false) }));
vi.mock('./agy.js', () => ({ checkConnection: vi.fn(), getActiveJob: () => null, cancel: agyMock.cancel, cancelAll: agyMock.cancelAll }));
const falMock = vi.hoisted(() => ({ cancel: vi.fn(() => false), cancelAll: vi.fn(() => false) }));
vi.mock('./fal.js', async (importOriginal) => ({ ...(await importOriginal()), cancel: falMock.cancel, cancelAll: falMock.cancelAll }));
vi.mock('./setup.js', () => ({ getSetupCheck: vi.fn() }));
vi.mock('../../lib/pythonSetup.js', () => ({ isFlux2VenvHealthy: vi.fn(), FLUX2_VENV_DEFAULT: '/test/venv-flux2/bin/python3' }));

import { checkConnection, cancelJob } from './index.js';
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
  localMock.activeJob = null;
  localMock.cancel.mockReturnValue(true);
  for (const m of [codexMock, grokMock, agyMock, falMock]) m.cancel.mockReset().mockReturnValue(false);
  models.value = [mfluxModel];
  settings.value = { imageGen: { mode: 'local', local: { modelId: 'dev', pythonPath: '/test/python3' } } };
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
      reason: expect.stringContaining('shared torch image runtime is not installed or healthy'),
      remedy: { kind: 'install-torch-venv', label: 'Install runtime', venvPath: '/test/venv-flux2/bin/python3' },
    });
  });
});

// Exact-ID cancel (#9932): signals only the owning backend; never a bulk method.
describe('cancelJob exact-ID dispatch', () => {
  const bulk = () => [localMock.cancel, codexMock.cancelAll, grokMock.cancelAll, agyMock.cancelAll, falMock.cancelAll];

  it('refuses an empty id without touching any backend', () => {
    expect(cancelJob('')).toBe(false);
    expect(localMock.cancel).not.toHaveBeenCalled();
    expect(codexMock.cancel).not.toHaveBeenCalled();
  });

  it('signals local only when its active job IS the requested id', () => {
    localMock.activeJob = { id: 'local-b', generationId: 'local-b' };
    expect(cancelJob('local-a')).toBe(false);
    expect(localMock.cancel).not.toHaveBeenCalled();
    expect(cancelJob('local-b')).toBe(true);
    expect(localMock.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['codex', codexMock],
    ['grok', grokMock],
    ['agy', agyMock],
    ['fal', falMock],
  ])('routes an exact %s id to that backend only, leaving the others and bulk cancels alone', (_name, owner) => {
    owner.cancel.mockImplementation((id) => id === 'job-1');
    localMock.activeJob = { id: 'local-b', generationId: 'local-b' };
    expect(cancelJob('job-1')).toBe(true);
    expect(owner.cancel).toHaveBeenCalledWith('job-1');
    expect(localMock.cancel).not.toHaveBeenCalled();
    for (const fn of bulk()) expect(fn).not.toHaveBeenCalled();
  });

  it('returns false for an id no backend owns', () => {
    expect(cancelJob('gone')).toBe(false);
    for (const fn of bulk()) expect(fn).not.toHaveBeenCalled();
  });
});
