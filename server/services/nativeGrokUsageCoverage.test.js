import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNativeGrokUsageCoverage } from './nativeGrokUsageCoverage.js';
import { buildNativeUsageMatrix, nativeUsageCanonicalJson } from '../lib/nativeUsageContract.js';
import { GROK_USAGE_FIELDS } from '../lib/nativeGrokUsageRecords.js';

vi.mock('./codexAppServer.js', () => ({ getCodexAccountUsageEvidence: vi.fn(async () => ({ failureCode: 'CODEX_RUNTIME_MISSING' })) }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettingsWithStatus: vi.fn() }));
import { getInstanceId } from './instanceIdentity.js';
import { captureNativeUsageReport } from './nativeUsageReport.js';

let home;
const turn = (turnNumber = 1, overrides = {}) => ({
  turnNumber, endedAt: '2026-01-02T03:04:05.123456+00:00', inputTokens: 100, outputTokens: 20,
  cachedReadTokens: 80, cacheCreationTokens: 0, reasoningTokens: 10, totalTokens: 120, modelCalls: 2,
  costUsdTicks: 123000, turnCount: 1, primaryModelId: 'synthetic-model', modelUsage: {}, ...overrides,
});
const snapshot = (sessionId = 'synthetic-session', turns = [turn()]) => ({
  sessionId, updatedAt: '2026-01-02T03:04:05.123456+00:00', turns,
  session: { ...Object.fromEntries(GROK_USAGE_FIELDS.map(field => [field, turns.reduce((sum, record) => sum + record[field], 0)])),
    turnCount: turns.length, costUsdTicks: turns.every(record => record.costUsdTicks !== null) ? turns.reduce((sum, record) => sum + record.costUsdTicks, 0) : null },
});
const put = async (path, data) => {
  const target = join(home, '.grok/sessions', path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return target;
};
const scan = limits => getNativeGrokUsageCoverage({ home, limits });
const capture = async host => {
  getInstanceId.mockResolvedValue(host);
  return captureNativeUsageReport({ home, now: () => new Date('2026-03-01T00:00:00Z') });
};
const selection = (...reports) => ({ family: 'grok', accountLabel: 'shared', historyScope: 'operator-confirmed-retained-history', members: reports.map(report => report.participantKey) });
const grok = matrix => matrix.families.find(({ family }) => family === 'grok');
const matrix = reports => grok(buildNativeUsageMatrix({ reports, selections: [selection(...reports)] }));

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'grok-native-')); vi.stubEnv('CLAUDE_CONFIG_DIR', ''); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('persisted Grok capture and retained-account union', () => {
  it('reads native turns without touching sources or counting session totals, raw events or cache/reasoning twice', async () => {
    const path = await put('project/session/usage.json', snapshot('private-session', [turn(), turn(2, { costUsdTicks: null })]));
    await put('project/session/updates.jsonl', `${JSON.stringify({ private: 'do not read raw updates', totalTokens: 999999 })}\n`);
    const before = await readFile(path, 'utf8');
    const mtime = (await stat(path)).mtimeMs;
    const first = await capture('a');
    const copied = await capture('b');
    const result = matrix([first, copied]);
    expect(result).toMatchObject({
      merge: { status: 'partial', completeness: 'unknown', totals: { totalTokens: 240, tokensIn: 200, tokensOut: 40, cacheReadTokens: 160, reasoningTokens: 20 } },
      accounts: [{ coverage: { uniqueRecords: 2, measuredRecords: 2, duplicateRecords: 2 }, cost: { actualSpendUsd: null,
        nativeCostSignal: { knownCostUsdTicks: 123000, measuredRecords: 1, missingRecords: 1 } } }],
    });
    const full = buildNativeUsageMatrix({ reports: [first, copied], selections: [selection(first, copied)] });
    expect(nativeUsageCanonicalJson(buildNativeUsageMatrix({ reports: [copied, first], selections: [selection(first, copied)] }))).toBe(nativeUsageCanonicalJson(full));
    expect(await capture('a')).toEqual(first);
    const serialized = nativeUsageCanonicalJson(full);
    for (const secret of ['private-session', 'project/session', 'synthetic-model', 'do not read raw updates', home]) expect(serialized).not.toContain(secret);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await stat(path)).mtimeMs).toBe(mtime);
    expect(result.accounts[0].findings).toContain('native-cost-incomplete');
  });

  it('keeps sessions distinct, collapses copied roots and excludes contradictions without choosing a machine winner', async () => {
    await put('one/s/usage.json', snapshot('same'));
    await put('two/copy/usage.json', snapshot('same'));
    await put('one/distinct/usage.json', snapshot('distinct'));
    const first = await capture('a');
    expect(first.providers.find(row => row.family === 'grok').duplicates.duplicateRecords).toBe(1);
    await put('one/s/usage.json', snapshot('same', [turn(1, { inputTokens: 101, totalTokens: 121 })]));
    const conflicted = await capture('b');
    const result = matrix([first, conflicted]);
    expect(result.accounts[0]).toMatchObject({ totals: { totalTokens: 120 }, coverage: { uniqueRecords: 2, measuredRecords: 1, excludedRecords: 1 } });
  });

  it('rejects bad session sums, duplicate turn numbers, invalid fields and undated turns but preserves a healthy subset', async () => {
    const badSum = snapshot('sum'); badSum.session.totalTokens++;
    await put('p/sum/usage.json', badSum);
    await put('p/duplicate/usage.json', snapshot('duplicate', [turn(), turn()]));
    await put('p/fields/usage.json', snapshot('fields', [turn(1, { inputTokens: null })]));
    await put('p/date/usage.json', snapshot('date', [turn(1, { endedAt: null })]));
    await put('p/healthy/usage.json', snapshot('healthy'));
    const report = await capture('a');
    const result = matrix([report]);
    expect(result.accounts[0]).toMatchObject({ totals: { totalTokens: 120 }, coverage: { measuredRecords: 1, excludedRecords: 4 } });
    expect(report.providers.find(row => row.family === 'grok').nativeUsageCoverage).toMatchObject({ invalidSnapshots: 3 });
  });

  it('retains tokens when cost is missing or contradictory, never interpreting native ticks as USD spend', async () => {
    await put('p/s/usage.json', snapshot('same', [turn(1, { costUsdTicks: null })]));
    const missing = await capture('a');
    await put('p/s/usage.json', snapshot('same'));
    const known = await capture('b');
    expect(matrix([missing, known]).accounts[0].cost.nativeCostSignal).toMatchObject({ knownCostUsdTicks: 123000, measuredRecords: 1, missingRecords: 0 });
    await put('p/s/usage.json', snapshot('same', [turn(1, { costUsdTicks: 555 })]));
    const conflict = await capture('c');
    const account = matrix([missing, known, conflict]).accounts[0];
    expect(account).toMatchObject({ totals: { totalTokens: 120 }, cost: { actualSpendUsd: null, nativeCostSignal: { knownCostUsdTicks: null, conflictingRecords: 1 } } });
    expect(account.findings).toContain('native-cost-conflict');
  });

  it('refuses absent projections, cross-account duplicates and missing requested participants', async () => {
    await put('p/s/usage.json', snapshot());
    const a = await capture('a'); const b = await capture('b');
    const split = grok(buildNativeUsageMatrix({ reports: [a, b], selections: [{ ...selection(a), accountLabel: 'one' }, { ...selection(b), accountLabel: 'two' }] }));
    expect(split.merge).toMatchObject({ status: 'refused', totals: null, reasons: ['record-in-multiple-accounts'] });
    expect(split.accounts.every(account => account.totals === null && account.records.length === 0 && !account.cost.nativeCostSignal)).toBe(true);
    expect(grok(buildNativeUsageMatrix({ reports: [a], selections: [selection(a, b)] })).merge.reasons).toContain('member-report-missing');
    const legacy = structuredClone(b); legacy.contractVersion = 2;
    legacy.providers.forEach(provider => { delete provider.nativeUsageCoverage; delete provider.nativeAgyCoverage; });
    const oldAgy = legacy.providers.find(row => row.family === 'agy');
    Object.assign(oldAgy, { source: 'agy:retained-transcripts', validator: 'agy-retained-steps/1', recordProjection: null });
    delete oldAgy.tokenFields.thinkingOutputTokens; delete oldAgy.tokenFields.responseOutputTokens;
    const old = legacy.providers.find(row => row.family === 'grok');
    Object.assign(old, { source: 'grok:retained-transcripts', validator: 'grok-retained-turns/1', recordProjection: null,
      cost: { estimatedApiEquivalentUsd: null, actualSpendUsd: null, nativeCostSignal: null } });
    const digest = value => createHash('sha256').update(nativeUsageCanonicalJson(value).trim()).digest('hex');
    legacy.evidenceHash = digest(legacy.providers); const { contentHash: _hash, ...body } = legacy; legacy.contentHash = digest(body);
    expect(matrix([a, legacy]).merge).toMatchObject({ status: 'refused', reasons: ['record-projection-unavailable'] });
  });

  it('labels missing, malformed, oversized and linked sources and never falls back to raw update events', async () => {
    expect(await scan()).toMatchObject({ summary: null, coverage: { missingSource: true } });
    await put('p/raw/updates.jsonl', '{}\n');
    await put('p/malformed/usage.json', '{');
    await put('p/large/usage.json', ' '.repeat(5000));
    const target = await put('p/good/usage.json', snapshot());
    await symlink(target, join(home, '.grok/sessions/p/good-copy'));
    const result = await scan({ lineBytes: 1000 });
    expect(result).toMatchObject({ summary: { totalTokens: 120 }, coverage: { invalidLines: 1, skippedLinks: 1, oversizedLines: 1, capped: true }, nativeUsageCoverage: { sessionsWithoutUsage: 1 } });
    expect(await scan({ bytes: 1 })).toMatchObject({ summary: null, coverage: { capped: true, stoppedEarly: true } });
  });

  it('refuses unsafe token sums while reporting cost overflow separately', async () => {
    const large = turn(1, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cachedReadTokens: 0, reasoningTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER, costUsdTicks: Number.MAX_SAFE_INTEGER });
    await put('p/a/usage.json', snapshot('a', [large]));
    await put('p/b/usage.json', snapshot('b', [large]));
    const report = await capture('a');
    expect(matrix([report]).merge).toMatchObject({ status: 'refused', totals: null });
    expect(matrix([report]).merge.reasons).toContain('counter-overflow');
  });
});
