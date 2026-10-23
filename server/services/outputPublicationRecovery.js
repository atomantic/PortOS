/** Local operator disposition of legacy publications with no destination identity. */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { BACKUP_ASSET_OWNERS } from '../lib/backupAssetOwners.js';
import { PATHS } from '../lib/paths.js';

const nextStep = 'Inspect the owning workflow records and output/failure evidence; run inspect again after any change. Keep the maintenance hold and original warnings/outcomes.';
const refuse = message => { throw Object.assign(new Error(`${message} ${nextStep}`), { code: 'MAINTENANCE_STALE' }); };
const owners = BACKUP_ASSET_OWNERS.filter(owner => owner.status === 'admitted');
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const operationSchema = z.object({
  id: z.string().uuid(), kind: z.literal('settlement'), resource: z.literal('Output publication'),
  pid: z.number().int().positive(), startedAt: z.string().datetime(), unsettled: z.literal(true),
  uncertaintyStamp: z.string().uuid(),
}).strict();
const holdSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict();
const fileSchema = z.object({
  path: z.string().min(1).max(1024), role: z.enum(['record', 'output', 'failure']),
  note: z.string().trim().min(10).max(1000),
}).strict();
const evidenceSchema = fileSchema.extend({ bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const inspectionFields = {
  ownerId: z.string().refine(id => owners.some(owner => owner.id === id), 'Choose an admitted owner from diagnose.'),
  binding: z.string().trim().min(20).max(2000), reason: z.string().trim().min(10).max(1000),
};
const inspectionSchema = z.object({ ...inspectionFields, files: z.array(fileSchema).min(2).max(16) }).strict();
const requestSchema = z.object({
  version: z.literal(1), hold: holdSchema, operation: operationSchema, ...inspectionFields,
  evidence: z.array(evidenceSchema).min(2).max(16),
}).strict();
const receiptSchema = z.object({
  version: z.literal(1), disposition: z.literal('acknowledged-uncertainty'),
  outputCompleteness: z.literal('unknown'), at: z.string().datetime(), request: requestSchema,
}).strict();
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) refuse(`Invalid recovery evidence: ${result.error.message}`);
  return result.data;
};
const isDead = pid => {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
};

function inventory(gate) {
  const status = gate.status();
  if (status.state === 'unavailable')
    refuse('Maintenance journal is unavailable. Recover its interrupted transaction through the journal recovery procedure first; this command never removes its lock.');
  return { status, operations: gate.operations() };
}

export function diagnoseOutputPublications(operationId, { gate = maintenance } = {}) {
  if (operationId !== undefined) parse(z.string().uuid(), operationId);
  const { status, operations } = inventory(gate);
  const selected = operationId === undefined ? null : operations.find(op => op.id === operationId);
  if (operationId !== undefined && !selected) refuse('Selected reservation is missing. Diagnose the current inventory; only an existing matching receipt may replay it.');
  return { version: 1, maintenance: status, operations, selected, nextStep,
    owners: owners.map(({ id, modules }) => ({ id, modules })) };
}

function fingerprint(file, data, io) {
  const parts = file.path.split('/');
  if (file.path.includes('\\') || parts.some(part => !part || part === '.' || part === '..')
    || parts[0] === 'workflow-maintenance' || parts[0].includes(':'))
    refuse('Evidence must name ordinary data-relative files outside workflow-maintenance.');
  let fd;
  try {
    const path = join(io.realpathSync(data), ...parts);
    if (io.realpathSync(path) !== resolve(path)) refuse('Evidence symlinks are not accepted.');
    // A replaced file may be a FIFO; never block while owning the journal.
    fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const before = io.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_EVIDENCE_BYTES) refuse('Evidence must be regular files, at most 16 MiB in total. Preserve larger artifacts and use bounded owning-service evidence.');
    const raw = io.readFileSync(fd);
    const after = io.fstatSync(fd);
    const current = io.lstatSync(path);
    if (raw.length !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key] || after[key] !== current[key]))
      refuse('Evidence changed while being inspected.');
    return { ...file, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') };
  } catch (error) {
    if (error.code === 'MAINTENANCE_STALE') throw error;
    refuse(`Evidence is missing or unreadable (${error.code ?? 'read failed'}).`);
  } finally { if (fd !== undefined) io.closeSync(fd); }
}

