import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalStringify } from './objects.js';
import {
  buildNativeUsageMatrix,
  buildNativeUsageReport,
  formatNativeUsageMatrixSummary,
  nativeUsageAccountSelectionsSchema,
  nativeUsageCanonicalJson,
  nativeUsageParticipantKey,
} from './nativeUsageContract.js';

const missingSource = {
  status: 'unavailable', summary: null,
  coverage: {
    files: 0, records: 0, measuredRecords: 0, missingUsageRecords: 0, missingIdentityRecords: 0, duplicateRecords: 0, conflictingRecords: 0,
    invalidLines: 0, undatedRecords: 0, unreadableFiles: 0, skippedLinks: 0, missingSource: true, capped: false, stoppedEarly: false,
    oversizedLines: 0, streamingSupersededRecords: 0, unfinalizedRecords: 0, fieldInconsistentRecords: 0, runtimeVersions: [], steps: null,
    cacheOverlap: null, costTickRecords: null, firstObservedAt: null, lastObservedAt: null,
  },
};
const LIMITS = { bytes: 1, lineBytes: 1, entries: 1, records: 1, milliseconds: 1, depth: 1 };
const usage = (lifetimeTokens, days = [['2026-02-01', lifetimeTokens]]) => ({
  summary: { lifetimeTokens }, dailyUsageBuckets: days.map(([startDate, tokens]) => ({ startDate, tokens })),
});
const signedIn = (planType = 'plus') => ({ status: 'read', account: { authMethod: 'chatgpt', planType } });
const report = (instanceId, codex = {}, capturedAt = '2026-03-01T00:00:00.000Z', transcripts = {}) => buildNativeUsageReport({
  instanceId, capturedAt, scanLimits: LIMITS,
  transcripts: { agy: missingSource, claude: missingSource, grok: missingSource, ...transcripts },
  codexEvidence: { usage: usage(100), failureCode: null, accountBefore: signedIn(), accountAfter: signedIn(), runtimeVersion: '0.166.0', ...codex },
});
const key = nativeUsageParticipantKey;
const account = (accountLabel, authoritative, ...others) => ({
  family: 'codex', accountLabel, authoritativeParticipant: key(authoritative), members: [authoritative, ...others].map(key),
});
const codexFamily = (matrix) => matrix.families.find(({ family }) => family === 'codex');

