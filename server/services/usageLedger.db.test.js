import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-usage-ledger-db-' });
vi.mock('../lib/fileUtils.js', async (original) => makeProxy(await original()));
vi.stubEnv('PORTOS_USAGE_TEST_POSTGRES', '1');

const {
  USAGE_FILE, addDatedUsageBatch, buildUsageDigest, flushPendingUsageWrites, getRecentCodexUsageClaims,
  getUsage, loadUsage, readUsageRepairLedger, recordRunUsage, recordSession, resetUsage,
} = await import('./usage.js');
const { importLegacyUsageLedger } = await import('./usageLedgerDb.js');
const { PATHS } = await import('../lib/fileUtils.js');
const health = await checkHealth().catch((error) => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('services/usageLedger.db.test', health.connected, health.error);
const claimAt = '2025-01-01T10:45:00.000Z';
const claims = [['fixture:codex', { messages: 1, tokensIn: 4, tokensOut: 5 }]];
const historicDay = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
const legacy = JSON.stringify({
  totalSessions: 1, totalMessages: 0, totalToolCalls: 0, totalTokens: { input: 0, output: 0 },
  byProvider: {}, byModel: {}, monthlyActivity: {}, hourlyActivity: Array(24).fill(0),
  dailyActivity: { [historicDay]: { sessions: 1 } },
  blockEvents: [], earliestActivityDay: historicDay, lastUpdated: claimAt,
  reconciledRuns: { 'legacy-run': { at: claimAt, codexHighWater: claims } },
  siblingReconciledRuns: { 'legacy-run': claimAt },
  grokRepairIds: ['legacy-repair'],
});

const clearLedger = () => query('TRUNCATE usage_ledger_buckets, usage_ledger_markers');

beforeEach(async () => {
  if (!ready) return;
  await ensureSchema();
  await clearLedger();
  await writeFile(USAGE_FILE, legacy);
  await withTransaction((client) => importLegacyUsageLedger(client, USAGE_FILE));
  await loadUsage();
});

afterAll(async () => {
  if (ready) await clearLedger();
  await close();
  vi.unstubAllEnvs();
  cleanup();
});

describe.skipIf(!ready)('PostgreSQL usage ledger', () => {
  async function historicBucketVersion() {
    const { rows: [row] } = await query(
      "SELECT xmin::text AS version FROM usage_ledger_buckets WHERE bucket = 'dailyActivity' AND key = $1",
      [historicDay],
    );
    return row.version;
  }

  it('persists 100 fully awaited runs without rewriting the historic bucket or legacy JSON', async () => {
    const version = await historicBucketVersion();
    for (let index = 0; index < 100; index++) {
      await recordSession('codex-cli', 'Codex', 'fixture-model');
      await recordRunUsage({
        providerId: 'codex-cli', model: 'fixture-model', tokensOut: 3, repairIds: [`repair-${index}`],
      }, { reconciledRunId: `run-${index}`, siblings: true });
    }
    expect(await historicBucketVersion()).toBe(version);
    expect(await readFile(USAGE_FILE, 'utf8')).toBe(legacy);
    const running = getUsage();
    expect(running).toMatchObject({ totalSessions: 101, totalMessages: 100, totalTokens: { output: 300 } });
    for (const key of ['reconciledRuns', 'siblingReconciledRuns', 'grokRepairIds']) {
      expect(running).not.toHaveProperty(key);
    }
    const snapshot = await readUsageRepairLedger(PATHS.data);
    expect(Object.keys(snapshot.reconciledRuns)).toHaveLength(101);
    expect(Object.keys(snapshot.siblingReconciledRuns)).toHaveLength(101);
    expect(snapshot.grokRepairIds).toHaveLength(101);
    expect(await getRecentCodexUsageClaims(Date.parse(claimAt))).toEqual(claims);
    expect(await getRecentCodexUsageClaims(Date.parse(claimAt) + 1)).toEqual([]);
    await recordRunUsage([], { reconciledRunId: 'legacy-run', codexHighWater: [['new-boundary', { tokensIn: 9 }]] });
    expect(await getRecentCodexUsageClaims(0)).toEqual(claims);
    expect(await addDatedUsageBatch(['legacy-repair', 'repair-10'].map(repairId => ({
      day: historicDay, record: { providerId: 'codex-cli', tokensOut: 900 }, repairId,
    })))).toEqual([]);
    const latest = getUsage();
    const reloaded = await loadUsage();
    expect(reloaded).toEqual(latest);
    expect(buildUsageDigest(reloaded)).toEqual(buildUsageDigest({ ...snapshot, lastUpdated: latest.lastUpdated }));
    await resetUsage();
    expect(await loadUsage()).toMatchObject({ totalSessions: 0, totalMessages: 0 });
    expect(await getRecentCodexUsageClaims(0)).toEqual([]);
  }, 30_000);

  it('rolls back counters and markers together and drains the next batch on flush', async () => {
    const before = getUsage();
    await query("ALTER TABLE usage_ledger_markers ADD CONSTRAINT usage_test_reject_id CHECK (id <> 'rejected')");
    try {
      const completion = recordRunUsage({ providerId: 'codex-cli', tokensOut: 7, repairIds: ['repair'] },
        { reconciledRunId: 'rejected', siblings: true });
      await expect(completion).rejects.toMatchObject({ code: '23514' });
      expect(getUsage()).toBe(before);
      const stored = await readUsageRepairLedger(PATHS.data);
      expect(stored.totalTokens).toEqual(before.totalTokens);
      expect(stored.grokRepairIds).toEqual(['legacy-repair']);
      expect(Object.keys(stored.reconciledRuns)).toEqual(['legacy-run']);
    } finally {
      await query('ALTER TABLE usage_ledger_markers DROP CONSTRAINT usage_test_reject_id');
    }
    const saved = recordRunUsage({ providerId: 'codex-cli', tokensOut: 7, repairIds: ['repair'] },
      { reconciledRunId: 'rejected', siblings: true });
    await flushPendingUsageWrites();
    await saved;
    const stored = await readUsageRepairLedger(PATHS.data);
    expect(stored).toMatchObject({ totalTokens: { output: 7 }, grokRepairIds: ['legacy-repair', 'repair'] });
    expect(stored.reconciledRuns.rejected).toBeTruthy();
    expect(stored.siblingReconciledRuns.rejected).toBeTruthy();
  });
});