function inspectFiles(files, data, io) {
  if (new Set(files.map(file => file.path)).size !== files.length) refuse('Evidence paths must be distinct.');
  const evidence = files.map(file => fingerprint(file, data, io));
  if (evidence.reduce((sum, file) => sum + file.bytes, 0) > MAX_EVIDENCE_BYTES) refuse('Evidence exceeds 16 MiB; preserve the originals and use bounded owning-service evidence.');
  if (!evidence.some(file => file.role === 'record' && file.bytes > 0)
    || !evidence.some(file => ['output', 'failure'].includes(file.role) && file.bytes > 0))
    refuse('Require a nonempty owner record and nonempty output or failure evidence. Empty output is not proof of saving.');
  return evidence;
}

export function inspectOutputPublication(operationId, input, { gate = maintenance, data = PATHS.data, io = fs } = {}) {
  const spec = parse(inspectionSchema, input);
  const { maintenance: status, selected } = diagnoseOutputPublications(operationId, { gate });
  if (!status.hold) refuse('Begin a normal maintenance hold before inspection.');
  const operation = parse(operationSchema, selected);
  const evidence = inspectFiles(spec.files, data, io);
  return { version: 1, hold: { id: status.hold.id, revision: status.hold.revision },
    operation: { ...selected, ...operation }, ownerId: spec.ownerId, binding: spec.binding, reason: spec.reason, evidence };
}

function syncDirectory(path, io) {
  if (process.platform === 'win32') return;
  const fd = io.openSync(path, 'r');
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}

export function reconcileOutputPublication(input, { confirmDisposition = false, gate = maintenance,
  data = PATHS.data, io = fs, pidDead = isDead } = {}) {
  if (confirmDisposition !== true) refuse('Explicit --confirm-disposition is required; output completeness will remain unknown.');
  const request = parse(requestSchema, input);
  // The admission capability compares the original serialized operation, including key order.
  request.operation = { ...input.operation };
  const receiptPath = join(gate.directory, `publication-${request.operation.id}-${request.operation.uncertaintyStamp}.json`);
  const verify = () => {
    if (!pidDead(request.operation.pid)) refuse('The admitting process is live or its exit is unproved. Recover the owning workflow before disposition.');
    const evidence = inspectFiles(request.evidence.map(({ path, role, note }) => ({ path, role, note })), data, io);
    if (!isDeepStrictEqual(evidence, request.evidence)) refuse('Evidence changed since inspection.');
  };
  const readReceipt = () => {
    let fd, receipt;
    try {
      try {
        fd = io.openSync(receiptPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        const stat = io.fstatSync(fd);
        if (!stat.isFile() || stat.size > 256 * 1024) refuse('The receipt must be a bounded regular file.');
        const raw = io.readFileSync(fd);
        if (raw.length !== stat.size) refuse('The receipt changed while being read.');
        receipt = parse(receiptSchema, JSON.parse(raw.toString('utf8')));
      } catch { refuse('No valid matching receipt exists. Preserve existing evidence and diagnose the reservation; a missing owner cannot create a receipt.'); }
      if (!isDeepStrictEqual(receipt.request, request)) refuse('The existing receipt binds different evidence, reason, hold, or operation.');
      // A receipt-first interrupted write may have linked the file before directory fsync.
      io.fsyncSync(fd);
      syncDirectory(gate.directory, io);
      return receipt;
    } finally { if (fd !== undefined) io.closeSync(fd); }
  };
  try { return gate.reconcilePublicationRefusal({ hold: request.hold, expected: request.operation,
    replay: () => { verify(); return { ...readReceipt(), replayed: true }; },
    publish: () => {
      verify();
      try { io.lstatSync(receiptPath); return readReceipt(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const receipt = { version: 1, disposition: 'acknowledged-uncertainty', outputCompleteness: 'unknown',
        at: new Date().toISOString(), request };
      const pending = `${receiptPath}.${randomUUID()}.pending`;
      const fd = io.openSync(pending, 'wx', 0o600);
      try { io.writeFileSync(fd, JSON.stringify(receipt) + '\n'); io.fsyncSync(fd); } finally { io.closeSync(fd); }
      // No replacement: an existing evidence receipt is authority, never scratch.
      io.linkSync(pending, receiptPath);
      syncDirectory(gate.directory, io);
      io.unlinkSync(pending);
      syncDirectory(gate.directory, io);
      return receipt;
    },
  }); } catch (error) {
    if (error.code === 'MAINTENANCE_STALE' && !error.message.endsWith(nextStep)) refuse(error.message);
    if (error.code === 'MAINTENANCE_UNAVAILABLE')
      throw Object.assign(new Error('Maintenance state needs recovery; ownership remains held. Recover the interrupted journal transaction before replaying this exact request; preserve its receipt and pending evidence.'), { code: error.code });
    throw error;
  }
}