describe('account-scoped matrix', () => {
  it('adds a shared account once however many participants report it', () => {
    const matrix = buildNativeUsageMatrix({
      reports: [report('host-a'), report('host-b', { usage: usage(101) }), report('host-c')],
      selections: [account('acct-a', 'host-a', 'host-b', 'host-c')],
    });
    expect(codexFamily(matrix)).toMatchObject({
      accounts: [{ accountLabel: 'acct-a', authoritativeParticipant: key('host-a'), identityBasis: 'operator-selection', status: 'available', totals: { lifetimeTokens: 100 } }],
      unresolvedParticipants: [],
      merge: { status: 'merged', accountCount: 1, totals: { lifetimeTokens: 100 } },
    });
  });

  it('keeps distinct accounts distinct even when their totals match', () => {
    const matrix = buildNativeUsageMatrix({
      reports: [report('host-a'), report('host-b')],
      selections: [account('acct-a', 'host-a'), account('acct-b', 'host-b')],
    });
    expect(codexFamily(matrix).accounts.map(({ accountLabel }) => accountLabel)).toEqual(['acct-a', 'acct-b']);
    expect(codexFamily(matrix).merge).toMatchObject({ status: 'merged', accountCount: 2, totals: { lifetimeTokens: 200 } });
  });

  it('refuses to merge without identity proof, however exactly the totals agree', () => {
    const matrix = buildNativeUsageMatrix({ reports: [report('host-a'), report('host-b')], selections: [] });
    expect(codexFamily(matrix)).toMatchObject({
      accounts: [], unresolvedParticipants: [key('host-a'), key('host-b')].sort(),
      merge: { status: 'refused', reasons: ['participant-account-unresolved'], totals: null },
    });
    const oneUnresolved = buildNativeUsageMatrix({ reports: [report('host-a'), report('host-b')], selections: [account('acct-a', 'host-a')] });
    expect(codexFamily(oneUnresolved).merge).toMatchObject({ status: 'refused', totals: null });
  });

  it('never falls back from a failed authoritative read to another member or to zero', () => {
    const failed = { usage: null, failureCode: 'CODEX_APP_SERVER_TIMEOUT' };
    const matrix = buildNativeUsageMatrix({
      reports: [report('host-a', failed), report('host-b')],
      selections: [account('acct-a', 'host-a', 'host-b')],
    });
    expect(codexFamily(matrix).accounts[0]).toMatchObject({ status: 'unavailable', totals: null, findings: ['refresh-failed'] });
    expect(codexFamily(matrix).merge).toMatchObject({ status: 'refused', reasons: ['authoritative-source-unavailable'], totals: null });
    const unknownLifetime = buildNativeUsageMatrix({ reports: [report('host-a', { usage: { summary: { lifetimeTokens: null }, dailyUsageBuckets: null } })], selections: [account('acct-a', 'host-a')] });
    expect(codexFamily(unknownLifetime).merge).toMatchObject({ status: 'refused', reasons: ['authoritative-source-partial'], totals: null });
  });

  it('does not let an unselected participant with no account source block a merge, or read as zero', () => {
    const absent = { usage: null, failureCode: 'CODEX_RUNTIME_MISSING' };
    const matrix = buildNativeUsageMatrix({ reports: [report('host-a'), report('host-b', absent)], selections: [account('acct-a', 'host-a')] });
    expect(codexFamily(matrix).merge).toMatchObject({ status: 'merged', totals: { lifetimeTokens: 100 } });
    expect(codexFamily(buildNativeUsageMatrix({ reports: [report('host-b', absent)], selections: [] })).merge).toEqual({ status: 'empty', reasons: [], accountCount: 0, totals: null });
    const missingAuthority = buildNativeUsageMatrix({ reports: [report('host-b')], selections: [account('acct-a', 'host-a', 'host-b')] });
    expect(codexFamily(missingAuthority).accounts[0]).toMatchObject({ status: 'unavailable', membersWithoutReport: [key('host-a')], totals: null });
    expect(codexFamily(missingAuthority).merge.reasons).toEqual(['authoritative-report-missing']);
  });

  it.each([
    ['a changed account context', { accountBefore: signedIn('team'), accountAfter: signedIn('team') }, 'account-context-changed'],
    ['a lifetime that went backwards', { usage: usage(50, [['2026-02-01', 100]]) }, 'lifetime-regressed'],
    ['restated history', { usage: usage(200, [['2026-02-02', 200]]) }, 'history-restated'],
  ])('refuses %s across captures until the operator drops the older report', (_name, change, reason) => {
    const older = report('host-a');
    const newer = report('host-a', change, '2026-03-02T00:00:00.000Z');
    const selections = [account('acct-a', 'host-a')];
    const matrix = buildNativeUsageMatrix({ reports: [older, newer], selections });
    expect(codexFamily(matrix).merge.status).toBe('refused');
    expect(codexFamily(matrix).merge.reasons).toContain(reason);
    expect(matrix.participants[0]).toMatchObject({ reportHash: newer.contentHash, comparedReports: 2 });
    expect(codexFamily(buildNativeUsageMatrix({ reports: [newer], selections })).merge.reasons).not.toContain(reason);
  });

  it('accepts growth across captures and collapses a repeated report', () => {
    const older = report('host-a');
    const newer = report('host-a', { usage: usage(250, [['2026-02-01', 100], ['2026-02-02', 150]]) }, '2026-03-02T00:00:00.000Z');
    const matrix = buildNativeUsageMatrix({ reports: [older, newer, older], selections: [account('acct-a', 'host-a')] });
    expect(codexFamily(matrix).merge).toMatchObject({ status: 'merged', totals: { lifetimeTokens: 250 } });
    expect(matrix.participants[0].comparedReports).toBe(2);
  });
});

describe('machine-scoped sources', () => {
  it('keeps one row per participant and never combines retained subsets', () => {
    const matrix = buildNativeUsageMatrix({ reports: [report('host-a'), report('host-b')], selections: [] });
    for (const name of ['agy', 'claude', 'grok']) {
      const family = matrix.families.find((row) => row.family === name);
      expect(family.sources).toHaveLength(2);
      expect(family.merge).toMatchObject({ status: 'refused', reasons: ['machine-subset-disjointness-unverified'], totals: null });
    }
  });
});

