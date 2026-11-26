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
const installed = vi.hoisted(() => ({
  readInstalledSplashVersion: vi.fn(),
  readMkserveInstall: vi.fn(),
  listSlotstreamCachedModels: vi.fn(),
}));
vi.mock('./splashManagedRuntime.js', () => ({ readInstalledSplashVersion: installed.readInstalledSplashVersion }));
vi.mock('./mkserveRuntimeInstall.js', async (importOriginal) => ({
  ...await importOriginal(), readMkserveInstall: installed.readMkserveInstall,
}));
vi.mock('../lib/slotstreamModels.js', () => ({ listSlotstreamCachedModels: installed.listSlotstreamCachedModels }));
vi.mock('./specDecodeModels.js', () => ({ getSpecDecodePresetStatus: vi.fn(async () => []) }));
vi.mock('./localLlm.js', () => ({ listManagedBackendModels: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));
import { getSettings } from './settings.js';
import { listManagedBackendModels } from './localLlm.js';

import { listEndpointRuntimeModels, listRuntimeModels } from './localRuntimeEndpoints.js';
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

describe('model-list availability', () => {
  it('skips a disabled managed runtime without querying its daemon', async () => {
    getSettings.mockResolvedValue({ localLlm: { lmstudio: { disabled: true } } });
    listManagedBackendModels.mockClear();
    expect(await listRuntimeModels('lmstudio', { respectDisabled: true })).toEqual({ models: null, error: null, offline: true, inactive: true });
    expect(listManagedBackendModels).not.toHaveBeenCalled();
  });

  it('marks a stopped managed runtime inactive without suppressing HTTP listing failures', async () => {
    listManagedBackendModels.mockResolvedValueOnce({ models: [], error: 'fetch failed: ECONNREFUSED' });
    expect(await listRuntimeModels('ollama')).toMatchObject({ inactive: true, offline: true });
    listManagedBackendModels.mockResolvedValueOnce({ models: [], error: 'LM Studio API error: 401' });
    expect(await listRuntimeModels('lmstudio')).toEqual({ models: [], error: 'LM Studio API error: 401' });
  });

  it.each([
    [false, 'ECONNREFUSED', true],
    [false, 'timed out', false],
    [false, 'HTTP 500', false],
    [true, 'authentication required', false],
    [true, 'model listing was not readable', false],
  ])('distinguishes inactive runtimes from failures (reachable: %s, %s)', async (reachable, error, inactive) => {
    probeOpenAiModels.mockResolvedValue({ reachable, models: null, error });
    const result = await listRuntimeModels('llama');
    expect(Boolean(result.inactive)).toBe(inactive);
    expect(result.error).toContain(error);
  });
});

describe('durable models for stopped runtimes', () => {
  beforeEach(() => { probeOpenAiModels.mockResolvedValue({ reachable: false, models: null, error: 'ECONNREFUSED' }); });

  it.each([
    ['splash', installed.readInstalledSplashVersion, '1.7.2', 'inkling2-mini'],
    ['mkserve', installed.readMkserveInstall, { version: 'pinned' }, 'thinkingmachines/Inkling-2-Mini'],
    ['slotstream', installed.listSlotstreamCachedModels, { models: [{ id: 'example/checkpoint' }] }, 'example/checkpoint'],
  ])('shows installed %s models as offline and skips the fallback for live-only consumers', async (kind, readInstall, installation, id) => {
    readInstall.mockReset().mockResolvedValue(installation);
    expect(await listRuntimeModels(kind, { durable: false })).toMatchObject({ models: null, offline: true });
    expect(readInstall).not.toHaveBeenCalled();
    expect(await listRuntimeModels(kind)).toMatchObject({ models: [{ id }], offline: true });
  });

  it.each([
    ['splash', installed.readInstalledSplashVersion, null],
    ['mkserve', installed.readMkserveInstall, null],
    ['slotstream', installed.listSlotstreamCachedModels, { models: null }],
  ])('keeps an unavailable %s install or cache out of the offline catalog', async (kind, readInstall, installation) => {
    readInstall.mockResolvedValue(installation);
    expect(await listRuntimeModels(kind)).toMatchObject({ models: null, inactive: true });
  });
});
