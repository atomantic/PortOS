/**
 * Broker-list downloaders: a transport or HTTP failure must reject, never
 * return [] (an empty list means the source answered with no brokers).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/safeUrlFetch.js', () => ({ fetchPublicResponse: vi.fn() }));

const { fetchPublicResponse } = await import('../lib/safeUrlFetch.js');
const { _sourceFetchers } = await import('./privacyBrokers.js');
const { badbool: defaultFetchBadbool, caRegistry: defaultFetchCaRegistry } = _sourceFetchers;

beforeEach(() => vi.clearAllMocks());

describe.each([
  ['BADBOOL', defaultFetchBadbool],
  ['CA registry', defaultFetchCaRegistry],
])('%s downloader', (_name, fetcher) => {
  it('rejects when the network is unreachable', async () => {
    fetchPublicResponse.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(fetcher()).rejects.toThrow('ENOTFOUND');
  });

  it('rejects on a non-200 response', async () => {
    fetchPublicResponse.mockResolvedValue({ ok: false, status: 503 });
    await expect(fetcher()).rejects.toThrow('HTTP 503');
  });

  it('requires a pinned public response and rejects a blocked or failed fetch', async () => {
    fetchPublicResponse.mockResolvedValue(null);
    await expect(fetcher()).rejects.toThrow('Broker feed fetch failed or redirect was blocked');
    expect(fetchPublicResponse).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^https:\/\//), {
      timeoutMs: 15000,
      blockPrivate: true,
      throwOnUnsafe: true,
    });
  });
});

describe('BADBOOL downloader parsing', () => {
  it('returns parsed brokers on success and rejects on an unparseable body', async () => {
    fetchPublicResponse.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: 'alpha', name: 'Alpha Search', url: 'https://alpha.example' }] });
    expect(await defaultFetchBadbool()).toMatchObject([{ id: 'alpha', name: 'Alpha Search' }]);
    fetchPublicResponse.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    await expect(defaultFetchBadbool()).rejects.toThrow('Unexpected token');
  });
});