describe('report and selection integrity', () => {
  it('refuses a tampered report, an unexpected field, an unknown contract version and conflicting captures', () => {
    const valid = report('host-a');
    const tampered = structuredClone(valid);
    tampered.providers.find(({ family }) => family === 'codex').totals.lifetimeTokens = 1;
    // Correctly hashed, so only the strict schema can stop a private field travelling.
    const { contentHash: _dropped, ...body } = structuredClone(valid);
    const withPath = { ...body, sourcePath: '/Users/example/.codex' };
    const privateField = { ...withPath, contentHash: createHash('sha256').update(canonicalStringify(withPath)).digest('hex') };
    const newerContract = { ...structuredClone(valid), contractVersion: 99 };
    for (const bad of [tampered, privateField, newerContract]) {
      const matrix = buildNativeUsageMatrix({ reports: [bad], selections: [] });
      expect(matrix.participants).toEqual([]);
      expect(codexFamily(matrix).merge).toMatchObject({ status: 'refused', reasons: ['report-invalid'], totals: null });
    }
    const conflict = buildNativeUsageMatrix({ reports: [valid, report('host-a', { usage: usage(150, [['2026-02-01', 150]]) })], selections: [account('acct-a', 'host-a')] });
    expect(codexFamily(conflict).merge.reasons).toContain('conflicting-reports');
  });

  it.each([
    ['an email pasted as a label', [{ ...account('acct-a', 'host-a'), accountLabel: 'alice@example.com' }]],
    ['an authority outside the members', [{ ...account('acct-a', 'host-a'), members: [key('host-b')] }]],
    ['one participant in two accounts', [account('acct-a', 'host-a'), account('acct-b', 'host-b', 'host-a')]],
    ['a repeated label', [account('acct-a', 'host-a'), account('acct-a', 'host-b')]],
    ['a machine-scoped source', [{ ...account('acct-a', 'host-a'), family: 'claude' }]],
    ['a raw instance id', [{ ...account('acct-a', 'host-a'), authoritativeParticipant: 'host-a', members: ['host-a'] }]],
  ])('rejects %s, and the matrix refuses it from a stored setting', (_name, selections) => {
    expect(nativeUsageAccountSelectionsSchema.safeParse(selections).success).toBe(false);
    const matrix = buildNativeUsageMatrix({ reports: [report('host-a'), report('host-b')], selections });
    expect(codexFamily(matrix)).toMatchObject({ accounts: [], merge: { status: 'refused', totals: null } });
    expect(codexFamily(matrix).merge.reasons).toContain('selections-invalid');
  });
});

describe('reproducible projection', () => {
  it('is byte-identical regardless of input order and hashes its own content', () => {
    const reports = [report('host-a'), report('host-b'), report('host-c', { usage: null, failureCode: 'CODEX_APP_SERVER_TIMEOUT' })];
    const selections = [account('acct-a', 'host-a', 'host-c'), account('acct-b', 'host-b')];
    const first = buildNativeUsageMatrix({ reports, selections });
    const second = buildNativeUsageMatrix({ reports: [...reports].reverse(), selections });
    expect(nativeUsageCanonicalJson(second)).toBe(nativeUsageCanonicalJson(first));
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.selectionsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(buildNativeUsageMatrix({ reports: reports.slice(0, 2), selections }).contentHash).not.toBe(first.contentHash);
    // Two reports claiming one capture instant still resolve the same way in either order.
    const clash = [report('host-a'), report('host-a', { usage: usage(150, [['2026-02-01', 150]]) })];
    expect(nativeUsageCanonicalJson(buildNativeUsageMatrix({ reports: [...clash].reverse(), selections })))
      .toBe(nativeUsageCanonicalJson(buildNativeUsageMatrix({ reports: clash, selections })));
  });

  it('summarizes refusals without full identifiers or invented totals', () => {
    const matrix = buildNativeUsageMatrix({ reports: [report('host-a')], selections: [] });
    const summary = formatNativeUsageMatrixSummary(matrix);
    expect(summary).toContain('codex: refused, no combined total (participant-account-unresolved)');
    expect(summary).not.toContain(key('host-a'));
  });
});

