import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalStringify } from '../lib/objects.js';
import { buildNativeUsageReport, buildNativeUsageRollupReport, nativeUsageParticipantKey, nativeUsageReportSchema, nativeUsageSelectionRevision } from '../lib/nativeUsageContract.js';
import { buildNativeUsageRollup, claudeModelEvidence } from '../lib/nativeUsageRollups.js';

vi.mock('./settings.js', async () => ({ settingsEvents: new (await import('node:events')).EventEmitter() }));
import { settingsEvents } from './settings.js';

vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn(async () => 'local'), loadData: vi.fn() }));
vi.mock('./nativeUsageReport.js', () => ({ captureDashboardNativeUsageReport: vi.fn(), getNativeUsageAccountSelections: vi.fn(), NATIVE_USAGE_DASHBOARD_LIMITS: {} }));
vi.mock('./nativeUsagePeer.js', () => ({ readNativeUsagePeerReport: vi.fn(), revalidateNativeUsagePeerReport: vi.fn() }));
import { loadData } from './instanceIdentity.js';
import { captureDashboardNativeUsageReport, getNativeUsageAccountSelections } from './nativeUsageReport.js';
import { readNativeUsagePeerReport, revalidateNativeUsagePeerReport } from './nativeUsagePeer.js';
import { getNativeUsageMatrix } from './nativeUsageMatrix.js';

const key = nativeUsageParticipantKey;
const NOW = '2026-11-06T12:00:00.000Z';
const peer = (instanceId, extra = {}) => ({ id: `registry-${instanceId}`, instanceId, enabled: true,
  address: 'private-host', auth: { password: 'private-password' }, syncSecret: 'private-secret'.repeat(4),
  directions: ['outbound'], syncEnabled: false, syncCategories: { usage: true }, ...extra });
