import { createHash } from 'node:crypto';
import { buildNativeUsageReport, nativeUsageParticipantKey as key } from '../../server/lib/nativeUsageContract.js';
import { buildNativeUsageStage } from '../../server/lib/nativeUsageStaging.js';

export const hosts = ['host-a', 'host-b', 'host-c'];
export const capturedAt = '2026-03-02T00:00:00.000Z';
export const acquiredAt = '2026-03-01T00:00:00.000Z';
export const codeCommit = 'a'.repeat(40);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const missingSource = {
  status: 'unavailable', summary: null,
  coverage: {
    files: 0, records: 0, measuredRecords: 0, missingUsageRecords: 0, missingIdentityRecords: 0, duplicateRecords: 0, conflictingRecords: 0,
    invalidLines: 0, undatedRecords: 0, unreadableFiles: 0, skippedLinks: 0, missingSource: true, capped: false, stoppedEarly: false,
    oversizedLines: 0, streamingSupersededRecords: 0, unfinalizedRecords: 0, fieldInconsistentRecords: 0, runtimeVersions: [], steps: null,
    cacheOverlap: null, costTickRecords: null, firstObservedAt: null, lastObservedAt: null,
  },
};
export const stage = () => buildNativeUsageStage({
  request: { version: 1, participants: hosts.map(key), selections: [{ family: 'codex', accountLabel: 'acct-a', members: hosts.map(key), authoritativeParticipant: key(hosts[0]) }] },
  reports: hosts.map(instanceId => buildNativeUsageReport({ instanceId, capturedAt, transcripts: { agy: missingSource, claude: missingSource, grok: missingSource },
    scanLimits: { bytes: 10000, lineBytes: 1000, entries: 100, records: 100, milliseconds: 1000, depth: 8 },
    codexEvidence: { runtimeVersion: '0.166.0', accountBefore: { status: 'read', account: { authMethod: 'chatgpt', planType: 'plus' } },
      accountAfter: { status: 'read', account: { authMethod: 'chatgpt', planType: 'plus' } },
      usage: { summary: { lifetimeTokens: 100 }, dailyUsageBuckets: [{ startDate: '2026-03-01', tokens: 40 }] } },
  })),
});
export const input = (host = hosts[0], epoch = 'native-rehearsal') => {
  const usageLedger = bytes({ totalTokens: { input: 10, output: 5 }, reconciledRuns: { 'run-a': { codexHighWater: 15 } },
    interactiveScan: { watermarks: { codex: 15 } }, unknownLegacyField: 'preserve without normalization' });
  const peerDigests = bytes({ instances: {}, tombstones: [{ instanceId: 'old-peer', deletedAt: acquiredAt }], selfVersion: { version: 3 } });
  const fingerprints = { usageLedger: hash(usageLedger), peerDigests: hash(peerDigests) };
  const barrierRecord = bytes({ version: 1, state: 'fenced', migrationEpoch: epoch, participants: hosts,
    fingerprints, acquiredAt, fencedAt: acquiredAt, spool: [{ seq: 1, at: acquiredAt, op: 'recordTokens', args: ['provider-a', 5] }],
    deferredRetirements: [], retiredEpochs: ['previous-epoch'], nextSeq: 2 });
  const barrierStatus = bytes({ barrierSchema: 1, state: 'fenced', migrationEpoch: epoch, writersHeld: true,
    participants: hosts.map(instanceId => ({ instanceId, self: instanceId === host, ack: null })),
    fingerprints, acquiredAt, fencedAt: acquiredAt,
    outstanding: { inFlight: { usageLedger: 0, peerDigests: 0 }, retainedWrites: 1, retainedFrom: acquiredAt, retainedTo: acquiredAt, deferredRetirements: 0 } });
  const files = { usageLedger, peerDigests, barrierRecord, barrierStatus };
  const request = { version: 1, participantKey: key(host), capturedAt, codeCommit,
    schemas: { report: 4, stage: 1, barrier: 1, rehearsal: 1 },
    files: Object.fromEntries(Object.entries(files).map(([role, value]) => [role, { sha256: hash(value), bytes: value.length }])) };
  return { stage: stage(), files, request };
};
