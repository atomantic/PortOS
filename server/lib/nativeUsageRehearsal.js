/** Offline byte-level backup rehearsal. Never imports the live store or barrier. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { nativeUsageCanonicalJson, nativeUsageParticipantKey, NATIVE_USAGE_CONTRACT_VERSION } from './nativeUsageContract.js';
import { verifyNativeUsageStage } from './nativeUsageStaging.js';

export const NATIVE_USAGE_REHEARSAL_FILES = Object.freeze({
  usageLedger: 'usage.json', peerDigests: 'peer-usage.json',
  barrierRecord: 'usage-cutover-barrier.json', barrierStatus: 'cutover-status.json',
});
export const NATIVE_USAGE_REHEARSAL_MAX_BYTES = 64 * 1024 * 1024;
const ROLES = Object.keys(NATIVE_USAGE_REHEARSAL_FILES);
const STORES = ['usageLedger', 'peerDigests'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = body => ({ ...body, contentHash: digest(nativeUsageCanonicalJson(body)) });
const same = (a, b) => nativeUsageCanonicalJson(a) === nativeUsageCanonicalJson(b);
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const time = z.string().datetime({ precision: 3 }).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const schemas = z.strictObject({ report: z.literal(NATIVE_USAGE_CONTRACT_VERSION), stage: z.literal(1), barrier: z.literal(1), rehearsal: z.literal(1) });
const fingerprint = z.strictObject({ sha256: hex, bytes: z.number().int().min(1).max(NATIVE_USAGE_REHEARSAL_MAX_BYTES) });

export const nativeUsageRehearsalRequestSchema = z.strictObject({
  version: z.literal(1), participantKey: z.string().regex(/^[0-9a-f]{32}$/),
  capturedAt: time, codeCommit: z.string().regex(/^[0-9a-f]{40}$/), schemas,
  files: z.strictObject(Object.fromEntries(ROLES.map(role => [role, fingerprint]))),
});

export function refuseNativeUsageRehearsal(reason) {
  const error = new Error(`Native usage rehearsal refused: ${reason}`);
  error.code = 'NATIVE_USAGE_REHEARSAL_REFUSED';
  throw error;
}
const refuse = refuseNativeUsageRehearsal;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parsedObject = bytes => {
  const result = z.string().transform((value, context) => {
    try { return JSON.parse(value); } catch { context.addIssue({ code: 'custom', message: 'invalid JSON' }); return z.NEVER; }
  }).refine(object).safeParse(bytes.toString('utf8'));
  if (!result.success) refuse('store-json-invalid');
  return result.data;
};

function validateFence(files, request, participants) {
  const record = parsedObject(files.barrierRecord);
  const status = parsedObject(files.barrierStatus);
  const ids = z.array(z.string().min(1).max(256)).min(1).max(64).safeParse(record.participants);
  if (!ids.success || new Set(ids.data).size !== ids.data.length
    || !same(ids.data.map(nativeUsageParticipantKey).sort(), participants)) refuse('participant-set-mismatch');
  if (!Array.isArray(status.participants) || status.participants.some(entry => !object(entry))) refuse('status-invalid');
  const self = status.participants.filter(entry => entry.self === true);
  if (self.length !== 1 || nativeUsageParticipantKey(self[0].instanceId) !== request.participantKey
    || !same(status.participants.map(entry => entry.instanceId).sort(), [...ids.data].sort())) refuse('participant-identity-mismatch');
  if (record.version !== 1 || status.barrierSchema !== request.schemas.barrier) refuse('barrier-schema-mismatch');
  if (record.state !== 'fenced' || status.state !== 'fenced' || status.writersHeld !== true
    || !object(status.outstanding?.inFlight) || STORES.some(role => status.outstanding.inFlight[role] !== 0)
    || Object.values(status.outstanding.inFlight).some(value => value !== 0)) refuse('not-fenced-and-drained');
  if (typeof record.migrationEpoch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(record.migrationEpoch)
    || status.migrationEpoch !== record.migrationEpoch) refuse('epoch-mismatch');
  for (const field of ['acquiredAt', 'fencedAt']) {
    if (!time.safeParse(record[field]).success || record[field] > request.capturedAt || record[field] !== status[field]) refuse('capture-time-mismatch');
  }
  if (record.acquiredAt > record.fencedAt) refuse('capture-time-mismatch');
  if (!object(record.fingerprints) || !same(record.fingerprints, status.fingerprints)
    || STORES.some(role => record.fingerprints[role] !== request.files[role].sha256)) refuse('fence-fingerprint-mismatch');
  if (!Array.isArray(record.spool) || record.spool.some(entry => !object(entry) || !time.safeParse(entry.at).success)
    || status.outstanding.retainedWrites !== record.spool.length
    || status.outstanding.retainedFrom !== (record.spool[0]?.at ?? null)
    || status.outstanding.retainedTo !== (record.spool.at(-1)?.at ?? null)
    || !Array.isArray(record.deferredRetirements)
    || status.outstanding.deferredRetirements !== record.deferredRetirements.length) refuse('retained-evidence-mismatch');
  return { migrationEpoch: record.migrationEpoch, fencedAt: record.fencedAt, retainedWrites: record.spool.length,
    retainedFrom: status.outstanding.retainedFrom, retainedTo: status.outstanding.retainedTo };
}

/** Backs up exact detached copies; JSON readability is NOT runtime-schema validation. */
export function buildNativeUsageBackup({ stage, request, files }) {
  const verified = verifyNativeUsageStage(stage);
  const result = nativeUsageRehearsalRequestSchema.safeParse(request);
  if (!result.success) refuse('request-or-schema-invalid');
  request = result.data;
  if (!verified.manifest.participants.includes(request.participantKey)) refuse('participant-set-mismatch');
  if (!object(files) || !same(Object.keys(files).sort(), [...ROLES].sort())) refuse('file-set-mismatch');
  let totalBytes = 0;
  for (const role of ROLES) {
    const bytes = files[role];
    if (!Buffer.isBuffer(bytes) || bytes.length !== request.files[role].bytes || digest(bytes) !== request.files[role].sha256) refuse('source-fingerprint-mismatch');
    totalBytes += bytes.length;
    parsedObject(bytes);
  }
  if (totalBytes > NATIVE_USAGE_REHEARSAL_MAX_BYTES) refuse('backup-too-large');
  const fence = validateFence(files, request, verified.manifest.participants);
  return stamp({ version: 1, kind: 'native-usage-barrier-store-backup', request,
    manifest: { stageHash: verified.contentHash, sourceReports: verified.manifest.reports,
      participants: verified.manifest.participants, ...fence,
      restoredStores: STORES, evidenceOnly: ['barrierRecord', 'barrierStatus'],
      validation: 'exact-bytes-and-json-readability', fullRecoveryBackup: false, activationReady: false },
    payload: Object.fromEntries(ROLES.map(role => [role, files[role].toString('base64')])),
  });
}

