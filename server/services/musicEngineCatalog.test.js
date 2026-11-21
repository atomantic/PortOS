import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  healthy: true, platformSupported: true, cuda: {}, inspectCache: vi.fn(),
}));
vi.mock('./pipeline/musicGen.js', async (importOriginal) => ({
  ...await importOriginal(),
  isEngineHealthy: async () => state.healthy,
  isEnginePlatformSupported: () => state.platformSupported,
}));
vi.mock('./audioModels.js', async () => {
  const { ENGINES } = await import('./pipeline/musicGen.js');
  return { listEngineModels: async (id) => ENGINES[id].models };
});
vi.mock('../lib/hfCache.js', () => ({ inspectModelCache: (...args) => state.inspectCache(...args) }));
vi.mock('../lib/cudaCapability.js', () => ({ getCudaCapability: async () => state.cuda }));

const { resolveMusicEngineSelection } = await import('./musicEngineCatalog.js');
const { ENGINES } = await import('./pipeline/musicGen.js');

beforeEach(() => {
  state.healthy = true;
  state.platformSupported = true;
  state.cuda = { status: 'available', maxVramGb: 24 };
  state.inspectCache.mockReset().mockResolvedValue({ cached: true });
});

describe('commission music engine selection', () => {
  it('resolves omitted values to the healthy portable defaults without a CUDA device', async () => {
    state.cuda = { status: 'unavailable' };
    const model = ENGINES.musicgen.models.find(({ id }) => id === ENGINES.musicgen.defaultModelId);
    await expect(resolveMusicEngineSelection()).resolves.toEqual({
      status: 'ready',
      selection: { engine: 'musicgen', modelId: model.id, repo: model.repo },
    });
  });

  it('fails closed for a removed model or unavailable runtime', async () => {
    await expect(resolveMusicEngineSelection({ modelId: 'removed' })).resolves.toEqual({
      status: 'unavailable', reason: 'music-model-unavailable',
    });
    state.healthy = false;
    await expect(resolveMusicEngineSelection()).resolves.toEqual({
      status: 'unavailable', reason: 'music-engine-unavailable',
    });
  });

  it('fails closed on an unsupported platform even if a stale runtime looks healthy', async () => {
    state.platformSupported = false;
    await expect(resolveMusicEngineSelection()).resolves.toEqual({
      status: 'unavailable', reason: 'music-engine-unavailable',
    });
  });

  it.each([12, null])('rejects the cached CUDA engine with %s GB of reported VRAM', async (maxVramGb) => {
    state.cuda = { status: 'available', maxVramGb };
    await expect(resolveMusicEngineSelection({ engineId: 'minimax-music3' })).resolves.toEqual({
      status: 'unavailable', reason: 'music-engine-unavailable',
    });
  });

  it('requires the selected pinned checkpoint even when the default weights are cached', async () => {
    const engineId = 'minimax-music3-mlx';
    const [cachedModel, unavailableModel] = ENGINES[engineId].models;
    state.inspectCache.mockImplementation(async (repo, { revision }) => ({
      cached: repo !== unavailableModel.repo || revision !== unavailableModel.revision,
    }));
    await expect(resolveMusicEngineSelection({ engineId })).resolves.toMatchObject({
      status: 'ready', selection: { engine: engineId, modelId: cachedModel.id },
    });
    await expect(resolveMusicEngineSelection({ engineId, modelId: unavailableModel.id })).resolves.toEqual({
      status: 'unavailable', reason: 'music-model-unavailable',
    });
    expect(state.inspectCache).toHaveBeenCalledWith(unavailableModel.repo, { revision: unavailableModel.revision });
  });
});