const digest = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const selected = (members = ['local', 'peer']) => ['claude', 'grok', 'agy', 'codex'].map(family => ({
  family, accountLabel: 'subscription', members: members.map(key),
  ...(family === 'codex' ? { authoritativeParticipant: key('local') } : { historyScope: 'operator-confirmed-retained-history' }),
}));
const family = (matrix, name) => matrix.families.find(row => row.family === name);
const coverage = {
  files: 1, records: 1, measuredRecords: 1, missingUsageRecords: 0, missingIdentityRecords: 0, duplicateRecords: 0,
  conflictingRecords: 0, invalidLines: 0, undatedRecords: 0, unreadableFiles: 0, skippedLinks: 0, missingSource: false,
  capped: false, stoppedEarly: false, oversizedLines: 0, streamingSupersededRecords: 0, unfinalizedRecords: 0,
  fieldInconsistentRecords: 0, runtimeVersions: [], steps: null, cacheOverlap: null, costTickRecords: null,
  firstObservedAt: NOW, lastObservedAt: NOW,
};
const reportInput = (instanceId, transcripts) => ({ instanceId, capturedAt: NOW,
  codexEvidence: { accountBefore: { status: 'read', account: { authMethod: 'chatgpt', planType: 'pro' } },
    accountAfter: { status: 'read', account: { authMethod: 'chatgpt', planType: 'pro' } },
    usage: { summary: { lifetimeTokens: 100 }, dailyUsageBuckets: [{ startDate: '2026-11-05', tokens: 100 }] } },
  transcripts, scanLimits: { bytes: 1000, lineBytes: 1000, entries: 100, records: 100, milliseconds: 1000, depth: 8 },
});
const report = instanceId => buildNativeUsageRollupReport(reportInput(instanceId, {
  claude: { coverage, status: 'partial', rollup: buildNativeUsageRollup('claude', [{ at: NOW, values: [10, 5, 3, 2], evidence: claudeModelEvidence('example-model') }]) },
  grok: { coverage, status: 'partial', rollup: buildNativeUsageRollup('grok', [{ at: NOW, values: [10, 5, 3, 0, 2, 15, 1], evidence: { kind: 'attributed', rows: [['example-model', 10, 5, 3, 0, 2, 15, 1]] } }]) },
  agy: { coverage, status: 'partial', rollup: buildNativeUsageRollup('agy', [{ at: NOW, values: [10, 5, 30, 0, 3, 2] }]) },
}));
// What a peer that has not upgraded sends: machine totals and record lists, with no models.
function olderPeerReport(instanceId, identity = 'a', conflict = false) {
  const claudeTotals = { totalTokens: 20, tokensIn: 10, tokensOut: 5, cacheReadTokens: 3, cacheWriteTokens: 2 };
  const base = buildNativeUsageReport(reportInput(instanceId, {
    claude: { coverage, status: 'partial', summary: claudeTotals },
    grok: { coverage, status: 'partial', summary: { ...claudeTotals, totalTokens: 15, cacheWriteTokens: 0 } },
    agy: { coverage, status: 'partial', summary: { totalTokens: null, tokensIn: 10, tokensOut: 5, cacheReadTokens: 30, cacheWriteTokens: 0, thinkingOutputTokens: 3, responseOutputTokens: 2 } },
  }));
  const providers = base.providers.map(provider => {
    const recordKey = identity.repeat(64);
    if (provider.family === 'claude') return { ...provider, recordProjection: { version: 1, identityScheme: 'sha256-native-record/1', truncated: false,
      records: [{ recordKey, requestKey: 'e'.repeat(64), values: [10, 5, 3, 2], final: true, conflict, inconsistent: false, at: NOW }] } };
    if (provider.family === 'grok') return { ...provider, source: 'grok:persisted-session-usage', validator: 'grok-persisted-turns/1',
      recordProjection: { version: 1, identityScheme: 'sha256-grok-session-turn/1', truncated: false,
        records: [{ recordKey, values: [10, 5, 3, 0, 2, 15, 1], costUsdTicks: 100, costConflict: false, conflict, inconsistent: false, at: NOW }] } };
    if (provider.family === 'agy') return { ...provider, source: 'agy:cli-sqlite-metadata', validator: 'agy-cli-sqlite-v1/1',
      recordProjection: { version: 1, identityScheme: 'sha256-agy-message-response/1', truncated: false,
        records: [{ recordKey, responseKeys: [(identity === 'a' ? 'b' : 'd').repeat(64)], values: [10, 5, 30, 0, 3, 2],
          model: null, apiProvider: null, stepType: 1, at: NOW, completedAt: NOW, final: true, conflict }] } };
    return provider;
  });
  const { contentHash: _discard, ...body } = { ...base, providers, evidenceHash: digest(providers) };
  return nativeUsageReportSchema.parse({ ...body, contentHash: digest(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadData.mockResolvedValue({ self: { instanceId: 'local' }, peers: [peer('peer')] });
  captureDashboardNativeUsageReport.mockImplementation(async () => report('local'));
  getNativeUsageAccountSelections.mockResolvedValue(selected());
  readNativeUsagePeerReport.mockImplementation(async id => report(id));
  revalidateNativeUsagePeerReport.mockResolvedValue(undefined);
});

describe('explicit fleet native matrix', () => {
  it('refuses a changed selection during final peer validation, then reopens with its current revision', async () => {
    let release;
    revalidateNativeUsagePeerReport.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = getNativeUsageMatrix({ scope: 'fleet' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const changed = selected(['local']).map(selection => ({ ...selection, accountLabel: 'new-selection' }));
    getNativeUsageAccountSelections.mockResolvedValue(changed);
    settingsEvents.emit('settings:updated', { usageNativeAccountSelections: changed });
    const reopened = getNativeUsageMatrix({ scope: 'fleet' });
    expect(reopened).toBe(pending);
    release();
    await expect(reopened).rejects.toThrow('Native usage capture failed');
    const matrix = await getNativeUsageMatrix({ scope: 'fleet' });
    expect(matrix.selectionRevision).toBe(nativeUsageSelectionRevision(changed));
    expect(family(matrix, 'codex').accounts[0].accountLabel).toBe('new-selection');
  });

  it('adds machine totals across three participants and selects Codex once without exposing record identities', async () => {
    loadData.mockResolvedValue({ peers: [peer('peer'), peer('other')] });
    getNativeUsageAccountSelections.mockResolvedValue(selected(['local', 'peer', 'other']));
    const matrix = await getNativeUsageMatrix({ scope: 'fleet' });
    expect(matrix).toMatchObject({ mode: 'read-only', scope: 'configured-peers', peerReports: 'collected', ledgerChanged: false,
      peerCollection: { status: 'complete', requested: 2, received: 2 } });
    expect(matrix.participants).toHaveLength(3);
    expect(family(matrix, 'codex').merge).toMatchObject({ status: 'merged', totals: { lifetimeTokens: 100 } });
    for (const [name, total] of [['claude', 60], ['grok', 45], ['agy', null]]) {
      expect(family(matrix, name)).toMatchObject({ scope: 'machine-rollups', merge: { status: 'partial', totals: { totalTokens: total } },
        accounts: [{ totals: { totalTokens: total }, membersWithoutReport: [] }] });
    }
    expect(family(matrix, 'agy').merge.totals).toMatchObject({ tokensIn: 30, tokensOut: 15, cacheReadTokens: 90, thinkingOutputTokens: 9, responseOutputTokens: 6 });
    expect(family(matrix, 'claude').merge.modelTotals).toEqual([{ kind: 'model', key: 'example-model',
      counters: { tokensIn: 30, tokensOut: 15, cacheReadTokens: 9, cacheWriteTokens: 6, totalTokens: 60 } }]);
    expect(family(matrix, 'agy').merge.modelTotals).toMatchObject([{ kind: 'unknown', key: 'model-unverified' }]);
    const text = JSON.stringify(matrix);
    for (const forbidden of ['private-', 'recordProjection', 'recordKey', 'requestKey', 'responseKeys', 'projectedRecords', 'a'.repeat(64)]) expect(text).not.toContain(forbidden);
    expect(readNativeUsagePeerReport).toHaveBeenCalledTimes(2);
    expect(revalidateNativeUsagePeerReport).toHaveBeenCalledTimes(2);
  });

  it('keeps showing a v4 peer\'s totals, with its model attribution unknown', async () => {
    readNativeUsagePeerReport.mockResolvedValueOnce(olderPeerReport('peer'));
    const matrix = await getNativeUsageMatrix({ scope: 'fleet' });
    expect(matrix.contractVersion).toBe(5);
    expect(family(matrix, 'claude').merge).toMatchObject({ status: 'partial', totals: { totalTokens: 40, tokensIn: 20 } });
    expect(family(matrix, 'claude').merge.modelTotals.map(({ kind, key, counters }) => [kind, key, counters.totalTokens])).toEqual([
      ['model', 'example-model', 20], ['unknown', 'report-without-model-capability', 20]]);
    expect(family(matrix, 'agy').merge.modelTotals.find(({ key }) => key === 'report-without-model-capability').counters.totalTokens).toBeNull();
    expect(family(matrix, 'grok').merge.modelTotals.find(({ kind }) => kind === 'model').incompleteRecords).toBe(0);
    // A field the older report lacks is unknown for the sum, never counted as its zero.
    expect(family(matrix, 'grok').merge.totals).toEqual({ totalTokens: 30, tokensIn: 20, tokensOut: 10, cacheReadTokens: 6, cacheWriteTokens: 0 });
    expect(JSON.stringify(matrix)).not.toContain('recordKey');
  });

  it('does not reconcile records between machines: selected accounts sum their own members', async () => {
    readNativeUsagePeerReport.mockResolvedValueOnce(olderPeerReport('peer', 'a', true));
    const conflict = await getNativeUsageMatrix({ scope: 'fleet' });
    for (const name of ['claude', 'grok']) expect(family(conflict, name).merge.status).toBe('partial');
    const separate = selected(['local']).concat(selected(['peer']).map(value => ({ ...value, accountLabel: 'second',
      ...(value.family === 'codex' ? { authoritativeParticipant: key('peer') } : {}) })));
    getNativeUsageAccountSelections.mockResolvedValueOnce(separate);
    const accounts = await getNativeUsageMatrix({ scope: 'fleet' });
    expect(family(accounts, 'codex').merge.totals.lifetimeTokens).toBe(200);
    for (const [name, total] of [['claude', 40], ['grok', 30]]) {
      const row = family(accounts, name);
      expect(row.merge).toMatchObject({ status: 'partial', accountCount: 2, totals: { totalTokens: total } });
      expect(row.accounts.map(account => [account.accountLabel, account.totals.totalTokens])).toEqual([['second', total / 2], ['subscription', total / 2]]);
    }
  });

  it('distinguishes failed, stale, oversized and unverified peers without retaining prior successes or leaking errors', async () => {
    for (const [code, status] of [['NATIVE_USAGE_PEER_UNAVAILABLE', 'unavailable'], ['NATIVE_USAGE_PEER_STALE', 'stale'],
      ['NATIVE_USAGE_PEER_REPORT_TOO_LARGE', 'too-large'], ['NATIVE_USAGE_PEER_UNVERIFIED', 'invalid']]) {
      readNativeUsagePeerReport.mockRejectedValueOnce(Object.assign(new Error('private-peer-token'), { code }));
      const matrix = await getNativeUsageMatrix({ scope: 'fleet' });
      expect(matrix.peerCollection).toMatchObject({ status: 'partial', received: 0, peers: [{ status, capturedAt: null }] });
      // Local machines still count; a missing report is named and never treated as zero.
      expect(family(matrix, 'claude')).toMatchObject({ merge: { status: 'partial', totals: { totalTokens: 20 } },
        accounts: [{ membersWithoutReport: [key('peer')], findings: expect.arrayContaining(['member-report-missing']) }] });
      expect(JSON.stringify(matrix)).not.toContain('private-peer-token');
    }
    const recovered = await getNativeUsageMatrix({ scope: 'fleet' });
    expect(recovered.peerCollection.received).toBe(1);
    revalidateNativeUsagePeerReport.mockRejectedValueOnce(Object.assign(new Error('private revocation'), { code: 'NATIVE_USAGE_PEER_FORBIDDEN' }));
    const revoked = await getNativeUsageMatrix({ scope: 'fleet' });
    expect(revoked.peerCollection).toMatchObject({ received: 0, peers: [{ status: 'forbidden' }] });
    expect(family(revoked, 'grok').merge.totals.totalTokens).toBe(15);
  });

  it('never contacts disabled, unpaired, inbound-only or category-disabled peers and rejects duplicate identities', async () => {
    loadData.mockResolvedValue({ peers: [peer('disabled', { enabled: false }), peer('unpaired', { syncSecret: undefined }),
      peer('inbound', { directions: ['inbound'] }), peer('off', { syncCategories: { usage: false } }),
      peer('duplicate'), peer('duplicate'), peer('local'), peer('unknown'), null] });
    const matrix = await getNativeUsageMatrix({ scope: 'fleet' });
    expect(readNativeUsagePeerReport).not.toHaveBeenCalled();
    expect(matrix.peerCollection.peers.map(row => row.status)).toEqual(expect.arrayContaining(['disabled', 'unpaired', 'usage-disabled', 'duplicate-identity', 'identity-unknown', 'not-configured']));
    expect(family(matrix, 'claude').merge.totals.totalTokens).toBe(20);
    loadData.mockRejectedValueOnce(new Error('private registry path'));
    expect((await getNativeUsageMatrix({ scope: 'fleet' })).peerCollection).toMatchObject({ status: 'unavailable', findings: ['peer-inventory-unavailable'] });
  });

  it('drops a fast peer revoked while the local capture is still pending', async () => {
    let completeLocal;
    captureDashboardNativeUsageReport.mockImplementationOnce(() => new Promise(resolve => { completeLocal = resolve; }));
    const pending = getNativeUsageMatrix({ scope: 'fleet' });
    await vi.waitFor(() => expect(readNativeUsagePeerReport).toHaveBeenCalledTimes(1));
    expect(revalidateNativeUsagePeerReport).not.toHaveBeenCalled();
    revalidateNativeUsagePeerReport.mockRejectedValueOnce(Object.assign(new Error('revoked during local capture'), { code: 'NATIVE_USAGE_PEER_FORBIDDEN' }));
    completeLocal(report('local'));
    const matrix = await pending;
    expect(matrix.participants).toHaveLength(1);
    expect(matrix.peerCollection).toMatchObject({ status: 'partial', received: 0, peers: [{ status: 'forbidden' }] });
    expect(family(matrix, 'claude').merge.totals.totalTokens).toBe(20);
  });

  it('refuses an old settings read that settles after a newer selection event', async () => {
    let releaseSettings;
    getNativeUsageAccountSelections.mockImplementationOnce(() => new Promise(resolve => { releaseSettings = resolve; }));
    const pending = getNativeUsageMatrix({ scope: 'fleet' });
    await vi.waitFor(() => expect(releaseSettings).toBeTypeOf('function'));
    const changed = selected().map(selection => ({ ...selection, accountLabel: 'newer-selection' }));
    settingsEvents.emit('settings:updated', { usageNativeAccountSelections: changed });
    releaseSettings(selected());
    await expect(pending).rejects.toThrow('Native usage capture failed');
  });

  it('revalidates peer authority after a delayed settings read before returning any selected totals', async () => {
    let releaseSettings;
    getNativeUsageAccountSelections.mockImplementationOnce(() => new Promise(resolve => { releaseSettings = resolve; }));
    const pending = getNativeUsageMatrix({ scope: 'fleet' });
    await vi.waitFor(() => expect(releaseSettings).toBeTypeOf('function'));
    expect(revalidateNativeUsagePeerReport).not.toHaveBeenCalled();
    revalidateNativeUsagePeerReport.mockRejectedValueOnce(Object.assign(new Error('revoked while settings were read'), { code: 'NATIVE_USAGE_PEER_FORBIDDEN' }));
    releaseSettings(selected());
    const matrix = await pending;
    expect(matrix.peerCollection).toMatchObject({ received: 0, peers: [{ status: 'forbidden' }] });
    expect(family(matrix, 'claude').merge.totals.totalTokens).toBe(20);
  });

  it('caps peer fanout and concurrency, coalesces one scope only, and reads current selections after collection', async () => {
    loadData.mockResolvedValue({ peers: Array.from({ length: 70 }, (_, i) => peer(`peer-${i}`)) });
    const pending = [];
    readNativeUsagePeerReport.mockImplementation(id => new Promise(resolve => pending.push(() => resolve(report(id)))));
    const first = getNativeUsageMatrix({ scope: 'fleet' });
    expect(getNativeUsageMatrix({ scope: 'fleet' })).toBe(first);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect((await getNativeUsageMatrix()).scope).toBe('local-instance');
    for (let batch = 0; batch < 4; batch++) {
      expect(readNativeUsagePeerReport).toHaveBeenCalledTimes((batch + 1) * 2);
      pending.splice(0).forEach(resolve => resolve());
      if (batch < 3) await vi.waitFor(() => expect(pending).toHaveLength(2));
    }
    getNativeUsageAccountSelections.mockResolvedValueOnce(null);
    const matrix = await first;
    expect(matrix.peerCollection).toMatchObject({ status: 'partial', requested: 8, received: 8, findings: ['peer-inventory-truncated'] });
    expect(matrix.peerCollection.peers.filter(row => row.status === 'peer-limit')).toHaveLength(56);
    expect(matrix.refusals).toContainEqual({ code: 'selections-invalid', family: null, participantKey: null });
    expect(matrix.families.every(row => row.merge.totals === null)).toBe(true);
  });
});