export function verifyNativeUsageBackup(stage, artifact) {
  if (artifact?.version !== 1 || artifact?.kind !== 'native-usage-barrier-store-backup' || !object(artifact.payload)
    || !same(Object.keys(artifact.payload).sort(), [...ROLES].sort())) refuse('backup-invalid');
  const files = Object.fromEntries(ROLES.map(role => {
    const encoded = artifact.payload[role];
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(NATIVE_USAGE_REHEARSAL_MAX_BYTES / 3) * 4) refuse('backup-invalid');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) refuse('backup-invalid');
    return [role, bytes];
  }));
  const rebuilt = buildNativeUsageBackup({ stage, request: artifact.request, files });
  if (!same(rebuilt, artifact)) refuse('backup-mismatch');
  return rebuilt;
}

/** A receipt is evidence only after the CLI rereads both files in its fresh directory. */
export function buildNativeUsageRestoreReceipt(stage, backup, files) {
  const verified = verifyNativeUsageBackup(stage, backup);
  if (!object(files) || !same(Object.keys(files).sort(), [...STORES].sort())) refuse('restore-file-set-mismatch');
  for (const role of STORES) {
    if (!Buffer.isBuffer(files[role]) || digest(files[role]) !== verified.request.files[role].sha256
      || files[role].length !== verified.request.files[role].bytes) refuse('restored-store-mismatch');
  }
  return stamp({ version: 1, kind: 'native-usage-isolated-restore-receipt',
    backupHash: backup.contentHash, stageHash: stage.contentHash, participantKey: backup.request.participantKey,
    codeCommit: backup.request.codeCommit, schemas: backup.request.schemas,
    migrationEpoch: backup.manifest.migrationEpoch, stores: Object.fromEntries(STORES.map(role => [role, backup.request.files[role]])),
    mode: 'isolated-byte-rehearsal', barrierRestored: false, runtimeValidated: false, activationReady: false,
  });
}

/** Every supplied receipt must already have passed the on-disk reread boundary. */
export function buildNativeUsageRehearsalPreflight(stage, backups, receipts) {
  const verified = verifyNativeUsageStage(stage);
  if (!Array.isArray(backups) || !Array.isArray(receipts) || backups.length !== verified.manifest.participants.length
    || receipts.length !== backups.length) refuse('participant-set-mismatch');
  const checked = backups.map(backup => verifyNativeUsageBackup(verified, backup));
  const participants = checked.map(backup => backup.request.participantKey).sort();
  if (!same(participants, verified.manifest.participants)) refuse('participant-set-mismatch');
  if (new Set(checked.map(backup => backup.request.codeCommit)).size !== 1
    || new Set(checked.map(backup => backup.manifest.migrationEpoch)).size !== 1) refuse('code-or-epoch-mismatch');
  const expected = checked.map(backup => buildNativeUsageRestoreReceipt(stage, backup,
    Object.fromEntries(STORES.map(role => [role, Buffer.from(backup.payload[role], 'base64')]))));
  const order = values => [...values].sort((a, b) => a.participantKey.localeCompare(b.participantKey));
  if (!same(order(expected), order(receipts))) refuse('restore-receipt-mismatch');
  return stamp({ version: 1, kind: 'native-usage-rehearsal-preflight', stageHash: verified.contentHash,
    participants, codeCommit: checked[0].request.codeCommit, migrationEpoch: checked[0].manifest.migrationEpoch,
    backups: checked.map(backup => backup.contentHash).sort(), receipts: expected.map(receipt => receipt.contentHash).sort(),
    barrierStoreRehearsalVerified: true, fullRecoveryBackup: false, activationReady: false,
    holdReasons: ['full-store-inventory-not-verified', 'database-and-native-source-restore-not-verified',
      'matched-runtime-restore-not-verified', 'runtime-not-registered', 'live-barrier-not-verified',
      'fenced-interval-not-verified', 'source-freshness-not-verified-at-cutover'],
  });
}
