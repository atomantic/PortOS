import { describe, it, expect, vi, afterEach } from 'vitest';
import * as probeModule from './openAiModelsProbe.js';
import { probeOpenAiModelsCached, resetOpenAiModelsProbeCache } from './openAiModelsProbeCache.js';

const listing = () => vi.spyOn(probeModule, 'probeOpenAiModels')
  .mockResolvedValue({ reachable: true, models: [], contextWindows: {}, error: null });

afterEach(() => {
  vi.restoreAllMocks();
  resetOpenAiModelsProbeCache();
});

describe('probeOpenAiModelsCached', () => {
  it('collapses concurrent callers onto one request and re-probes after a reset', async () => {
    // The Providers page poll and a run starting in the same window must cost
    // ONE listing; a daemon relaunched at a different `-c` must cost a fresh
    // one, which is what the lifecycle routes' reset buys.
    const spy = listing();

    await Promise.all([
      probeOpenAiModelsCached('http://127.0.0.1:18020/v1'),
      probeOpenAiModelsCached('http://127.0.0.1:18020/v1'),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);

    resetOpenAiModelsProbeCache();
    await probeOpenAiModelsCached('http://127.0.0.1:18020/v1');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keys on the API key so one provider\'s 401 is not another\'s', async () => {
    const spy = listing();

    await probeOpenAiModelsCached('http://127.0.0.1:18020/v1', 'key-a');
    await probeOpenAiModelsCached('http://127.0.0.1:18020/v1', 'key-b');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not poison the entry for its TTL when the probe throws', async () => {
    // `probeOpenAiModels` resolves for every expected failure, so a throw here
    // is unexpected — and caching the rejection would keep answering with it
    // for 15s after the daemon recovered.
    const spy = vi.spyOn(probeModule, 'probeOpenAiModels')
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue({ reachable: true, models: [], contextWindows: {}, error: null });

    await expect(probeOpenAiModelsCached('http://127.0.0.1:18020/v1')).rejects.toThrow('socket hang up');
    await expect(probeOpenAiModelsCached('http://127.0.0.1:18020/v1')).resolves.toMatchObject({ reachable: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