const digest = (value) => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const hashReport = ({ contentHash: _discard, ...body }) => {
  const updated = { ...body, evidenceHash: digest(body.providers) };
  return { ...updated, contentHash: digest(updated) };
};
const message = (name, values = [10, 20, 3, 5], overrides = {}) => ({
  recordKey: digest(name), requestKey: digest(`request-${name}`), values,
  final: true, conflict: false, inconsistent: false, at: '2026-02-01T00:00:00.000Z', ...overrides,
});
const retainedReport = (host, records, overrides = {}) => report(host, {}, undefined, { claude: {
  ...missingSource, status: 'available', summary: { totalTokens: 999999, tokensIn: 999999, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  coverage: { ...missingSource.coverage, records: records.length, measuredRecords: records.length, missingSource: false, ...overrides.coverage },
  recordProjection: { version: 1, identityScheme: 'sha256-native-record/1', truncated: false, records, ...overrides.recordProjection },
} });
const retainedAccount = (accountLabel, ...hosts) => ({ family: 'claude', accountLabel, historyScope: 'operator-confirmed-retained-history', members: hosts.map(key) });
const claudeFamily = (matrix) => matrix.families.find(({ family }) => family === 'claude');

describe('versioned retained-history union', () => {
  it('unions copied messages and compatible stream finals across three participants without summing their aggregates', () => {
    const reports = [
      retainedReport('host-a', [message('shared'), message('a', [1, 2, 0, 0])]),
      retainedReport('host-b', [message('shared', [10, 2, 3, 5], { final: false }), message('b', [4, 5, 0, 0])]),
      retainedReport('host-c', [message('shared')]),
    ];
    const selections = [account('acct-a', 'host-a', 'host-b', 'host-c'), retainedAccount('acct-a', 'host-a', 'host-b', 'host-c')];
    const matrix = buildNativeUsageMatrix({ reports, selections });
    expect(codexFamily(matrix).merge).toMatchObject({ status: 'merged', totals: { lifetimeTokens: 100 } });
    expect(claudeFamily(matrix)).toMatchObject({
      scope: 'selected-account-retained-records',
      merge: { status: 'partial', completeness: 'unknown', totals: { totalTokens: 50, tokensIn: 15, tokensOut: 27, cacheReadTokens: 3, cacheWriteTokens: 5 } },
      accounts: [{ completeness: 'unknown', coverage: { uniqueRecords: 3, measuredRecords: 3, duplicateRecords: 2, excludedRecords: 0 }, cost: { estimatedApiEquivalentUsd: null, actualSpendUsd: null } }],
    });
    expect(nativeUsageCanonicalJson(buildNativeUsageMatrix({ reports: [...reports].reverse(), selections }))).toBe(nativeUsageCanonicalJson(matrix));
    expect(formatNativeUsageMatrixSummary(matrix)).toContain('50 retained tokens (completeness unknown)');
    for (const family of ['agy', 'grok']) expect(matrix.families.find((row) => row.family === family).merge).toMatchObject({ status: 'refused', totals: null });
  });

  it('preserves conflict tombstones and excludes inconsistent, unfinished, undated and conflicting cross-host records', () => {
    const first = [message('good'), message('conflict'), message('request'), message('final'), message('bad'), message('unfinished', undefined, { final: false }), message('undated', undefined, { at: null })];
    const second = [
      message('conflict', [null, null, null, null], { conflict: true, final: false, requestKey: null }),
      message('request', undefined, { requestKey: digest('different') }),
      message('final', [10, 21, 3, 5]), message('bad', undefined, { inconsistent: true }),
    ];
    const matrix = buildNativeUsageMatrix({ reports: [retainedReport('host-a', first), retainedReport('host-b', second)], selections: [retainedAccount('acct-a', 'host-a', 'host-b')] });
    expect(claudeFamily(matrix).accounts[0]).toMatchObject({
      coverage: { uniqueRecords: 7, measuredRecords: 1, excludedRecords: 6, excluded: { 'conflicting-records': 4, 'unfinalized-records': 1, 'undated-records': 1 } },
      totals: { totalTokens: 38 }, records: [message('good')],
    });
  });

  it('accepts v1 account snapshots but refuses a retained union without projections, including mixed-version members', () => {
    const legacy = retainedReport('host-a', [message('a')]);
    legacy.contractVersion = 1;
    legacy.providers.forEach((provider) => { delete provider.recordProjection; delete provider.nativeUsageCoverage; });
    const matrix = buildNativeUsageMatrix({ reports: [hashReport(legacy), retainedReport('host-b', [message('b')])], selections: [account('acct-a', 'host-a', 'host-b'), retainedAccount('acct-a', 'host-a', 'host-b')] });
    expect(matrix.participants).toHaveLength(2);
    expect(codexFamily(matrix).merge.status).toBe('merged');
    expect(claudeFamily(matrix).merge).toMatchObject({ status: 'refused', reasons: ['record-projection-unavailable'], totals: null });
    expect(claudeFamily(matrix).accounts[0]).toMatchObject({ status: 'refused', totals: null, records: [] });
  });

  it('reports capped sources as partial and refuses missing, truncated or ungrouped input rather than inventing zero', () => {
    const capped = retainedReport('host-a', [message('a')], { coverage: { capped: true, stoppedEarly: true } });
    const selection = retainedAccount('acct-a', 'host-a');
    const partial = claudeFamily(buildNativeUsageMatrix({ reports: [capped], selections: [selection] }));
    expect(partial.merge).toMatchObject({ status: 'partial', completeness: 'unknown', totals: { totalTokens: 38 } });
    expect(partial.accounts[0].findings).toContain('scan-capped');
    const cases = [
      [[capped], [retainedAccount('acct-a', 'host-a', 'host-b')], 'member-report-missing'],
      [[capped, retainedReport('host-b', [message('b')])], [selection], 'participant-account-unresolved'],
      [[retainedReport('host-a', [message('a')], { recordProjection: { truncated: true } })], [selection], 'record-projection-truncated'],
      [[retainedReport('host-a', [])], [selection], 'no-verified-retained-records'],
    ];
    for (const [reports, selections, reason] of cases) {
      const result = claudeFamily(buildNativeUsageMatrix({ reports, selections }));
      expect(result.merge).toMatchObject({ status: 'refused', totals: null });
      expect(result.merge.reasons).toContain(reason);
    }
  });

  it('keeps separate accounts separate and refuses a record claimed by more than one account', () => {
    const selections = [retainedAccount('acct-a', 'host-a'), retainedAccount('acct-b', 'host-b')];
    const distinct = claudeFamily(buildNativeUsageMatrix({ reports: [retainedReport('host-a', [message('a')]), retainedReport('host-b', [message('b')])], selections }));
    expect(distinct.merge).toMatchObject({ status: 'partial', accountCount: 2, totals: { totalTokens: 76 } });
    const copied = claudeFamily(buildNativeUsageMatrix({ reports: [retainedReport('host-a', [message('a')]), retainedReport('host-b', [message('a')])], selections }));
    expect(copied.merge).toMatchObject({ status: 'refused', reasons: ['record-in-multiple-accounts'], totals: null });
    expect(nativeUsageAccountSelectionsSchema.safeParse([{ family: 'claude', accountLabel: 'acct-a', members: [key('host-a')] }]).success).toBe(false);
  });

  it('refuses overflow, malformed projected evidence and unsupported identities even when hashes are recomputed', () => {
    const selections = [retainedAccount('acct-a', 'host-a')];
    const overflow = retainedReport('host-a', [message('a', [Number.MAX_SAFE_INTEGER, 1, 0, 0])]);
    expect(claudeFamily(buildNativeUsageMatrix({ reports: [overflow], selections })).merge).toMatchObject({ status: 'refused', totals: null });
    const mixedOverflow = buildNativeUsageMatrix({ reports: [overflow, retainedReport('host-b', [message('b')])], selections: [...selections, retainedAccount('acct-b', 'host-b')] });
    expect(claudeFamily(mixedOverflow).merge).toMatchObject({ status: 'refused', reasons: ['counter-overflow'], totals: null });
    const valid = retainedReport('host-a', [message('a')]);
    const edits = [
      (entry) => { entry.recordProjection.records[0].prompt = 'private'; },
      (entry) => { entry.recordProjection.version = 2; },
      (entry) => { entry.recordProjection.records.push(entry.recordProjection.records[0]); },
      (entry) => { entry.recordProjection.records[0].recordKey = 'raw-id'; },
      (entry) => { entry.recordProjection.records[0].values[0] = Number.MAX_SAFE_INTEGER + 1; },
    ];
    for (const edit of edits) {
      const invalid = structuredClone(valid);
      edit(invalid.providers.find(({ family }) => family === 'claude'));
      expect(buildNativeUsageMatrix({ reports: [hashReport(invalid)], selections }).participants).toEqual([]);
    }
  });
});
