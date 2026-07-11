/**
 * Pure-logic tests for the exposure scan engine (issue #2144): search-vector
 * derivation (excludes non-scan types), URL fill, and verdict classification.
 * No network/DB — recordScanVerdict is mocked so scanBroker's classify→record
 * wiring is exercised without Postgres.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./privacyBrokers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordScanVerdict: vi.fn(async (brokerId, verdict, opts) => ({ id: 'case-1', brokerId, state: verdict, ...opts })) };
});
vi.mock('./catalogIngestSources.js', () => ({ fetchUrlMainText: vi.fn(async () => null) }));
vi.mock('./privacyVault.js', () => ({ listScanEligibleValues: vi.fn(async () => []) }));

const {
  parseCityState, buildSearchVectors, fillSearchUrl, classifyScanResult, scanBroker,
} = await import('./privacyScan.js');
const brokers = await import('./privacyBrokers.js');

describe('parseCityState', () => {
  it('parses the full street form', () => {
    expect(parseCityState('123 Main St, Portland, OR 97201')).toEqual({ city: 'Portland', state: 'OR' });
  });
  it('parses a bare city, state', () => {
    expect(parseCityState('Salem, OR')).toEqual({ city: 'Salem', state: 'OR' });
  });
  it('returns nulls when no state token', () => {
    expect(parseCityState('somewhere unknown')).toEqual({ city: null, state: null });
  });
});

describe('buildSearchVectors — excludes non-scan types', () => {
  it('groups name/email/phone/address and IGNORES ssn/passport/etc.', () => {
    const v = buildSearchVectors([
      { type: 'legal_name', value: 'Jane Q Doe' },
      { type: 'email', value: 'jane@example.com' },
      { type: 'phone', value: '+1 503 555 0100' },
      { type: 'address', value: '1 Oak Ave, Portland, OR 97201', status: 'current' },
      { type: 'address', value: '9 Old Rd, Salem, OR 97301', status: 'previous' },
      // These must never appear in the vectors even if handed in:
      { type: 'ssn', value: '123-45-6789' },
      { type: 'passport', value: 'P123' },
      { type: 'financial_account', value: 'acct-9' },
    ]);
    expect(v.names).toEqual([{ full: 'Jane Q Doe', firstName: 'Jane', lastName: 'Doe' }]);
    expect(v.emails).toEqual(['jane@example.com']);
    expect(v.phones).toEqual(['+1 503 555 0100']);
    expect(v.locations).toEqual([
      { city: 'Portland', state: 'OR', status: 'current' },
      { city: 'Salem', state: 'OR', status: 'previous' },
    ]);
    // No ssn/passport/financial value leaked anywhere.
    expect(JSON.stringify(v)).not.toContain('123-45-6789');
    expect(JSON.stringify(v)).not.toContain('P123');
  });
});

describe('fillSearchUrl', () => {
  it('fills name + location tokens URL-encoded', () => {
    const url = fillSearchUrl('https://b.example/{firstName}-{lastName}/{state}', {
      name: { firstName: 'Jane', lastName: 'Doe' }, location: { state: 'OR' },
    });
    expect(url).toBe('https://b.example/Jane-Doe/OR');
  });
  it('returns null with no name', () => {
    expect(fillSearchUrl('https://b.example/{firstName}', { name: { firstName: '', lastName: '' } })).toBe(null);
  });
});

describe('classifyScanResult', () => {
  const vectors = { names: [{ full: 'Jane Q Doe' }], locations: [{ city: 'Portland', state: 'OR' }] };

  it('404 is INCONCLUSIVE (no verdict)', () => {
    const r = classifyScanResult({ status: 404, html: 'nope', vectors });
    expect(r.verdict).toBe(null);
    expect(r.inconclusive).toBe(true);
  });
  it('antibot wall → blocked (never bypassed)', () => {
    const r = classifyScanResult({ status: 200, html: 'Please complete the reCAPTCHA', vectors });
    expect(r.verdict).toBe('blocked');
  });
  it('403 → blocked', () => {
    expect(classifyScanResult({ status: 403, html: '', vectors }).verdict).toBe('blocked');
  });
  it('name + location → found', () => {
    const r = classifyScanResult({ status: 200, html: 'Results for Jane Q Doe of Portland OR', vectors });
    expect(r.verdict).toBe('found');
    expect(r.found).toBe(true);
    expect(r.evidence.match_basis).toBe('name+location');
  });
  it('name only → indirect_exposure', () => {
    const r = classifyScanResult({ status: 200, html: 'A page mentioning Jane Q Doe somewhere', vectors });
    expect(r.verdict).toBe('indirect_exposure');
  });
  it('no match → not_found', () => {
    const r = classifyScanResult({ status: 200, html: 'Nobody here by that description', vectors });
    expect(r.verdict).toBe('not_found');
  });
  it('a bare CDN mention of "cloudflare" on a real result page is NOT a wall', () => {
    const r = classifyScanResult({
      status: 200,
      html: '<script src="https://cdnjs.cloudflare.com/x.js"></script> Results for Jane Q Doe of Portland OR',
      vectors,
    });
    expect(r.verdict).toBe('found');
  });
  it('a Cloudflare interstitial ("Just a moment...") → blocked', () => {
    const r = classifyScanResult({ status: 200, html: '<title>Just a moment...</title>', vectors });
    expect(r.verdict).toBe('blocked');
  });
});

describe('scanBroker — classify → record wiring', () => {
  const vectors = { names: [{ full: 'Jane Q Doe', firstName: 'Jane', lastName: 'Doe' }], locations: [{ city: 'Portland', state: 'OR' }] };
  const broker = { id: 'spokeo', urls: { search: 'https://b.example/{firstName}-{lastName}/{state}' } };

  it('records a found verdict from the HTTP lane', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => 'Found: Jane Q Doe in Portland, OR — full profile' }));
    const kase = await brokers.recordScanVerdict;
    kase.mockClear();
    const res = await scanBroker(broker, vectors, { fetchImpl, urlSafe: async () => true });
    expect(brokers.recordScanVerdict).toHaveBeenCalledWith('spokeo', 'found', expect.objectContaining({ found: true }));
    expect(res.state).toBe('found');
  });

  it('skips a broker with no search URL (blind-scan not possible here)', async () => {
    brokers.recordScanVerdict.mockClear();
    const res = await scanBroker({ id: 'x', urls: {} }, vectors, { urlSafe: async () => true });
    expect(res).toEqual({ skipped: true, reason: 'no_search_url' });
    expect(brokers.recordScanVerdict).not.toHaveBeenCalled();
  });

  it('does NOT record on a 404 (inconclusive → stays unscanned)', async () => {
    brokers.recordScanVerdict.mockClear();
    const fetchImpl = vi.fn(async () => ({ status: 404, text: async () => 'not found' }));
    const res = await scanBroker(broker, vectors, { fetchImpl, urlSafe: async () => true });
    expect(res.skipped).toBe(true);
    expect(brokers.recordScanVerdict).not.toHaveBeenCalled();
  });

  it('skips when the URL is unsafe (SSRF guard)', async () => {
    const res = await scanBroker(broker, vectors, { urlSafe: async () => false });
    expect(res).toEqual({ skipped: true, reason: 'unsafe_or_unfillable_url' });
  });

  it('escalates a 403 wall to the browser lane and records its verdict', async () => {
    brokers.recordScanVerdict.mockClear();
    const fetchImpl = vi.fn(async () => ({ status: 403, text: async () => 'Access denied' }));
    // Substantive real-Chrome page (long enough to not look like a JS shell).
    const page = `Results for Jane Q Doe in Portland, OR — full profile. ${'x'.repeat(700)}`;
    const browserFetch = vi.fn(async () => ({ text: page }));
    const res = await scanBroker(broker, vectors, { fetchImpl, browserFetch, urlSafe: async () => true });
    expect(browserFetch).toHaveBeenCalledWith('https://b.example/Jane-Doe/OR');
    expect(res.state).toBe('found');
  });

  it('records blocked (with the search URL as evidence) when the browser lane also walls', async () => {
    brokers.recordScanVerdict.mockClear();
    const fetchImpl = vi.fn(async () => ({ status: 403, text: async () => 'Access denied' }));
    const browserFetch = vi.fn(async () => null);
    const res = await scanBroker(broker, vectors, { fetchImpl, browserFetch, urlSafe: async () => true });
    expect(res.state).toBe('blocked');
    expect(brokers.recordScanVerdict).toHaveBeenCalledWith('spokeo', 'blocked', expect.objectContaining({
      evidence: expect.objectContaining({ match_basis: 'antibot_wall', search_url: 'https://b.example/Jane-Doe/OR' }),
    }));
  });

  it('does NOT adopt a shell-length browser page on a wall (stays blocked, not not_found)', async () => {
    brokers.recordScanVerdict.mockClear();
    const fetchImpl = vi.fn(async () => ({ status: 403, text: async () => 'Access denied' }));
    const browserFetch = vi.fn(async () => ({ text: 'Just a moment' }));
    const res = await scanBroker(broker, vectors, { fetchImpl, browserFetch, urlSafe: async () => true });
    expect(res.state).toBe('blocked');
  });
});
