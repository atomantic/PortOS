import { buildUsageReport, getUsage } from './usage.js';
import { getAllProviders } from './providers.js';
import { PROVIDER_FAMILIES } from '../lib/providerFamilies.js';

/** Read-only migration evidence. Account history and local run attribution are
 * overlapping, differently scoped views, never additive accounting inputs.
 */
export async function getNativeUsageCoverage() {
  const { getCodexAccountUsage } = await import('./codexAppServer.js');
  const attemptedAt = new Date().toISOString();
  const native = await getCodexAccountUsage().then(history => ({
    status: 'available',
    source: 'codex:account/usage/read',
    scope: 'currently-signed-in-account',
    accountIdentity: null,
    aggregation: 'do-not-sum-across-instances',
    fetchedAt: history.fetchedAt,
    summary: history.summary,
    dailyUsageBuckets: history.dailyUsageBuckets,
    bucketTimezone: null,
    completeness: 'unknown',
    latestReportedDay: history.dailyUsageBuckets?.at(-1)?.startDate ?? null,
    cost: { usd: null, kind: 'unknown' },
  }), () => ({
    status: 'unavailable',
    source: 'codex:account/usage/read',
    attemptedAt,
    reason: 'The installed Codex could not provide valid account history. Existing usage is unchanged.',
  }));
  const configured = await getAllProviders();
  const providers = Array.isArray(configured) ? configured : configured?.providers ?? [];
  const ledger = getUsage();
  const report = buildUsageReport(ledger.dailyActivity, {
    providers, monthlyActivity: ledger.monthlyActivity,
  });
  return {
    mode: 'read-only',
    generatedAt: new Date().toISOString(),
    ledgerChanged: false,
    providers: PROVIDER_FAMILIES.map(({ id: family, label }) => {
      const rows = report.providers.filter(row => row.family === family);
      return {
        family, label,
        native: family === 'codex' ? native : {
          status: 'not-integrated',
          source: 'provider-native-transcripts',
          completeness: 'unknown',
          reason: 'A validated native history projection is not connected yet.',
        },
        legacy: {
          source: 'portos-ledger', scope: 'this-instance',
          observedAt: ledger.lastUpdated ?? null,
          recordedProviderIds: rows.map(row => row.id),
          tokens: rows.length ? rows.reduce((sum, row) => sum + row.tokensIn + row.tokensOut
            + row.cacheReadTokens + row.cacheWriteTokens, 0) : null,
          provenance: [...new Set(rows.map(row => row.source))],
          costKind: 'api-equivalent-estimate',
        },
        comparison: {
          comparable: false, tokenDelta: null,
          reason: 'Account identity, product scope, retention and bucket timezone have not been matched. Never add these totals or use their difference as a correction.',
        },
      };
    }),
  };
}
