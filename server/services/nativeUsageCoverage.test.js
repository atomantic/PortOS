import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./codexAppServer.js', () => ({ getCodexAccountUsage: vi.fn() }));
vi.mock('./nativeTranscriptCoverage.js', () => ({ getNativeTranscriptCoverage: vi.fn() }));
vi.mock('./providers.js', () => ({ getAllProviders: vi.fn() }));
vi.mock('./usage.js', async importOriginal => ({ ...(await importOriginal()), getUsage: vi.fn() }));
import { getCodexAccountUsage } from './codexAppServer.js';
import { getAllProviders } from './providers.js';
import { getUsage } from './usage.js';
import { getNativeTranscriptCoverage } from './nativeTranscriptCoverage.js';
import { getNativeUsageCoverage } from './nativeUsageCoverage.js';

const ledger = {
  dailyActivity: { '2026-02-01': { byProvider: {
    codex: { tokensIn: 10, tokensOut: 5, cacheReadTokens: 2, source: 'mixed',
      byModel: { example: { tokensIn: 10, tokensOut: 5, cacheReadTokens: 2, source: 'mixed' } } },
  } } }, monthlyActivity: {}, lastUpdated: '2026-02-02T00:00:00Z',
};
beforeEach(() => {
  vi.clearAllMocks();
  getUsage.mockReturnValue(structuredClone(ledger));
  getAllProviders.mockResolvedValue({ providers: [{ id: 'codex', type: 'cli', command: 'codex' }] });
  getCodexAccountUsage.mockResolvedValue({ summary: { lifetimeTokens: 100 },
    dailyUsageBuckets: [{ startDate: '2026-02-01', tokens: 100 }], fetchedAt: '2026-02-02T01:00:00Z' });
});
describe('native usage coverage report', () => {
  it('keeps native account history authoritative but separate from an unchanged local diagnostic ledger', async () => {
    const result = await getNativeUsageCoverage();
    const codex = result.providers.find(row => row.family === 'codex');
    expect(codex.native).toMatchObject({ status: 'available', summary: { lifetimeTokens: 100 },
      scope: 'currently-signed-in-account', accountIdentity: null, aggregation: 'do-not-sum-across-instances',
      latestReportedDay: '2026-02-01', completeness: 'unknown', bucketTimezone: null, cost: { usd: null, kind: 'unknown' } });
    expect(codex.legacy).toMatchObject({ tokens: 17, scope: 'this-instance', provenance: ['mixed'] });
    expect(codex.comparison).toMatchObject({ comparable: false, tokenDelta: null });
    expect(getUsage()).toEqual(ledger);
    expect(result.providers.filter(row => row.family !== 'codex').every(row => row.native.status === 'not-scanned')).toBe(true);
    expect(getCodexAccountUsage).toHaveBeenCalledTimes(1);
  });
  it('keeps unknown history and unavailable reads distinct from zero, and never exposes raw failures', async () => {
    getCodexAccountUsage.mockResolvedValueOnce({ summary: { lifetimeTokens: null }, dailyUsageBuckets: null, fetchedAt: '2026-02-02T01:00:00Z' });
    const unknown = (await getNativeUsageCoverage()).providers.find(row => row.family === 'codex');
    expect(unknown.native).toMatchObject({ status: 'available', summary: { lifetimeTokens: null }, dailyUsageBuckets: null, latestReportedDay: null });
    getCodexAccountUsage.mockRejectedValueOnce(new Error('private upstream details'));
    const failed = await getNativeUsageCoverage();
    expect(failed.providers.find(row => row.family === 'codex').native).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(failed)).not.toContain('private upstream details');
    expect(getUsage()).toEqual(ledger);
  });
});

it('scans only the explicitly selected native source without refreshing Codex or changing the ledger', async () => {
  getNativeTranscriptCoverage.mockResolvedValue({ status: 'partial', summary: null });
  const report = await getNativeUsageCoverage({ family: 'grok' });
  expect(getNativeTranscriptCoverage).toHaveBeenCalledExactlyOnceWith('grok');
  expect(getCodexAccountUsage).not.toHaveBeenCalled();
  expect(report.providers.find(row => row.family === 'codex').native.status).toBe('not-scanned');
  expect(getUsage()).toEqual(ledger);
  await getNativeUsageCoverage({ family: 'codex' });
  expect(getCodexAccountUsage).toHaveBeenCalledTimes(1);
  expect(getNativeTranscriptCoverage).toHaveBeenCalledTimes(1);
});
