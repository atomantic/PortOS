import { beforeEach, describe, expect, it, vi } from 'vitest';

const providers = vi.hoisted(() => ({ listProviders: vi.fn(), refreshProviderModelsBatch: vi.fn() }));
vi.mock('./provider/providers.js', () => providers);

import { syncRuntimeProviderModels } from './localRuntimeProviderSync.js';

const mtplxApi = (id, extra = {}) => ({ id, type: 'api', name: id, enabled: true, endpoint: 'http://127.0.0.1:8000/v1', models: [], ...extra });
const mtplxOpencode = (id, baseURL, extra = {}) => ({
  id, type: 'tui', name: id, enabled: true, command: 'opencode', mtplxBacked: true,
  envVars: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { mtplx: { options: { baseURL } } } }) },
  ...extra,
});

describe('syncRuntimeProviderModels', () => {
  let io;
  beforeEach(() => {
    vi.clearAllMocks();
    io = { emit: vi.fn() };
    providers.listProviders.mockResolvedValue([
      mtplxApi('mtplx'),
      mtplxOpencode('opencode-mtplx-tui', 'http://127.0.0.1:8000/v1'),
      mtplxApi('mtplx-remote', { endpoint: 'http://203.0.113.9:8000/v1' }),
      mtplxApi('mtplx-off', { enabled: false }),
      { id: 'unrelated', type: 'api', name: 'unrelated', enabled: true, endpoint: 'https://api.example.com/v1' },
    ]);
    providers.refreshProviderModelsBatch.mockResolvedValue([{ ids: ['mtplx', 'opencode-mtplx-tui'], leadId: 'mtplx', status: 'updated' }]);
  });

  it('refreshes exactly the enabled, local presets of that runtime in one batch and announces the change', async () => {
    await expect(syncRuntimeProviderModels({ kind: 'mtplx', io })).resolves.toBe(true);

    expect(providers.refreshProviderModelsBatch).toHaveBeenCalledTimes(1);
    expect(providers.refreshProviderModelsBatch).toHaveBeenCalledWith(['mtplx', 'opencode-mtplx-tui']);
    expect(io.emit).toHaveBeenCalledWith('providers:changed');
  });

  it('stays quiet when no group changed, and when nothing fronts the runtime', async () => {
    providers.refreshProviderModelsBatch.mockResolvedValue([{ ids: ['mtplx'], leadId: 'mtplx', status: 'failed', error: new Error('refused') }, { ids: ['x'], leadId: 'x', status: 'missing' }]);
    await expect(syncRuntimeProviderModels({ kind: 'mtplx', io })).resolves.toBe(false);
    expect(io.emit).not.toHaveBeenCalled();

    providers.refreshProviderModelsBatch.mockClear();
    await expect(syncRuntimeProviderModels({ kind: 'slotstream', io })).resolves.toBe(false);
    expect(providers.refreshProviderModelsBatch).not.toHaveBeenCalled();
  });

  it('waits for readiness first; a runtime that never answers leaves the providers untouched without throwing', async () => {
    const waitForReady = vi.fn(async () => ({ ready: false, reason: 'MTPLX exited while loading (PM2 status: errored)' }));

    await expect(syncRuntimeProviderModels({ kind: 'mtplx', io, waitForReady })).resolves.toBe(false);

    expect(waitForReady).toHaveBeenCalledTimes(1);
    expect(providers.listProviders).not.toHaveBeenCalled();
    expect(providers.refreshProviderModelsBatch).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('refreshes once the runtime reports ready', async () => {
    const waitForReady = vi.fn(async () => ({ ready: true }));
    await syncRuntimeProviderModels({ kind: 'mtplx', io, waitForReady });
    expect(providers.refreshProviderModelsBatch).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows a rejected refresh or a failed readiness wait', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    providers.refreshProviderModelsBatch.mockRejectedValueOnce(new Error('disk full'));
    await expect(syncRuntimeProviderModels({ kind: 'mtplx', io })).resolves.toBe(false);
    await expect(syncRuntimeProviderModels({ kind: 'mtplx', io, waitForReady: async () => { throw new Error('pm2 gone'); } })).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('coalesces a start followed by a download into one probe per runtime', async () => {
    let release;
    providers.refreshProviderModelsBatch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = syncRuntimeProviderModels({ kind: 'mtplx', io });
    const second = syncRuntimeProviderModels({ kind: 'mtplx', io });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release([{ ids: ['mtplx'], leadId: 'mtplx', status: 'updated' }]);
    await Promise.all([first, second]);
    expect(providers.refreshProviderModelsBatch).toHaveBeenCalledTimes(1);
  });
});
