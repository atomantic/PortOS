import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runNativeUsageStageCli } from './native-usage-stage.js';
import { buildNativeUsageReport, nativeUsageParticipantKey } from '../server/lib/nativeUsageContract.js';
import { buildNativeUsageStage, verifyNativeUsageStage } from '../server/lib/nativeUsageStaging.js';
import { canonicalStringify } from '../server/lib/objects.js';

const digest = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const key = nativeUsageParticipantKey;
const at = '2026-03-01T00:00:00.000Z';
const families = ['agy', 'claude', 'codex', 'grok'];
const retained = ['agy', 'claude', 'grok'];
const rehash = ({ contentHash: _discard, ...body }) => {
  const updated = { ...body, evidenceHash: digest(body.providers) };
  return { ...updated, contentHash: digest(updated) };
};
const record = (family, name = 'shared') => {
  const common = { recordKey: digest(`${family}:${name}`), at, conflict: false };
  if (family === 'claude') return { ...common, requestKey: digest(name), values: [10, 20, 3, 5], final: true, inconsistent: false };
  if (family === 'grok') return { ...common, values: [10, 5, 2, 0, 1, 15, 1], costUsdTicks: null, costConflict: false, inconsistent: false };
  return { ...common, responseKeys: [digest(name)], values: [10, 5, 100, 0, 3, 2], model: -1, apiProvider: 24, stepType: 15, completedAt: at, final: true };
};
const scan = family => ({
  status: 'partial', summary: { totalTokens: null, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ...(family === 'agy' ? { source: 'agy:cli-sqlite-metadata', validator: 'agy-cli-sqlite-v1/1' } : {}),
  ...(family === 'grok' ? { source: 'grok:persisted-session-usage', validator: 'grok-persisted-turns/1' } : {}),
  coverage: {
    files: 1, records: 1, measuredRecords: 1, missingUsageRecords: 0, missingIdentityRecords: 0, duplicateRecords: 0, conflictingRecords: 0,
    invalidLines: 0, undatedRecords: 0, unreadableFiles: 0, skippedLinks: 0, missingSource: false, capped: false, stoppedEarly: false,
    oversizedLines: 0, streamingSupersededRecords: 0, unfinalizedRecords: 0, fieldInconsistentRecords: 0, runtimeVersions: [], steps: null,
    cacheOverlap: null, costTickRecords: null, firstObservedAt: at, lastObservedAt: at,
  },
  recordProjection: { version: 1, identityScheme: { agy: 'sha256-agy-message-response/1', claude: 'sha256-native-record/1', grok: 'sha256-grok-session-turn/1' }[family], truncated: false, records: [record(family)] },
});
const report = host => buildNativeUsageReport({
  instanceId: host, capturedAt: '2026-03-02T00:00:00.000Z',
  scanLimits: { bytes: 10000, lineBytes: 1000, entries: 100, records: 100, milliseconds: 1000, depth: 8 },
  codexEvidence: { runtimeVersion: '0.166.0', accountBefore: { status: 'read', account: { authMethod: 'chatgpt', planType: 'plus' } },
    accountAfter: { status: 'read', account: { authMethod: 'chatgpt', planType: 'plus' } },
    usage: { summary: { lifetimeTokens: 100 }, dailyUsageBuckets: [{ startDate: '2026-02-27', tokens: 30 }, { startDate: '2026-03-01', tokens: 40 }] } },
  transcripts: Object.fromEntries(retained.map(family => [family, scan(family)])),
});
const request = (hosts = ['host-a', 'host-b', 'host-c'], selectedFamilies = families) => ({
  version: 1, participants: hosts.map(key),
  selections: selectedFamilies.map(family => ({ family, accountLabel: 'acct-a', members: hosts.map(key),
    ...(family === 'codex' ? { authoritativeParticipant: key(hosts[0]) } : { historyScope: 'operator-confirmed-retained-history' }) })),
});
const entry = (value, family) => value.providers.find(provider => provider.family === family);
const partition = (value, family) => value.partitions.find(provider => provider.family === family);

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'native-staging-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const run = async args => {
  let stdout = '';
  let stderr = '';
  const code = await runNativeUsageStageCli(args, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
};
const prepare = async (selection = request(), reports = ['host-a', 'host-b', 'host-c'].map(report)) => {
  const requestPath = join(dir, 'request.json');
  await writeFile(requestPath, JSON.stringify(selection));
  const paths = [];
  for (const [index, value] of reports.entries()) {
    const path = join(dir, `report-${index}.json`);
    await writeFile(path, JSON.stringify(value));
    paths.push(path);
  }
  return ['stage', requestPath, join(dir, 'staged'), ...paths];
};

describe('offline native usage staging', () => {
  it('stages all four shared-account partitions once, binding evidence and preserving unknown coverage without touching active files', async () => {
    const live = ['usage.json', 'peer-usage.json', 'usage-cutover-barrier.json', 'settings.json'];
    for (const name of live) await writeFile(join(dir, name), `unchanged ${name}`);
    const args = await prepare();
    const receipt = JSON.parse((await run(args)).stdout);
    const path = join(dir, 'staged', receipt.fileName);
    const artifact = JSON.parse(await readFile(path, 'utf8'));
    expect(receipt).toMatchObject({ status: 'staged', partitionCount: 4, activationReady: false });
    expect(partition(artifact, 'codex')).toMatchObject({ totals: { lifetimeTokens: 100 }, completeness: 'unknown',
      sourceCoverage: expect.arrayContaining([expect.objectContaining({ missingIntervals: { status: 'reported', intervals: [{ from: '2026-02-28', to: '2026-02-28' }], truncated: false } })]) });
    expect(partition(artifact, 'claude')).toMatchObject({ totals: { totalTokens: 38 }, coverage: { measuredRecords: 1, duplicateRecords: 2 } });
    expect(partition(artifact, 'grok')).toMatchObject({ totals: { totalTokens: 15 }, cost: { actualSpendUsd: null, nativeCostSignal: { knownCostUsdTicks: null } } });
    expect(partition(artifact, 'agy')).toMatchObject({ totals: { totalTokens: null, cacheReadTokens: 100 }, cost: { actualSpendUsd: null } });
    expect(artifact.manifest.reports).toHaveLength(3);
    expect(artifact.manifest.partitions.map(({ contentHash }) => contentHash)).toEqual(artifact.partitions.map(value => value.contentHash));
    expect(artifact.manifest.activation).toMatchObject({ ready: false, reasons: expect.arrayContaining(['fenced-interval-not-verified', 'runtime-not-registered']) });
    expect(JSON.parse((await run(['verify', path])).stdout)).toMatchObject({ status: 'verified', activationReady: false });
    for (const name of live) expect(await readFile(join(dir, name), 'utf8')).toBe(`unchanged ${name}`);
  });

  it('retries and concurrent completions publish one byte-identical artifact, ignoring incomplete temporary files', async () => {
    const args = await prepare();
    await mkdir(join(dir, 'staged', '.native-usage-interrupted'), { recursive: true });
    await writeFile(join(dir, 'staged', '.native-usage-interrupted', 'stage.json'), '{');
    const [a, b] = await Promise.all([run(args), run(args)]);
    expect(a.stdout).toBe(b.stdout);
    expect((await run(args)).stdout).toBe(a.stdout);
    const files = await readdir(join(dir, 'staged'));
    expect(files.filter(name => name.endsWith('.json'))).toHaveLength(1);
    const input = request();
    input.participants.reverse();
    input.selections.reverse().forEach(selection => { selection.members.reverse(); });
    const reordered = await prepare(input, ['host-c', 'host-b', 'host-a', 'host-b'].map(report));
    expect((await run(reordered)).stdout).toBe(a.stdout);
  });

  it('binds source revisions and selections and refuses corrupt published bytes rather than overwriting them', async () => {
    const args = await prepare();
    const receipt = JSON.parse((await run(args)).stdout);
    const path = join(dir, 'staged', receipt.fileName);
    const artifact = JSON.parse(await readFile(path, 'utf8'));
    const changed = structuredClone(artifact);
    changed.manifest.activation.ready = true;
    expect(() => verifyNativeUsageStage(changed)).toThrow('artifact-mismatch');
    changed.manifest.activation.ready = false;
    changed.inputs.request.selections[0].accountLabel = 'another-account';
    expect(() => verifyNativeUsageStage(changed)).toThrow('artifact-mismatch');
    await writeFile(path, '{');
    await expect(run(args)).rejects.toThrow('existing staging artifact does not match');
    expect(await readFile(path, 'utf8')).toBe('{');
    const newer = report('host-a');
    newer.capturedAt = '2026-03-03T00:00:00.000Z';
    entry(newer, 'codex').totals.lifetimeTokens = 110;
    const stage = buildNativeUsageStage({ request: request(), reports: [report('host-a'), rehash(newer), report('host-b'), report('host-c')] });
    expect(stage.contentHash).not.toBe(artifact.contentHash);
    expect(stage.manifest.reports).toHaveLength(4);
    expect(partition(stage, 'codex').totals.lifetimeTokens).toBe(110);
  });

  it('refuses missing participants, tampering, conflicting captures and incomplete input before creating output', async () => {
    const invalid = report('host-a');
    entry(invalid, 'codex').totals.lifetimeTokens++;
    const conflict = rehash(invalid);
    const cases = [
      [request(), [report('host-a')], 'participant-set-mismatch'],
      [request(['host-a']), [invalid, report('host-a')], 'report-invalid'],
      [request(['host-a']), [report('host-a'), conflict], 'conflicting-reports'],
      [request(['host-a']), [report('host-b')], 'participant-set-mismatch'],
    ];
    for (const [selection, reports, reason] of cases) {
      const args = await prepare(selection, reports);
      await expect(run(args)).rejects.toThrow(reason);
    }
    expect(await readdir(dir)).not.toContain('staged');
    for (const family of retained) {
      for (const flag of ['capped', 'stoppedEarly']) {
        const value = report('host-a');
        entry(value, family).scanCaps[flag] = true;
        expect(() => buildNativeUsageStage({ request: request(['host-a']), reports: [rehash(value)] })).toThrow(`${family}-source-incomplete`);
      }
      const value = report('host-a');
      entry(value, family).recordProjection.truncated = true;
      expect(() => buildNativeUsageStage({ request: request(['host-a']), reports: [rehash(value)] })).toThrow('record-projection-truncated');
    }
  });

  it('keeps excluded conflicts in immutable inputs and gaps explicit, without resurrecting them from a clean copy', () => {
    const first = report('host-a');
    const second = report('host-b');
    for (const family of retained) {
      entry(first, family).recordProjection.records.push(record(family, 'good'));
      entry(second, family).recordProjection.records[0].conflict = true;
    }
    const artifact = buildNativeUsageStage({ request: request(['host-a', 'host-b']), reports: [rehash(first), rehash(second)] });
    for (const family of retained) {
      expect(partition(artifact, family)).toMatchObject({ completeness: 'unknown', coverage: { measuredRecords: 1, excludedRecords: 1, excluded: { 'conflicting-records': 1 } }, legacy: { overlap: 'unknown', additiveAdjustment: null } });
      expect(partition(artifact, family).records.map(({ recordKey }) => recordKey)).toEqual([record(family, 'good').recordKey]);
      expect(artifact.inputs.reports.some(value => entry(value, family).recordProjection.records.some(row => row.conflict))).toBe(true);
    }
  });

  it('refuses retained source revisions so latest-wins cannot erase older conflicts or account ownership evidence', () => {
    for (const family of retained) {
      const older = report('host-a');
      const newer = report('host-a');
      newer.capturedAt = '2026-03-03T00:00:00.000Z';
      entry(older, family).recordProjection.records[0].conflict = true;
      const selection = request(['host-a'], [family]);
      expect(() => buildNativeUsageStage({ request: selection, reports: [rehash(older), rehash(newer)] })).toThrow(`${family}-retained-source-revised`);
      entry(older, family).recordProjection.records = [record(family, 'old-account-copy')];
      expect(() => buildNativeUsageStage({ request: selection, reports: [rehash(older), rehash(newer)] })).toThrow(`${family}-retained-source-revised`);
      // A newly chosen capture remains usable, but is a distinct immutable stage,
      // not an update to the old partition or proof that account history is complete.
      expect(buildNativeUsageStage({ request: selection, reports: [rehash(newer)] }).manifest.activation.ready).toBe(false);
    }
  });

  it('refuses historical account ambiguity and unsafe dates/counters, preserving unselected providers separately', () => {
    const selection = request(['host-a', 'host-b'], ['claude']);
    selection.selections = ['host-a', 'host-b'].map(host => ({ family: 'claude', accountLabel: host, members: [key(host)], historyScope: 'operator-confirmed-retained-history' }));
    expect(() => buildNativeUsageStage({ request: selection, reports: [report('host-a'), report('host-b')] })).toThrow('record-in-multiple-accounts');
    delete selection.selections[0].historyScope;
    expect(() => buildNativeUsageStage({ request: selection, reports: [report('host-a'), report('host-b')] })).toThrow('request-invalid');
    const simple = request(['host-a'], ['codex']);
    const artifact = buildNativeUsageStage({ request: simple, reports: [report('host-a')] });
    expect(artifact.manifest.legacy.unselectedFamilies).toEqual(['agy', 'claude', 'grok']);
    for (const corrupt of [value => { value.capturedAt = '2026-02-30T00:00:00.000Z'; }, value => { entry(value, 'codex').totals.lifetimeTokens = Number.MAX_SAFE_INTEGER + 1; }]) {
      const value = report('host-a');
      corrupt(value);
      expect(() => buildNativeUsageStage({ request: simple, reports: [rehash(value)] })).toThrow('report-invalid');
    }
  });

  it('rejects invalid CLI commands and inputs without leaking private input contents', async () => {
    expect((await run(['activate'])).code).toBe(2);
    expect((await run(['verify'])).code).toBe(2);
    await expect(run(['verify', join(dir, 'private-name')])).rejects.toThrow('cannot read staging input');
    const path = join(dir, 'invalid.json');
    await writeFile(path, '{"private":');
    await expect(run(['verify', path])).rejects.toThrow('invalid staging JSON');
  });
});
