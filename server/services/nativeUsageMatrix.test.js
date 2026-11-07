import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeUsageParticipantKey } from '../lib/nativeUsageContract.js';
import { GROK_USAGE_FIELDS } from '../lib/nativeGrokUsageRecords.js';

let home;
vi.mock('node:os', async original => ({ ...await original(), homedir: () => home }));
vi.mock('./codexAppServer.js', () => ({ getCodexAccountUsageEvidence: vi.fn() }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn(async () => 'synthetic-local-instance') }));
vi.mock('./settings.js', async () => ({ getSettingsWithStatus: vi.fn(), settingsEvents: new (await import('node:events')).EventEmitter() }));
import { getCodexAccountUsageEvidence } from './codexAppServer.js';
import { getSettingsWithStatus } from './settings.js';
import { getNativeUsageMatrix, NATIVE_USAGE_DASHBOARD_LIMITS } from './nativeUsageMatrix.js';
import { captureDashboardNativeUsageReport } from './nativeUsageReport.js';

const LOCAL = nativeUsageParticipantKey('synthetic-local-instance');
const PEER = nativeUsageParticipantKey('synthetic-peer-instance');
const entry = (result, family) => result.providers.find(provider => provider.family === family);
const family = (result, name) => result.families.find(provider => provider.family === name);
const selected = (name, members = [LOCAL]) => ({ family: name, accountLabel: 'shared', members,
  ...(name === 'codex' ? { authoritativeParticipant: LOCAL } : { historyScope: 'operator-confirmed-retained-history' }),
});
const codex = (tokens = 300) => ({
  runtimeVersion: '0.166.0', accountBefore: { status: 'read', account: { authMethod: 'chatgpt', planType: 'pro' } },
  accountAfter: { status: 'read', account: { authMethod: 'chatgpt', planType: 'pro' } },
  usage: { summary: { lifetimeTokens: tokens }, dailyUsageBuckets: tokens === null ? null : [{ startDate: '2026-01-01', tokens }] },
});
const save = async (path, text) => {
  const target = join(home, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
  return target;
};
const claude = JSON.stringify({ type: 'assistant', requestId: 'private-request', timestamp: '2026-01-01T00:00:00Z',
  message: { id: 'private-message', stop_reason: 'end_turn', content: 'private transcript',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } });
const grok = () => {
  const turn = { turnNumber: 1, endedAt: '2026-01-02T03:04:05.123456+00:00', inputTokens: 100, outputTokens: 20,
    cachedReadTokens: 80, cacheCreationTokens: 0, reasoningTokens: 10, totalTokens: 120, modelCalls: 2,
    costUsdTicks: 123000, turnCount: 1, primaryModelId: 'private-model', modelUsage: {} };
  return JSON.stringify({ sessionId: 'private-session', updatedAt: turn.endedAt, turns: [turn],
    session: { ...Object.fromEntries(GROK_USAGE_FIELDS.map(field => [field, turn[field]])), turnCount: 1, costUsdTicks: 123000 } });
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  home = await mkdtemp(join(tmpdir(), 'native-matrix-'));
  getCodexAccountUsageEvidence.mockResolvedValue(codex());
  getSettingsWithStatus.mockResolvedValue({ settings: { usageNativeAccountSelections: ['codex', 'claude', 'grok', 'agy'].map(name => selected(name)) } });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

describe('local native dashboard capture', () => {
  it('resolves copies on this machine and reports totals without ledger data, per-record output or source writes', async () => {
    const source = await save('.claude/projects/private-project/session.jsonl', `${claude}\n`);
    await save('.claude/projects/copy/session.jsonl', `${claude}\n`);
    await save('.grok/sessions/private-project/private-session/usage.json', grok());
    await save('.grok/sessions/copy/copy/usage.json', grok());
    const before = await readFile(source, 'utf8');
    const modified = (await stat(source)).mtimeMs;
    const result = await getNativeUsageMatrix();
    expect(result).toMatchObject({ mode: 'read-only', scope: 'local-instance', contractVersion: 5, ledgerChanged: false,
      peerReports: 'not-collected', participantKey: LOCAL });
    expect(entry(result, 'claude')).toMatchObject({ totals: { totalTokens: 20 }, duplicates: { duplicateRecords: 1 },
      scanCaps: { limits: NATIVE_USAGE_DASHBOARD_LIMITS } });
    expect(family(result, 'claude')).toMatchObject({ merge: { status: 'partial', totals: { totalTokens: 20 },
      modelTotals: [{ kind: 'unknown', key: 'model-missing' }] }, accounts: [{ totals: { totalTokens: 20 } }] });
    expect(entry(result, 'grok')).toMatchObject({ source: 'grok:persisted-session-usage', totals: { totalTokens: 120 },
      cost: { actualSpendUsd: null, nativeCostSignal: { knownCostUsdTicks: 123000 } } });
    expect(entry(result, 'agy')).toMatchObject({ source: 'agy:cli-sqlite-metadata', totals: null, coverage: { missingSource: true } });
    expect(family(result, 'codex').merge).toMatchObject({ status: 'merged', totals: { lifetimeTokens: 300 } });
    const text = JSON.stringify(result);
    for (const secret of [home, 'private-', 'recordProjection', 'recordKey', 'requestKey', 'responseKeys', 'projectedRecords', 'synthetic-local-instance']) expect(text).not.toContain(secret);
    expect(result.families.every(row => !Object.hasOwn(row, 'sources') && row.accounts.every(account => !Object.hasOwn(account, 'records')))).toBe(true);
    expect(await readFile(source, 'utf8')).toBe(before);
    expect((await stat(source)).mtimeMs).toBe(modified);
  });

  it('names a missing selected peer rather than counting it as zero', async () => {
    await save('.claude/projects/p/s.jsonl', `${claude}\n`);
    getSettingsWithStatus.mockResolvedValue({ settings: { usageNativeAccountSelections: [selected('codex', [LOCAL, PEER]), selected('claude', [LOCAL, PEER])] } });
    const result = await getNativeUsageMatrix();
    expect(family(result, 'claude')).toMatchObject({ merge: { status: 'partial', totals: { totalTokens: 20 } },
      accounts: [{ status: 'partial', totals: { totalTokens: 20 }, membersWithoutReport: [PEER], findings: expect.arrayContaining(['member-report-missing']) }] });
    // An authoritative account-wide snapshot is read once even if another member is missing.
    expect(family(result, 'codex')).toMatchObject({ merge: { totals: { lifetimeTokens: 300 } }, accounts: [{ membersWithoutReport: [PEER] }] });
    expect(entry(result, 'claude').totals.totalTokens).toBe(20);
  });

  it('preserves unreadable settings, failed/unknown reads and unselected accounts as unavailable rather than zero', async () => {
    getSettingsWithStatus.mockResolvedValueOnce({ corrupt: true, settings: {} });
    getCodexAccountUsageEvidence.mockResolvedValueOnce(codex(null));
    const unknown = await getNativeUsageMatrix();
    expect(entry(unknown, 'codex').totals).toEqual({ lifetimeTokens: null, dailyBuckets: null });
    expect(unknown.refusals).toContainEqual({ code: 'selections-invalid', family: null, participantKey: null });
    expect(unknown.families.every(row => row.merge.totals === null)).toBe(true);
    getSettingsWithStatus.mockResolvedValueOnce({ settings: {} });
    const unselected = await getNativeUsageMatrix();
    expect(family(unselected, 'codex')).toMatchObject({ merge: { status: 'refused', totals: null }, unresolvedParticipants: [LOCAL] });
    getCodexAccountUsageEvidence.mockResolvedValueOnce({ failureCode: 'CODEX_APP_SERVER_TIMEOUT' });
    const unavailable = await getNativeUsageMatrix();
    expect(entry(unavailable, 'codex')).toMatchObject({ status: 'unavailable', totals: null, findings: ['refresh-failed'] });
    expect(family(unavailable, 'codex').accounts[0]).toMatchObject({ status: 'refused', totals: null });
  });

  it('coalesces overlapping reads, releases failures and never caches completed results or leaks capture errors', async () => {
    let resolve;
    getCodexAccountUsageEvidence.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = getNativeUsageMatrix();
    const repeated = getNativeUsageMatrix();
    expect(repeated).toBe(first);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    resolve(codex(0));
    expect(family(await first, 'codex').merge.totals.lifetimeTokens).toBe(0);
    await repeated;
    getCodexAccountUsageEvidence.mockRejectedValueOnce(new Error('private upstream path or credential'));
    await expect(getNativeUsageMatrix()).rejects.toThrow('Native usage capture failed. Existing usage records are unchanged.');
    expect(family(await getNativeUsageMatrix(), 'codex').merge.totals.lifetimeTokens).toBe(300);
    expect(getCodexAccountUsageEvidence).toHaveBeenCalledTimes(3);
  });

  it('reports a line past the memory bound and keeps the rest of the read', async () => {
    await save('.claude/projects/p/oversized.jsonl', `${'x'.repeat(NATIVE_USAGE_DASHBOARD_LIMITS.lineBytes + 1)}\n${claude}\n`);
    const result = await getNativeUsageMatrix();
    expect(entry(result, 'claude')).toMatchObject({ scanCaps: { capped: true, oversizedLines: 1 }, findings: expect.arrayContaining(['scan-capped']) });
    expect(family(result, 'claude').merge).toMatchObject({ status: 'partial', totals: { totalTokens: 20 } });
  });

  // The former budget stopped at 128 MiB of file bytes, a report's record list passed the
  // former 16 MiB peer limit at about 61,000 Claude records, and it holds at most 100,000.
  it('reads a whole history past the former limits into a report that holds only rollups', async () => {
    const filler = JSON.stringify({ type: 'attachment', text: 'x'.repeat(2 * 1024 ** 2) });
    await save('.claude/projects/p/attachments.jsonl', `${Array.from({ length: 70 }, () => filler).join('\n')}\n`);
    const line = index => JSON.stringify({ type: 'assistant', requestId: `request-${index}`, timestamp: `2026-01-${String(index % 28 + 1).padStart(2, '0')}T00:00:00Z`,
      message: { id: `message-${index}`, model: `example-model-${index % 3 === 0 ? 'a' : 'b'}`, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    await save('.claude/projects/p/records.jsonl', `${Array.from({ length: 100500 }, (_, index) => line(index)).join('\n')}\n`);
    const report = await captureDashboardNativeUsageReport();
    const claudeEntry = report.providers.find(provider => provider.family === 'claude');
    expect(claudeEntry).toMatchObject({ reproducibility: 'deterministic', recordProjection: null, coverage: { measuredRecords: 100500 },
      scanCaps: { capped: false, stoppedEarly: false }, totals: { totalTokens: 201000 } });
    expect(claudeEntry.modelUsage.buckets.reduce((sum, { counters }) => sum + counters.totalTokens, 0)).toBe(201000);
    const text = JSON.stringify(report);
    expect(Buffer.byteLength(text)).toBeLessThan(1024 ** 2);
    for (const identity of ['recordKey', 'requestKey', 'message-0', 'request-0']) expect(text).not.toContain(identity);
  }, 120_000);
});
