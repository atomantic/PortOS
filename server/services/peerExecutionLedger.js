/**
 * Receiver-local persistence primitives only. A record is neither a grant nor a
 * launch authorization. No peer route or fixed adapter imports this module yet.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { z } from 'zod';
import { peerAdminIntentSchema, peerAdminActionSchema } from '../lib/peerAdminValidation.js';
import { createPeerExecutionAuthority, executionAuthorityError } from '../lib/peerExecutionAuthority.js';

const uuid = z.string().uuid().toLowerCase();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const positive = integer.positive();
export const peerExecutionBindingSchema = z.object({
  hostInstanceId: uuid, peerInstanceId: uuid, requestId: uuid, grantId: uuid,
  grantGeneration: positive, scope: z.literal('execution-v1'), pairBinding: digest,
  intent: peerAdminIntentSchema, receiverVersion: z.string().min(1).max(100), evidenceDigest: digest,
  executionEpoch: uuid,
}).strict().refine(value => value.hostInstanceId !== value.peerInstanceId);
const states = ['queued', 'draining', 'in-flight', 'awaiting-reconnect', 'succeeded', 'failed', 'uncertain'];
const terminal = state => ['succeeded', 'failed'].includes(state);
const claimSchema = z.object({ id: uuid, revision: positive, fingerprint: digest }).strict();
const receiptSchema = z.object({ outcome: z.enum(['succeeded', 'failed']),
  code: z.string().min(1).max(100).regex(/^[A-Z0-9_]+$/), evidenceDigest: digest.nullable(), executionEpoch: uuid }).strict();
const operationSchema = z.object({
  operationId: uuid, binding: peerExecutionBindingSchema, fingerprint: digest,
  state: z.enum(states), revision: positive, claim: claimSchema.nullable(), receipt: receiptSchema.nullable(),
}).strict().refine(row => row.fingerprint === fingerprint(row.binding))
  .refine(row => terminal(row.state) === Boolean(row.receipt) && (!row.receipt || row.receipt.outcome === row.state));
const floorSchema = z.object({ hostInstanceId: uuid, peerInstanceId: uuid,
  action: peerAdminActionSchema, generation: integer }).strict();
const factSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operation'), value: operationSchema }).strict(),
  z.object({ kind: z.literal('floor'), value: floorSchema }).strict(),
]);
const fingerprint = binding => createHash('sha256').update(JSON.stringify(binding)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 409 }); };
const fromRow = row => {
  const operation = operationSchema.parse({ operationId: row.operation_id, binding: row.binding,
    fingerprint: row.fingerprint, state: row.state, revision: Number(row.revision), claim: row.claim, receipt: row.receipt });
  if (row.host_instance_id !== operation.binding.hostInstanceId || row.peer_instance_id !== operation.binding.peerInstanceId
    || row.request_id !== operation.binding.requestId || row.execution_epoch !== operation.binding.executionEpoch)
    throw executionAuthorityError('Execution consumption identity columns conflict with their immutable binding.');
  return operation;
};
const LOCK_KEY = 90011027;
const ACTIVE_LIMIT = 32;
const PAGE_SIZE = 100;
const MAX_FACT_BYTES = 8192;

/** Inject the guarded db.js query/withTransaction and a fixture or receiver data root. */
export function createPeerExecutionLedger({ db, dataDir, authority = createPeerExecutionAuthority(dataDir), makeId = randomUUID }) {
  const locked = fn => db.withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    return fn(client);
  });
  const initialize = () => locked(async client => {
    if (!authority.read()) {
      const { rows: [row] } = await client.query('SELECT EXISTS(SELECT 1 FROM peer_execution_operations) OR EXISTS(SELECT 1 FROM peer_execution_generation_floors) AS occupied');
      if (row.occupied) throw executionAuthorityError('Existing consumption has no machine authority; reconcile it instead of resetting it.');
      authority.initialize();
    }
    return authority.read();
  });
  const find = async (client, binding) => {
    const { rows: [row] } = await client.query(`SELECT * FROM peer_execution_operations
      WHERE host_instance_id = $1 AND peer_instance_id = $2 AND request_id = $3`,
    [binding.hostInstanceId, binding.peerInstanceId, binding.requestId]);
    return row ? fromRow(row) : null;
  };
  const consume = async raw => {
    const binding = peerExecutionBindingSchema.parse(raw);
    authority.requireReady(binding.executionEpoch);
    return locked(async client => {
      authority.requireReady(binding.executionEpoch); // Also after waiting for the shared writer lock.
      const previous = await find(client, binding);
      if (previous) {
        if (previous.fingerprint !== fingerprint(binding)) fail('PEER_EXECUTION_REPLAY_CONFLICT', 'This authenticated request identity was already consumed with different evidence.');
        return { operation: previous, isNew: false };
      }
      const { rows: [floor] } = await client.query(`SELECT generation FROM peer_execution_generation_floors
        WHERE host_instance_id = $1 AND peer_instance_id = $2 AND action = $3`,
      [binding.hostInstanceId, binding.peerInstanceId, binding.intent.action]);
      if (floor && Number(floor.generation) > binding.grantGeneration)
        fail('PEER_EXECUTION_GENERATION_STALE', 'The execution grant generation was invalidated.');
      const { rows: [count] } = await client.query(`SELECT count(*)::int AS count FROM peer_execution_operations
        WHERE state IN ('queued', 'draining', 'in-flight', 'awaiting-reconnect', 'uncertain')`);
      if (count.count >= ACTIVE_LIMIT) fail('PEER_EXECUTION_QUEUE_FULL', 'Unresolved execution records must settle before accepting more.');
      const { rows: [row] } = await client.query(`INSERT INTO peer_execution_operations
        (operation_id, host_instance_id, peer_instance_id, request_id, fingerprint, binding, execution_epoch, state)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'queued') RETURNING *`,
      [makeId(), binding.hostInstanceId, binding.peerInstanceId, binding.requestId, fingerprint(binding), JSON.stringify(binding), binding.executionEpoch]);
      await client.query(`INSERT INTO peer_execution_generation_floors (host_instance_id, peer_instance_id, action, generation)
        VALUES ($1, $2, $3, $4) ON CONFLICT (host_instance_id, peer_instance_id, action)
        DO UPDATE SET generation = GREATEST(peer_execution_generation_floors.generation, EXCLUDED.generation)`,
      [binding.hostInstanceId, binding.peerInstanceId, binding.intent.action, binding.grantGeneration]);
      authority.requireReady(binding.executionEpoch);
      return { operation: fromRow(row), isNew: true };
    });
  };
  const read = async id => {
    uuid.parse(id);
    const { rows: [row] } = await db.query('SELECT * FROM peer_execution_operations WHERE operation_id = $1', [id]);
    return row ? fromRow(row) : null;
  };
  const advanceGenerationFloor = async raw => {
    const input = floorSchema.extend({ executionEpoch: uuid }).parse(raw);
    authority.requireReady(input.executionEpoch);
    return locked(async client => {
      authority.requireReady(input.executionEpoch);
      const { rows: [row] } = await client.query(`INSERT INTO peer_execution_generation_floors
        (host_instance_id, peer_instance_id, action, generation) VALUES ($1, $2, $3, $4)
        ON CONFLICT (host_instance_id, peer_instance_id, action) DO UPDATE
        SET generation = GREATEST(peer_execution_generation_floors.generation, EXCLUDED.generation) RETURNING generation`,
      [input.hostInstanceId, input.peerInstanceId, input.action, input.generation]);
      authority.requireReady(input.executionEpoch);
      return Number(row.generation);
    });
  };
  // Persistence CAS, not a dispatcher. The future receiver must own and verify
  // the coordinator claim/adapter evidence before calling this internal method.
  const transition = (id, revision, state, { claim = null, receipt = null, authorityEpoch = null } = {}) => {
    uuid.parse(id); positive.parse(revision); z.enum(states).parse(state);
    if (claim) claimSchema.parse(claim);
    if (receipt) receiptSchema.parse(receipt);
    uuid.nullable().parse(authorityEpoch);
    return locked(async client => {
      const { rows: [row] } = await client.query('SELECT * FROM peer_execution_operations WHERE operation_id = $1 FOR UPDATE', [id]);
      if (!row) fail('PEER_EXECUTION_NOT_FOUND', 'The execution operation does not exist.');
      const current = fromRow(row);
      const epoch = authorityEpoch ?? current.binding.executionEpoch;
      authority.requireReady(epoch);
      if (current.revision !== revision) fail('PEER_EXECUTION_STALE', 'Refresh the current operation revision.');
      const allowed = { queued: ['draining', 'failed'], draining: ['in-flight', 'failed', 'uncertain'],
        'in-flight': ['awaiting-reconnect', 'succeeded', 'failed', 'uncertain'],
        'awaiting-reconnect': ['succeeded', 'failed', 'uncertain'], uncertain: ['succeeded', 'failed'], succeeded: [], failed: [] };
      if (!allowed[current.state].includes(state)) fail('PEER_EXECUTION_TRANSITION_REFUSED', 'An operation cannot move backwards or launch again.');
      if (state === 'in-flight' && !claim) fail('PEER_EXECUTION_CLAIM_REQUIRED', 'Persist the exact coordinator ownership before recording a start.');
      if (current.claim && claim && JSON.stringify(current.claim) !== JSON.stringify(claim))
        fail('PEER_EXECUTION_CLAIM_CHANGED', 'A different coordinator owner cannot replace the recorded start.');
      if (terminal(state) && receipt?.executionEpoch !== epoch)
        fail('PEER_EXECUTION_RECEIPT_STALE', 'Terminal evidence must bind the current non-rewound authority epoch.');
      const next = operationSchema.parse({ ...current, state, revision: revision + 1, claim: claim ?? current.claim, receipt });
      const { rows: [updated] } = await client.query(`UPDATE peer_execution_operations
        SET state = $2, revision = $3, claim = $4::jsonb, receipt = $5::jsonb, updated_at = NOW()
        WHERE operation_id = $1 RETURNING *`, [id, next.state, next.revision, JSON.stringify(next.claim), JSON.stringify(next.receipt)]);
      authority.requireReady(epoch);
      return fromRow(updated);
    });
  };
  const list = async ({ after = null, limit = PAGE_SIZE } = {}) => {
    uuid.nullable().parse(after); z.number().int().min(1).max(PAGE_SIZE).parse(limit);
    const { rows } = await db.query(`SELECT * FROM peer_execution_operations
      WHERE ($1::uuid IS NULL OR operation_id > $1) ORDER BY operation_id LIMIT $2`, [after, limit]);
    return rows.map(fromRow);
  };
  const captureRestore = async (client, id, started) => {
      if (started.phase !== 'capturing') return started; // Never recapture a rewound database on retry.
      const pending = `${authority.recoveryPath}.${makeId()}.pending`;
      authority.assertWrite(pending, 'peer execution restore evidence');
      const fd = fs.openSync(pending, 'wx', 0o600);
      const hash = createHash('sha256');
      let count = 0;
      const write = fact => {
        factSchema.parse(fact);
        const bytes = Buffer.from(JSON.stringify(fact) + '\n');
        if (bytes.length > MAX_FACT_BYTES) throw executionAuthorityError('A recovery fact exceeds the bounded record size.');
        fs.writeFileSync(fd, bytes); hash.update(bytes); count++;
      };
      try {
        let after = null;
        for (;;) {
          const { rows } = await client.query(`SELECT * FROM peer_execution_operations
            WHERE ($1::uuid IS NULL OR operation_id > $1) ORDER BY operation_id LIMIT $2`, [after, PAGE_SIZE]);
          for (const row of rows) write({ kind: 'operation', value: fromRow(row) });
          if (rows.length < PAGE_SIZE) break;
          after = rows.at(-1).operation_id;
        }
        let floorAfter = [null, null, null];
        for (;;) {
          const { rows } = await client.query(`SELECT * FROM peer_execution_generation_floors
            WHERE ($1::uuid IS NULL OR (host_instance_id, peer_instance_id, action) > ($1::uuid, $2::uuid, $3::text))
            ORDER BY host_instance_id, peer_instance_id, action LIMIT $4`, [...floorAfter, PAGE_SIZE]);
          for (const row of rows) write({ kind: 'floor', value: { hostInstanceId: row.host_instance_id,
            peerInstanceId: row.peer_instance_id, action: row.action, generation: Number(row.generation) } });
          if (rows.length < PAGE_SIZE) break;
          const last = rows.at(-1);
          floorAfter = [last.host_instance_id, last.peer_instance_id, last.action];
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(pending, authority.recoveryPath);
      if (process.platform !== 'win32') {
        const directory = fs.openSync(dataDir, 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
      return authority.recordSnapshot(id, hash.digest('hex'), count);
  };
  const prepareRestore = id => locked(client => captureRestore(client, id, authority.beginRestore(id)));
  const adoptEmptyRestore = id => locked(async client => {
    uuid.parse(id);
    // Before any file publication/recovery, prove this receiver never had facts
    // in the restored schema. A normal capture can NEVER take this retry path.
    const { rows: [row] } = await client.query('SELECT EXISTS(SELECT 1 FROM peer_execution_operations) OR EXISTS(SELECT 1 FROM peer_execution_generation_floors) AS occupied');
    let current;
    if (!row.occupied) current = authority.recoverEmptyAdoption(id);
    else current = authority.read();
    if (current?.phase === 'ready' && current.settledRecoveryId === id) return current;
    if (current && current.emptyAdoptionId !== id) return current;
    if (row.occupied) throw executionAuthorityError('Legacy empty adoption has unexpected permanent execution facts.');
    return captureRestore(client, id, authority.beginEmptyAdoption(id));
  });
  // Stream twice: authenticate ALL recovery bytes before applying any rows.
  const visitFacts = async visit => {
    const hash = createHash('sha256');
    let buffer = Buffer.alloc(0), count = 0;
    const stream = fs.createReadStream(authority.recoveryPath, { highWaterMark: MAX_FACT_BYTES });
    for await (const chunk of stream) {
      hash.update(chunk); buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        if (newline >= MAX_FACT_BYTES) throw executionAuthorityError('Oversized execution recovery fact.');
        const fact = factSchema.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
        buffer = buffer.subarray(newline + 1); count++;
        if (visit) await visit(fact);
      }
      if (buffer.length >= MAX_FACT_BYTES) throw executionAuthorityError('Oversized execution recovery fact.');
    }
    if (buffer.length) throw executionAuthorityError('Truncated execution recovery evidence.');
    return { digest: hash.digest('hex'), count };
  };
  const reconcileRestore = async id => {
    const record = authority.read();
    if (record?.phase === 'ready' && record.settledRecoveryId === id) return record;
    if (record?.recovery?.id !== id || record.phase !== 'reconciling')
      throw executionAuthorityError('Complete execution recovery capture before reconciling.');
    const proof = await visitFacts();
    if (proof.digest !== record.recovery.digest || proof.count !== record.recovery.count)
      throw executionAuthorityError('Execution recovery evidence is missing or conflicting.');
    const { createMaintenanceAdmission } = await import('../lib/maintenanceAdmission.js');
    const coordinator = createMaintenanceAdmission(dataDir);
    const journal = coordinator.getExclusive();
    const journalIdentity = journal && { id: journal.id, revision: journal.revision, fingerprint: journal.fingerprint };
    const journalOperation = row => ({ operationId: row.operationId, requestId: row.binding.requestId,
      peerInstanceId: row.binding.peerInstanceId, hostInstanceId: row.binding.hostInstanceId,
      grantId: row.binding.grantId, grantGeneration: row.binding.grantGeneration, scope: row.binding.scope,
      pairBinding: row.binding.pairBinding, intent: row.binding.intent, receiverVersion: row.binding.receiverVersion,
      evidenceDigest: row.binding.evidenceDigest });
    const mergeClaims = claims => {
      const present = claims.filter(Boolean);
      if (present.some(claim => claim.id !== present[0].id || claim.fingerprint !== present[0].fingerprint))
        throw executionAuthorityError('Conflicting execution owner evidence cannot be discarded.');
      return present.reduce((newest, claim) => !newest || claim.revision > newest.revision ? claim : newest, null);
    };
    await locked(async client => {
      const replayed = await visitFacts(async fact => {
      if (fact.kind === 'floor') {
        const floor = fact.value;
        await client.query(`INSERT INTO peer_execution_generation_floors (host_instance_id, peer_instance_id, action, generation)
          VALUES ($1, $2, $3, $4) ON CONFLICT (host_instance_id, peer_instance_id, action)
          DO UPDATE SET generation = GREATEST(peer_execution_generation_floors.generation, EXCLUDED.generation)`,
        [floor.hostInstanceId, floor.peerInstanceId, floor.action, floor.generation]);
        return;
      }
      const saved = fact.value;
      const { rows } = await client.query(`SELECT * FROM peer_execution_operations WHERE operation_id = $1 OR
        (host_instance_id = $2 AND peer_instance_id = $3 AND request_id = $4) FOR UPDATE`,
      [saved.operationId, saved.binding.hostInstanceId, saved.binding.peerInstanceId, saved.binding.requestId]);
      if (rows.some(row => row.operation_id !== saved.operationId || fromRow(row).fingerprint !== saved.fingerprint))
        throw executionAuthorityError('Restored execution consumption conflicts with non-rewound evidence.');
      if (rows.some(row => terminal(row.state) && terminal(saved.state) && JSON.stringify(receiptSchema.parse(row.receipt)) !== JSON.stringify(saved.receipt)))
        throw executionAuthorityError('Restored terminal evidence conflicts with non-rewound evidence.');
      if (rows.some(row => terminal(row.state) && !terminal(saved.state)))
        throw executionAuthorityError('Restored completion contradicts non-rewound unresolved ownership.');
      if (journal?.operation.operationId === saved.operationId
        && JSON.stringify(journal.operation) !== JSON.stringify(journalOperation(saved)))
        throw executionAuthorityError('Preserved journal ownership conflicts with permanent request consumption.');
      const owner = mergeClaims([saved.claim, ...rows.map(row => fromRow(row).claim),
        journal?.operation.operationId === saved.operationId ? journalIdentity : null]);
      // Missing DB claim is not proof of no launch: journal-start/DB-rollback
      // can leave queued/draining storage behind an already-started owner.
      const state = terminal(saved.state) ? saved.state : 'uncertain';
      const receipt = terminal(saved.state) ? saved.receipt : null;
      await client.query(`INSERT INTO peer_execution_operations
        (operation_id, host_instance_id, peer_instance_id, request_id, fingerprint, binding, execution_epoch, state, revision, claim, receipt)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb)
        ON CONFLICT (operation_id) DO UPDATE SET state = EXCLUDED.state,
        revision = GREATEST(peer_execution_operations.revision, EXCLUDED.revision), claim = EXCLUDED.claim, receipt = EXCLUDED.receipt, updated_at = NOW()`,
      [saved.operationId, saved.binding.hostInstanceId, saved.binding.peerInstanceId, saved.binding.requestId, saved.fingerprint,
        JSON.stringify(saved.binding), saved.binding.executionEpoch, state, saved.revision + 1, JSON.stringify(owner), JSON.stringify(receipt)]);
      });
      if (replayed.digest !== proof.digest || replayed.count !== proof.count)
        throw executionAuthorityError('Execution recovery evidence changed during reconciliation.');
    // An old/different snapshot may contain owners not present in this machine's
    // capture. They also cannot become launchable just because generic restore ended.
      await client.query(`UPDATE peer_execution_operations SET state = 'uncertain', revision = revision + 1,
        receipt = NULL, updated_at = NOW() WHERE state IN ('queued', 'draining', 'in-flight', 'awaiting-reconnect')`);
      if (journal) {
        const { rows: [owner] } = await client.query('SELECT * FROM peer_execution_operations WHERE operation_id = $1', [journal.operation.operationId]);
        if (!owner || JSON.stringify(journal.operation) !== JSON.stringify(journalOperation(fromRow(owner))))
          throw executionAuthorityError('Preserved journal ownership has no matching permanent consumption.');
      }
      const latest = coordinator.getExclusive();
      if (JSON.stringify(latest) !== JSON.stringify(journal))
        throw executionAuthorityError('Preserved journal ownership changed during reconciliation.');
      const current = authority.read();
      if (current?.epoch !== record.epoch || current.recovery?.id !== id)
        throw executionAuthorityError('The execution recovery owner changed during reconciliation.');
    });
    const current = authority.read();
    if (current?.phase === 'ready' && current.settledRecoveryId === id) return current;
    return authority.completeRestore(id);
  };
  return { initialize, consume, read, list, transition, advanceGenerationFloor, prepareRestore, adoptEmptyRestore, reconcileRestore, authority };
}
