/**
 * The default HTTP lane must not follow a broker redirect into loopback/LAN.
 * Exercises the real safeUrlFetch guard with only DNS and the socket mocked.
 */
import { describe, it, expect, vi } from 'vitest';

const lookupMock = vi.fn(async () => ({ address: '93.184.216.34', family: 4 }));
vi.mock('dns/promises', () => ({
  default: { lookup: (...a) => lookupMock(...a) },
  lookup: (...a) => lookupMock(...a),
}));
const fetchMock = vi.fn();
vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: (...a) => fetchMock(...a) }));
vi.mock('./catalogIngestSources.js', () => ({ fetchUrlMainText: vi.fn(async () => null) }));
vi.mock('./privacyVault.js', () => ({ listScanEligibleValues: vi.fn(async () => []) }));
vi.mock('./privacyBrokers.js', () => ({ listBrokers: vi.fn(), listBrokerCases: vi.fn(), recordScanVerdict: vi.fn() }));
vi.mock('./privacySubjects.js', () => ({ resolveSubjectId: (id) => id, assertSubjectConsent: vi.fn() }));

const { probeBroker } = await import('./privacyScan.js');

const broker = { id: 'b1', urls: { search: 'https://broker.example.com/{first}-{last}' } };
const vectors = { names: [{ full: 'Jane Doe', firstName: 'Jane', lastName: 'Doe' }], locations: [] };
const redirectTo = (location) => ({ status: 302, ok: false, headers: new Map([['location', location]]), text: async () => '' });

describe('probeBroker default HTTP lane', () => {
  it.each(['http://127.0.0.1:5555/api/x', 'http://169.254.169.254/x', 'http://192.168.1.10/x'])(
    'does not follow a redirect to %s',
    async (target) => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(redirectTo(target));
      const res = await probeBroker(broker, vectors, { browserFetch: vi.fn(async () => null) });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res).toEqual({ skipped: true, reason: 'fetch_failed' });
    },
  );

  it('keeps the status contract: a 404 stays inconclusive', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({ status: 404, ok: false, headers: new Map(), text: async () => 'nope' });
    const res = await probeBroker(broker, vectors, { browserFetch: vi.fn(async () => null) });
    expect(res).toMatchObject({ skipped: true, verdict: null });
    expect(res.reason).not.toBe('fetch_failed');
  });
});
