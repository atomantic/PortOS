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
const report = (instanceId, codex = {}, capturedAt = '2026-03-01T00:00:00.000Z') => buildNativeUsageReport({
  instanceId, capturedAt, scanLimits: LIMITS,
  transcripts: { agy: missingSource, claude: missingSource, grok: missingSource },
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
    const newerContract = { ...structuredClone(valid), contractVersion: 2 };
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
