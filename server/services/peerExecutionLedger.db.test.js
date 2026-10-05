/** Real transaction/restore fixtures only; no grants, peers, adapters or providers. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { createPeerExecutionLedger } from './peerExecutionLedger.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('services/peerExecutionLedger.db.test', health.connected, 'disposable PostgreSQL unavailable');
const db = { query, withTransaction };
let directory, ledger, input;
const binding = epoch => ({ hostInstanceId: randomUUID(), peerInstanceId: randomUUID(), requestId: randomUUID(),
  grantId: randomUUID(), grantGeneration: 1, scope: 'execution-v1', pairBinding: 'a'.repeat(64),
  intent: { action: 'portos.restart' }, receiverVersion: 'fixture-1.0', evidenceDigest: 'b'.repeat(64), executionEpoch: epoch });
const claim = () => ({ id: randomUUID(), revision: 2, fingerprint: 'c'.repeat(64) });
const receipt = (epoch, outcome = 'failed') => ({ outcome, code: 'FIXTURE_TERMINAL', evidenceDigest: 'd'.repeat(64), executionEpoch: epoch });

beforeEach(async () => {
  if (!runDb) return;
  // This file owns only its new, machine-local test tables; the DB runner is serial.
  await query('DELETE FROM peer_execution_operations');
  await query('DELETE FROM peer_execution_generation_floors');
  directory = fs.mkdtempSync(join(tmpdir(), 'peer-execution-ledger-db-test-'));
  ledger = createPeerExecutionLedger({ db, dataDir: directory });
  input = binding((await ledger.initialize()).epoch);
});
afterEach(async () => {
  if (!runDb) return;
  await query('DELETE FROM peer_execution_operations');
  await query('DELETE FROM peer_execution_generation_floors');
  fs.rmSync(directory, { recursive: true, force: true });
});
afterAll(async () => { if (health.connected) await close(); });

describe.skipIf(!runDb)('receiver-local permanent execution consumption', () => {
  it('durably settles legacy empty committed-restore compatibility before downstream retries', async () => {
    const { createPeerExecutionRestore } = await import('./peerExecutionRestore.js');
    const hooks = createPeerExecutionRestore({ receiver: async () => ledger });
    fs.unlinkSync(join(directory, 'peer-execution-authority.json'));
    const id = randomUUID();
    const first = await hooks.finishPeerExecutionRestore(id);
    expect(first).toMatchObject({ phase: 'ready', settledRecoveryId: id });
    // Federation resync/generic-journal release can fail after this hook returns.
    await expect(Promise.reject(new Error('fixture downstream release failure'))).rejects.toThrow(/downstream/);
    const restarted = createPeerExecutionRestore({ receiver: async () => createPeerExecutionLedger({ db, dataDir: directory }) });
    expect(await restarted.finishPeerExecutionRestore(id)).toEqual(first);
  });
  it('serializes duplicate first requests, retaining one operation through process reconstruction', async () => {
    const results = await Promise.all([ledger.consume(input), ledger.consume(input)]);
    expect(results.map(row => row.isNew).sort()).toEqual([false, true]);
    expect(results[0].operation.operationId).toBe(results[1].operation.operationId);
    const restarted = createPeerExecutionLedger({ db, dataDir: directory });
    expect((await restarted.consume(input)).operation).toEqual(results[0].operation);
    for (const changed of [{ intent: { action: 'portos.update' } }, { grantId: randomUUID(), grantGeneration: 2 },
      { pairBinding: 'e'.repeat(64) }, { receiverVersion: 'fixture-2.0' }, { evidenceDigest: 'f'.repeat(64) }]) {
      await expect(restarted.consume({ ...input, ...changed })).rejects.toMatchObject({ code: 'PEER_EXECUTION_REPLAY_CONFLICT' });
    }
    expect(await ledger.list()).toHaveLength(1);
  });
  it('serializes conflicting requests and never replaces the winning fingerprint', async () => {
    const outcomes = await Promise.allSettled([ledger.consume(input), ledger.consume({ ...input, evidenceDigest: 'e'.repeat(64) })]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await ledger.list()).toHaveLength(1);
  });
  it('retains consumed identity independently of action, renewal, sender and generation floors', async () => {
    const saved = await ledger.consume(input);
    await ledger.advanceGenerationFloor({ hostInstanceId: input.hostInstanceId, peerInstanceId: input.peerInstanceId,
      action: input.intent.action, generation: 4, executionEpoch: input.executionEpoch });
    expect(await ledger.consume(input)).toMatchObject({ isNew: false, operation: saved.operation });
    await expect(ledger.consume({ ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'PEER_EXECUTION_GENERATION_STALE' });
    expect(await ledger.advanceGenerationFloor({ hostInstanceId: input.hostInstanceId, peerInstanceId: input.peerInstanceId,
      action: input.intent.action, generation: 2, executionEpoch: input.executionEpoch })).toBe(4);
    expect((await ledger.consume({ ...input, peerInstanceId: randomUUID() })).isNew).toBe(true);
  });
  it('has one-way compare-and-set states and cannot turn timeout/uncertainty into a second launch', async () => {
    const { operation } = await ledger.consume(input);
    const draining = await ledger.transition(operation.operationId, 1, 'draining');
    await expect(ledger.transition(operation.operationId, 1, 'draining')).rejects.toMatchObject({ code: 'PEER_EXECUTION_STALE' });
    await expect(ledger.transition(operation.operationId, draining.revision, 'in-flight')).rejects.toMatchObject({ code: 'PEER_EXECUTION_CLAIM_REQUIRED' });
    const started = await ledger.transition(operation.operationId, draining.revision, 'in-flight', { claim: claim() });
    const uncertain = await ledger.transition(operation.operationId, started.revision, 'uncertain');
    await expect(ledger.transition(operation.operationId, uncertain.revision, 'in-flight', { claim: claim() }))
      .rejects.toMatchObject({ code: 'PEER_EXECUTION_TRANSITION_REFUSED' });
    const settled = await ledger.transition(operation.operationId, uncertain.revision, 'failed', { receipt: receipt(input.executionEpoch) });
    expect((await ledger.consume(input)).operation).toEqual(settled);
    await expect(ledger.transition(operation.operationId, settled.revision, 'draining')).rejects.toThrow();
  });
  it('rechecks the authority epoch after waiting for a PostgreSQL writer lock', async () => {
    let release, entered;
    const blocked = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const holding = withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [90011027]); entered(); await gate;
    });
    await blocked;
    const queued = ledger.consume(input);
    const observed = queued.catch(error => error);
    ledger.authority.beginRestore(randomUUID());
    release(); await holding;
    expect(await observed).toMatchObject({ code: 'PEER_EXECUTION_AUTHORITY_UNAVAILABLE' });
    expect(await ledger.list()).toEqual([]);
  });
  it('bounds active records and lists, retaining terminal consumption instead of pruning it', async () => {
    for (let i = 0; i < 32; i++) await ledger.consume({ ...input, requestId: randomUUID() });
    await expect(ledger.consume(input)).rejects.toMatchObject({ code: 'PEER_EXECUTION_QUEUE_FULL' });
    const first = (await ledger.list({ limit: 1 }))[0];
    await ledger.transition(first.operationId, first.revision, 'failed', { receipt: receipt(input.executionEpoch) });
    expect((await ledger.consume(input)).isNew).toBe(true);
    expect(await ledger.list()).toHaveLength(33);
    await expect(ledger.list({ limit: 101 })).rejects.toThrow();
  });
  it('refuses missing authority over existing consumption instead of silently minting a new epoch', async () => {
    await ledger.consume(input);
    fs.unlinkSync(join(directory, 'peer-execution-authority.json'));
    await expect(ledger.initialize()).rejects.toMatchObject({ code: 'PEER_EXECUTION_AUTHORITY_UNAVAILABLE' });
  });
  it.each(['empty', 'older'])('reconciles a %s database restore without losing consumption, floors or uncertain ownership', async kind => {
    const first = (await ledger.consume(input)).operation;
    const owner = (await ledger.consume({ ...input, requestId: randomUUID() })).operation;
    const draining = await ledger.transition(owner.operationId, 1, 'draining');
    const started = await ledger.transition(owner.operationId, draining.revision, 'in-flight', { claim: claim() });
    await ledger.advanceGenerationFloor({ hostInstanceId: input.hostInstanceId, peerInstanceId: input.peerInstanceId,
      action: input.intent.action, generation: 7, executionEpoch: input.executionEpoch });
    const id = randomUUID();
    const pending = await ledger.prepareRestore(id);
    await query('DELETE FROM peer_execution_operations');
    await query('DELETE FROM peer_execution_generation_floors');
    if (kind === 'older') {
      await query(`INSERT INTO peer_execution_generation_floors (host_instance_id, peer_instance_id, action, generation)
        VALUES ($1,$2,$3,1)`, [input.hostInstanceId, input.peerInstanceId, input.intent.action]);
    }
    const restarted = createPeerExecutionLedger({ db, dataDir: directory });
    expect(await restarted.prepareRestore(id)).toEqual(pending); // Must not capture the rewound DB.
    await expect(restarted.consume(input)).rejects.toMatchObject({ code: 'PEER_EXECUTION_AUTHORITY_UNAVAILABLE' });
    const completed = await restarted.reconcileRestore(id);
    expect(await restarted.reconcileRestore(id)).toEqual(completed);
    expect((await restarted.read(first.operationId)).state).toBe('uncertain');
    expect(await restarted.read(owner.operationId)).toMatchObject({ state: 'uncertain', claim: started.claim });
    await expect(restarted.consume(input)).rejects.toMatchObject({ code: 'PEER_EXECUTION_AUTHORITY_UNAVAILABLE' });
    await expect(restarted.consume({ ...input, executionEpoch: completed.epoch }))
      .rejects.toMatchObject({ code: 'PEER_EXECUTION_REPLAY_CONFLICT' });
    await expect(restarted.consume({ ...input, requestId: randomUUID(), executionEpoch: completed.epoch }))
      .rejects.toMatchObject({ code: 'PEER_EXECUTION_GENERATION_STALE' });
    const current = await restarted.read(owner.operationId);
    await expect(restarted.transition(owner.operationId, current.revision, 'failed', {
      authorityEpoch: completed.epoch, receipt: receipt(input.executionEpoch),
    })).rejects.toMatchObject({ code: 'PEER_EXECUTION_RECEIPT_STALE' });
    expect((await restarted.transition(owner.operationId, current.revision, 'failed', {
      authorityEpoch: completed.epoch, receipt: receipt(completed.epoch),
    })).state).toBe('failed');
  });
  it('preserves committed terminal evidence across restore and rejects conflicting restored fingerprints atomically', async () => {
    const first = (await ledger.consume(input)).operation;
    await ledger.transition(first.operationId, 1, 'failed', { receipt: receipt(input.executionEpoch) });
    const id = randomUUID(); await ledger.prepareRestore(id);
    await ledger.reconcileRestore(id);
    expect((await ledger.read(first.operationId)).receipt).toEqual(receipt(input.executionEpoch));
    const second = (await ledger.consume({ ...input, requestId: randomUUID(), executionEpoch: ledger.authority.read().epoch })).operation;
    const conflictId = randomUUID(); await ledger.prepareRestore(conflictId);
    await query('UPDATE peer_execution_operations SET fingerprint = $2 WHERE operation_id = $1', [second.operationId, 'f'.repeat(64)]);
    await expect(ledger.reconcileRestore(conflictId)).rejects.toThrow();
    expect(ledger.authority.read().phase).toBe('reconciling');
  });
  it('keeps missing or modified recovery evidence fenced without applying it', async () => {
    const saved = (await ledger.consume(input)).operation;
    const id = randomUUID(); await ledger.prepareRestore(id);
    await query('DELETE FROM peer_execution_operations');
    fs.appendFileSync(ledger.authority.recoveryPath, '\n');
    await expect(ledger.reconcileRestore(id)).rejects.toThrow();
    expect(await ledger.read(saved.operationId)).toBeNull();
    expect(ledger.authority.read().phase).toBe('reconciling');
  });
  it('refuses a generation-floor write during capture/reconciliation instead of acknowledging revocation that restore can erase', async () => {
    await ledger.consume(input);
    const id = randomUUID();
    const pending = await ledger.prepareRestore(id);
    const floor = { hostInstanceId: input.hostInstanceId, peerInstanceId: input.peerInstanceId,
      action: input.intent.action, generation: 7 };
    for (const executionEpoch of [input.executionEpoch, pending.epoch]) {
      await expect(ledger.advanceGenerationFloor({ ...floor, executionEpoch }))
        .rejects.toMatchObject({ code: 'PEER_EXECUTION_AUTHORITY_UNAVAILABLE' });
    }
    await query('DELETE FROM peer_execution_operations');
    await query('DELETE FROM peer_execution_generation_floors');
    const completed = await ledger.reconcileRestore(id);
    expect(await ledger.advanceGenerationFloor({ ...floor, executionEpoch: completed.epoch })).toBe(7);
    const nextRestore = randomUUID(); await ledger.prepareRestore(nextRestore);
    await query('DELETE FROM peer_execution_generation_floors');
    await ledger.reconcileRestore(nextRestore);
    const { rows: [row] } = await query('SELECT generation FROM peer_execution_generation_floors');
    expect(Number(row.generation)).toBe(7);
  });
  it('retains the recovery fence when the database commit outcome is unknown, then reconciles the same facts', async () => {
    const saved = (await ledger.consume(input)).operation;
    const id = randomUUID(); await ledger.prepareRestore(id);
    await query('DELETE FROM peer_execution_operations');
    let lost = false;
    const ambiguous = createPeerExecutionLedger({ dataDir: directory, db: {
      query, withTransaction: async fn => {
        const result = await withTransaction(fn);
        if (!lost) { lost = true; throw new Error('fixture lost commit acknowledgement'); }
        return result;
      },
    } });
    await expect(ambiguous.reconcileRestore(id)).rejects.toThrow(/acknowledgement/);
    expect(ledger.authority.read().phase).toBe('reconciling');
    await ledger.reconcileRestore(id);
    expect((await ledger.read(saved.operationId)).state).toBe('uncertain');
  });
  it('preserves a journal start across DB rollback and restore even when the captured DB claim is absent', async () => {
    const { createMaintenanceAdmission } = await import('../lib/maintenanceAdmission.js');
    const owner = createMaintenanceAdmission(directory);
    const hold = owner.begin({ reason: 'Fixture restore crash gap', owner: 'Fixture operator' }).hold;
    const saved = (await ledger.consume(input)).operation;
    const draining = await ledger.transition(saved.operationId, 1, 'draining');
    const { executionEpoch: _epoch, ...bound } = input;
    const reserved = owner.claimReady({ id: hold.id, revision: hold.revision,
      operation: { operationId: saved.operationId, ...bound } }, owner.observeIdle());
    const started = owner.transitionExclusive({ id: reserved.id, revision: reserved.revision, fingerprint: reserved.fingerprint },
      'in-flight', owner.observeIdle());
    const expected = { id: started.id, revision: started.revision, fingerprint: started.fingerprint };
    const rollback = createPeerExecutionLedger({ dataDir: directory, db: { query, withTransaction: fn => withTransaction(async client => {
      await fn(client); throw new Error('fixture rollback after journal start');
    }) } });
    await expect(rollback.transition(saved.operationId, draining.revision, 'in-flight', { claim: expected })).rejects.toThrow(/rollback/);
    expect(await ledger.read(saved.operationId)).toMatchObject({ state: 'draining', claim: null });
    const id = randomUUID(); await ledger.prepareRestore(id);
    await query('DELETE FROM peer_execution_operations');
    await ledger.reconcileRestore(id);
    expect(await ledger.read(saved.operationId)).toMatchObject({ state: 'uncertain', claim: expected, receipt: null });
    expect(owner.getExclusive()).toEqual(started);
    expect(() => owner.resume(hold)).toThrow();
  });
  it('preserves stronger same-owner evidence and refuses a conflicting restored owner', async () => {
    const saved = (await ledger.consume(input)).operation;
    const draining = await ledger.transition(saved.operationId, 1, 'draining');
    const original = claim();
    await ledger.transition(saved.operationId, draining.revision, 'in-flight', { claim: original });
    const id = randomUUID(); await ledger.prepareRestore(id);
    const stronger = { ...original, revision: original.revision + 3 };
    await query('UPDATE peer_execution_operations SET claim = $2::jsonb WHERE operation_id = $1', [saved.operationId, JSON.stringify(stronger)]);
    await ledger.reconcileRestore(id);
    expect((await ledger.read(saved.operationId)).claim).toEqual(stronger);
    const next = randomUUID(); await ledger.prepareRestore(next);
    const conflict = { ...stronger, id: randomUUID() };
    await query('UPDATE peer_execution_operations SET claim = $2::jsonb WHERE operation_id = $1', [saved.operationId, JSON.stringify(conflict)]);
    await expect(ledger.reconcileRestore(next)).rejects.toThrow(/Conflicting execution owner/);
    expect((await ledger.read(saved.operationId)).claim).toEqual(conflict);
    expect(ledger.authority.read().phase).toBe('reconciling');
  });
});
