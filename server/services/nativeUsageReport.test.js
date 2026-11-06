import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeCodexAccount, normalizeCodexAccountUsage } from '../lib/codexAccount.js';
import { buildNativeUsageMatrix, nativeUsageCanonicalJson, nativeUsageReportSchema } from '../lib/nativeUsageContract.js';

vi.mock('./codexAppServer.js', () => ({ getCodexAccountUsageEvidence: vi.fn() }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettingsWithStatus: vi.fn() }));
import { getCodexAccountUsageEvidence } from './codexAppServer.js';
import { getInstanceId } from './instanceIdentity.js';
import { getSettingsWithStatus } from './settings.js';
import { captureNativeUsageReport, getNativeUsageAccountSelections, NATIVE_USAGE_CAPTURE_LIMITS } from './nativeUsageReport.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../lib/fixtures/nativeUsage/v1');
const fixtures = readdirSync(FIXTURE_DIR).map((name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')));
const NOW = () => new Date('2026-03-01T12:00:00.000Z');
const INSTANCE_ID = '00000000-0000-4000-8000-00000000000a';

// The real normalizers run over the raw fixture payload, as they do behind the RPC.
const codexEvidence = ({ account, accountAfter, accountFailed, usage, usageFailureCode }) => {
  const read = (raw) => (accountFailed ? { status: 'unread', account: null } : { status: 'read', account: normalizeCodexAccount(raw) });
  const outcome = { usage: null, failureCode: usageFailureCode ?? null };
  if (usage) {
    try {
      outcome.usage = normalizeCodexAccountUsage(usage);
    } catch {
      outcome.failureCode = 'CODEX_APP_SERVER_PROTOCOL_ERROR';
    }
  }
  return { ...outcome, accountBefore: read(account), accountAfter: read(accountAfter ?? account), runtimeVersion: '0.166.0' };
};
const SIGNED_IN = { account: { type: 'chatgpt' } };

let home;
const materialize = async (files) => {
  for (const [path, records] of Object.entries(files)) {
    const target = join(home, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  }
};
const capture = () => captureNativeUsageReport({ home, now: NOW });
const entry = (report, family) => report.providers.find((provider) => provider.family === family);

beforeEach(async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  home = await mkdtemp(join(tmpdir(), 'native-usage-report-'));
  getInstanceId.mockResolvedValue(INSTANCE_ID);
  getCodexAccountUsageEvidence.mockResolvedValue(codexEvidence({ account: SIGNED_IN, usageFailureCode: 'CODEX_APP_SERVER_TIMEOUT' }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('versioned provider validators', () => {
  it('ships a fixture set for every provider at the current fixture version', () => {
    expect(fixtures.map(({ family }) => family).sort()).toEqual(['agy', 'claude', 'codex', 'grok']);
    expect(fixtures.every(({ fixtureVersion }) => fixtureVersion === 1)).toBe(true);
  });

  const scenarios = fixtures.flatMap(({ family, scenarios: list }) => list.map((scenario) => [family, scenario.name, scenario]));
  it.each(scenarios)('%s: %s', async (family, _name, scenario) => {
    if (family === 'codex') getCodexAccountUsageEvidence.mockResolvedValue(codexEvidence(scenario));
    else await materialize(scenario.files);
    const report = await capture();
    expect(entry(report, family)).toMatchObject(scenario.expect);
    expect(nativeUsageReportSchema.safeParse(report).success).toBe(true);
  });
});

describe('reproducible staged input', () => {
  const claude = fixtures.find(({ family }) => family === 'claude').scenarios[0].files;

  it('gives byte-identical output for the same inputs and an equal evidence hash at a later capture', async () => {
    await materialize(claude);
    const source = join(home, '.claude/projects/p/s.jsonl');
    const before = await readFile(source, 'utf8');
    const { mtimeMs } = await stat(source);
    const first = await capture();
    const repeat = await capture();
    expect(nativeUsageCanonicalJson(repeat)).toBe(nativeUsageCanonicalJson(first));
    const later = await captureNativeUsageReport({ home, now: () => new Date('2026-04-01T00:00:00.000Z') });
    expect(later.evidenceHash).toBe(first.evidenceHash);
    expect(later.contentHash).not.toBe(first.contentHash);
    expect(await readFile(source, 'utf8')).toBe(before);
    expect((await stat(source)).mtimeMs).toBe(mtimeMs);
  });

  it('changes the evidence hash when the source changes and marks an early-stopped scan as order dependent', async () => {
    await materialize(claude);
    const first = await capture();
    await materialize({ '.claude/projects/p/new.jsonl': [{ type: 'assistant', requestId: 'r', timestamp: '2026-03-03T00:00:00Z', message: { id: 'new', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }] });
    expect((await capture()).evidenceHash).not.toBe(first.evidenceHash);
    const capped = await captureNativeUsageReport({ home, now: NOW, limits: { ...NATIVE_USAGE_CAPTURE_LIMITS, bytes: 1 } });
    expect(entry(capped, 'claude')).toMatchObject({ status: 'unavailable', totals: null, reproducibility: 'scan-stopped-early', scanCaps: { capped: true, stoppedEarly: true } });
    expect(entry(capped, 'claude').findings).toContain('scan-stopped-early');
  });

  it('never publishes paths, transcript text, native identifiers, the instance id or an account identity', async () => {
    const secrets = ['private-project', 'secret-session', 'msg-private', 'req-private', 'private transcript text', 'conv-private', 'grok-private', 'prompt-private', 'alice@example.com'];
    await materialize({
      '.claude/projects/private-project/secret-session.jsonl': [{ type: 'assistant', requestId: 'req-private', version: '../../private-project', timestamp: '2026-03-01T00:00:00Z', message: { id: 'msg-private', stop_reason: 'end_turn', content: 'private transcript text', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
      '.gemini/antigravity-cli/brain/conv-private/.system_generated/logs/transcript.jsonl': [{ type: 'PLANNER_RESPONSE', step_index: 0, content: 'private transcript text', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 }],
      '.grok/sessions/private-project/grok-private/updates.jsonl': [{ timestamp: 1772323200, params: { sessionId: 'grok-private', update: { sessionUpdate: 'turn_completed', prompt_id: 'prompt-private', usage: { inputTokens: 1, outputTokens: 1 } } } }],
    });
    getCodexAccountUsageEvidence.mockResolvedValue(codexEvidence({
      account: { account: { type: 'chatgpt', planType: 'alice@example.com', email: 'alice@example.com', id: 'acct-private' } },
      usage: { summary: { lifetimeTokens: 1, peakDailyTokens: 1, longestRunningTurnSec: 1, currentStreakDays: 1, longestStreakDays: 1 }, dailyUsageBuckets: [], threadUsage: { private: 'private transcript text' } },
    }));
    const report = await capture();
    const text = nativeUsageCanonicalJson(report);
    for (const secret of [...secrets, home, INSTANCE_ID, 'acct-private']) expect(text).not.toContain(secret);
    expect(entry(report, 'codex').scope.accountKey).toBeNull();
    expect(entry(report, 'codex').accountContext).toEqual({ status: 'read', authMethod: 'chatgpt', planType: null });
    expect(report.participantKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('unions independently captured copies by projected identity, not participant aggregates', async () => {
    await materialize(claude);
    const first = await capture();
    getInstanceId.mockResolvedValue('00000000-0000-4000-8000-00000000000b');
    const copied = await capture();
    const matrix = buildNativeUsageMatrix({ reports: [first, copied], selections: [{
      family: 'claude', accountLabel: 'acct-a', historyScope: 'operator-confirmed-retained-history', members: [first.participantKey, copied.participantKey],
    }] });
    expect(first.contractVersion).toBe(2);
    expect(matrix.families.find(({ family }) => family === 'claude')).toMatchObject({
      merge: { status: 'partial', completeness: 'unknown', totals: { totalTokens: 41 } },
      accounts: [{ coverage: { uniqueRecords: 2, measuredRecords: 2, duplicateRecords: 2 }, records: expect.any(Array) }],
    });
  });

  it('flows a captured report into the matrix, and an unset instance identity refuses to merge', async () => {
    getCodexAccountUsageEvidence.mockResolvedValue(codexEvidence(fixtures.find(({ family }) => family === 'codex').scenarios[0]));
    const report = await capture();
    const matrix = buildNativeUsageMatrix({
      reports: [report],
      selections: [{ family: 'codex', accountLabel: 'acct-a', authoritativeParticipant: report.participantKey, members: [report.participantKey] }],
    });
    expect(matrix.families.find(({ family }) => family === 'codex').merge).toMatchObject({ status: 'merged', totals: { lifetimeTokens: 300 } });
    getInstanceId.mockResolvedValue('unknown');
    const anonymous = await capture();
    expect(anonymous.participantKey).toBeNull();
    expect(buildNativeUsageMatrix({ reports: [anonymous], selections: [] }).families.find(({ family }) => family === 'codex').merge)
      .toMatchObject({ status: 'refused', reasons: ['participant-identity-unknown'], totals: null });
  });
});

describe('stored account selection', () => {
  it('reads a stored selection and reports unreadable settings as null, which the matrix refuses', async () => {
    getSettingsWithStatus.mockResolvedValue({ settings: {} });
    expect(await getNativeUsageAccountSelections()).toEqual([]);
    const selection = [{ family: 'codex', accountLabel: 'acct-a', authoritativeParticipant: 'a'.repeat(32), members: ['a'.repeat(32)] }];
    getSettingsWithStatus.mockResolvedValue({ settings: { usageNativeAccountSelections: selection } });
    expect(await getNativeUsageAccountSelections()).toEqual(selection);
    getSettingsWithStatus.mockResolvedValue({ settings: {}, corrupt: true });
    const unreadable = await getNativeUsageAccountSelections();
    expect(unreadable).toBeNull();
    expect(buildNativeUsageMatrix({ reports: [], selections: unreadable }).refusals).toEqual([{ code: 'selections-invalid', family: null, participantKey: null }]);
  });
});
