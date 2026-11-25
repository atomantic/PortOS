import { beforeEach, describe, expect, it, vi } from 'vitest';

const probeOpenAiModels = vi.fn();
vi.mock('../lib/openAiModelsProbe.js', () => ({ probeOpenAiModels: (...args) => probeOpenAiModels(...args) }));
vi.mock('./provider/providers.js', () => ({ listProviders: vi.fn(async () => []) }));
vi.mock('./llamaServerManager.js', () => ({ getLlamaServerEndpoint: vi.fn(async () => 'http://127.0.0.1:9100/v1') }));
const getMtplxServerStatus = vi.fn(async () => ({ cachedModels: ['cached'] }));
vi.mock('./mtplxServerManager.js', () => ({
  getMtplxServerEndpoint: vi.fn(async () => null),
  getMtplxServerStatus: (...args) => getMtplxServerStatus(...args),
}));
vi.mock('./slotstreamServerManager.js', () => ({ getSlotstreamServerEndpoint: vi.fn(async () => null) }));
vi.mock('./specDecodeModels.js', () => ({ getSpecDecodePresetStatus: vi.fn(async () => []) }));
vi.mock('./localLlm.js', () => ({ listManagedBackendModels: vi.fn() }));

import { listEndpointRuntimeModels } from './localRuntimeEndpoints.js';
import { ASSESSABLE_RUNTIMES, isEndpointRuntime } from '../lib/localProviderRuntime.js';

describe('listEndpointRuntimeModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(() => { throw new Error('the listing must only use the model probe'); });
  });

  it('returns one labelled row per endpoint runtime, leaves the managed pair out, and only probes model lists', async () => {
    probeOpenAiModels.mockImplementation(async (endpoint) => (endpoint.includes(':9100')
      ? { reachable: true, models: ['dflash'], error: null }
      : { reachable: false, models: null, error: 'connection refused' }));

    const rows = await listEndpointRuntimeModels();

    expect(rows.map((r) => r.id)).toEqual(ASSESSABLE_RUNTIMES.filter(isEndpointRuntime));
    expect(rows.some((r) => r.id === 'ollama' || r.id === 'lmstudio')).toBe(false);
    const llama = rows.find((r) => r.id === 'llama');
    expect(llama).toMatchObject({ label: 'llama.cpp', models: [{ id: 'dflash' }], offline: false, error: null });
    const mtplx = rows.find((r) => r.id === 'mtplx');
    expect(mtplx).toMatchObject({ models: [], offline: true });
    expect(mtplx.error).toMatch(/not reachable/);
    expect(probeOpenAiModels).toHaveBeenCalledTimes(rows.length);
    expect(global.fetch).not.toHaveBeenCalled();
    // A stopped runtime never pays for the slow disk/status fallback.
    expect(getMtplxServerStatus).not.toHaveBeenCalled();
  });

  it('reports a failing listing as an offline row instead of throwing', async () => {
    probeOpenAiModels.mockRejectedValue(new Error('probe exploded'));
    const rows = await listEndpointRuntimeModels();
    expect(rows.every((r) => r.offline && r.models.length === 0 && r.error === 'probe exploded')).toBe(true);
  });
});
