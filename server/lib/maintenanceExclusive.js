/** Exclusive coordinator ownership and receiver-local one-use launch capabilities. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { peerAdminIntentSchema } from './peerAdminValidation.js';

// Tokens never serialize. Reopening an in-flight journal cannot mint another launch.
const executionCapabilities = new WeakMap();
export function assertPeerExecutionCapability(capability, intent, evidenceDigest) {
  const proof = executionCapabilities.get(capability);
  if (!proof || JSON.stringify(proof.operation.intent) !== JSON.stringify(intent)
    || proof.operation.evidenceDigest !== evidenceDigest) {
    throw Object.assign(new Error('A receiver-issued execution capability is required.'), { code: 'PEER_EXECUTION_CAPABILITY_REQUIRED', status: 409 });
  }
  proof.assertCurrent();
  return structuredClone(proof.operation);
}
export function consumePeerExecutionCapability(capability, intent, evidenceDigest) {
  const operation = assertPeerExecutionCapability(capability, intent, evidenceDigest);
  const proof = executionCapabilities.get(capability);
  if (proof.consumed) throw Object.assign(new Error('This execution capability was already consumed.'), { code: 'PEER_EXECUTION_CAPABILITY_CONSUMED', status: 409 });
  proof.consumed = true;
  return operation;
}

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const operationSchema = z.object({
  operationId: uuid, requestId: uuid, peerInstanceId: uuid, hostInstanceId: uuid,
  grantId: uuid, grantGeneration: z.number().int().positive(), scope: z.literal('execution-v1'),
  pairBinding: digest, intent: peerAdminIntentSchema,
  receiverVersion: z.string().min(1).max(100), evidenceDigest: digest,
}).strict().refine(value => value.peerInstanceId !== value.hostInstanceId);
const fingerprint = operation => createHash('sha256').update(JSON.stringify(operation)).digest('hex');
export const maintenanceExclusiveSchema = z.object({
  id: uuid, revision: z.number().int().positive(), holdId: uuid, holdRevision: z.number().int().positive(),
  operation: operationSchema, fingerprint: digest,
  phase: z.enum(['reserved', 'in-flight', 'awaiting-reconnect', 'uncertain']),
  claimedAt: z.string().datetime(),
}).strict().refine(value => fingerprint(value.operation) === value.fingerprint);
export const maintenanceExclusiveReceiptSchema = z.object({
  id: uuid, revision: z.number().int().positive(), operationId: uuid, fingerprint: digest,
  outcome: z.enum(['cancelled', 'succeeded', 'failed']), receiptDigest: digest.nullable(),
  settledAt: z.string().datetime(),
}).strict();
const expectedSchema = z.object({ id: uuid, revision: z.number().int().positive(), fingerprint: digest }).strict();
const claimSchema = z.object({ id: uuid, revision: z.number().int().positive(), operation: operationSchema }).strict();
const receiptSchema = z.object({ outcome: z.enum(['cancelled', 'succeeded', 'failed']), receiptDigest: digest.nullable() }).strict();

/** Shares the admission transaction; an independent executor lock cannot fence resume. */
export function createMaintenanceExclusive({ transaction, read, lockExists, makeId, error, now, verifyReceipt }) {
  const observations = new WeakMap();
  const startedClaims = new WeakMap();
  const stale = message => { throw error('MAINTENANCE_STALE', message); };
  const copy = value => value ? structuredClone(value) : null;
  const current = (state, expected) => {
    const claim = state.exclusive;
    if (!claim || claim.id !== expected.id || claim.revision !== expected.revision || claim.fingerprint !== expected.fingerprint)
      stale('The exclusive maintenance ownership changed. Reconcile its current record.');
    return claim;
  };
  const checkIdle = (state, evidence) => {
    const proof = observations.get(evidence);
    observations.delete(evidence);
    if (!proof || now() < proof.observedAt || now() - proof.observedAt > 5000
      || proof.revision !== state.revision || proof.holdId !== state.hold?.id
      || proof.holdRevision !== state.hold?.revision || state.operations.length)
      stale('A fresh coordinator observation of settled work is required.');
  };
  const observeIdle = () => {
    if (lockExists()) stale('Maintenance state is being changed.');
    const state = read();
    if (lockExists() || !state.hold || state.operations.length) stale('Admitted work must finish saving and cleanup first.');
    const evidence = Object.freeze({});
    observations.set(evidence, { revision: state.revision, holdId: state.hold.id,
      holdRevision: state.hold.revision, observedAt: now() });
    return evidence;
  };
  const claimReady = (input, evidence) => {
    const expected = claimSchema.parse(input);
    return transaction(state => {
      if (state.hold?.id !== expected.id || state.hold?.revision !== expected.revision)
        stale('This maintenance hold changed. Refresh before claiming it.');
      if (state.exclusive) stale('This maintenance hold already has an exclusive owner.');
      if (state.exclusiveReceipt?.operationId === expected.operation.operationId)
        stale('This operation already settled. Its receipt cannot authorize another launch.');
      checkIdle(state, evidence);
      state.exclusive = { id: makeId(), revision: 1, holdId: expected.id, holdRevision: expected.revision,
        operation: expected.operation, fingerprint: fingerprint(expected.operation), phase: 'reserved',
        claimedAt: new Date(now()).toISOString() };
      return copy(state.exclusive);
    });
  };
  const getExclusive = () => {
    if (lockExists()) stale('Maintenance state is being changed.');
    return copy(read().exclusive);
  };
  const transitionExclusive = (input, phase, evidence) => {
    const expected = expectedSchema.parse(input);
    const result = transaction(state => {
      const claim = current(state, expected);
      const allowed = { reserved: ['in-flight', 'uncertain'], 'in-flight': ['awaiting-reconnect', 'uncertain'],
        'awaiting-reconnect': ['uncertain'], uncertain: [] };
      if (!allowed[claim.phase].includes(phase)) stale('This operation cannot be launched again or moved backwards.');
      if (phase === 'in-flight') checkIdle(state, evidence);
      claim.phase = phase;
      claim.revision++;
      return copy(claim);
    });
    if (phase === 'in-flight') startedClaims.set(result, { id: result.id, revision: result.revision, fingerprint: result.fingerprint });
    return result;
  };
  const issueExecutionCapability = claim => {
    if (!startedClaims.has(claim)) stale('Only the fresh in-flight transition can authorize a launch.');
    const expected = startedClaims.get(claim);
    startedClaims.delete(claim);
    const assertCurrent = () => {
      if (lockExists()) stale('Maintenance state is being changed.');
      const state = read();
      const live = current(state, expected);
      if (live.phase !== 'in-flight' || state.operations.length) stale('Exclusive execution ownership is no longer idle and in-flight.');
      return live;
    };
    const live = assertCurrent();
    const capability = Object.freeze({});
    executionCapabilities.set(capability, { operation: copy(live.operation), assertCurrent, consumed: false });
    return capability;
  };
  const settleExclusive = (input, receiptInput) => {
    const expected = expectedSchema.parse(input);
    const receipt = receiptSchema.parse(receiptInput);
    return transaction(state => {
      const previous = state.exclusiveReceipt;
      if (!state.exclusive && previous?.id === expected.id && previous.revision === expected.revision
        && previous.fingerprint === expected.fingerprint && previous.outcome === receipt.outcome
        && previous.receiptDigest === receipt.receiptDigest) return copy(previous);
      const claim = current(state, expected);
      if (receipt.outcome === 'cancelled') {
        if (claim.phase !== 'reserved' || receipt.receiptDigest !== null)
          stale('Only a reservation that never started can be cancelled.');
      } else if (claim.phase === 'reserved' || !receipt.receiptDigest) {
        stale('Verified terminal persistence and cleanup evidence is required.');
      } else {
        // Verification is a receiver-owned synchronous adapter supplied at
        // construction, never a caller-supplied boolean or a wire callback.
        let verified;
        try { verified = verifyReceipt(copy(claim), copy(receipt)); }
        catch { stale('Terminal verification is unavailable. Ownership remains held; verification can be retried.'); }
        if (verified && typeof verified.then === 'function') {
          // An accidentally async verifier cannot release authority or leave
          // a detached rejection unowned at this synchronous boundary.
          Promise.resolve(verified).catch(() => console.error('❌ Exclusive maintenance verifier rejected; ownership remains held.'));
        }
        if (verified !== true) stale('Verified terminal persistence and cleanup evidence is required.');
      }
      state.exclusiveReceipt = { ...expected, operationId: claim.operation.operationId, ...receipt,
        settledAt: new Date(now()).toISOString() };
      state.exclusive = null;
      return copy(state.exclusiveReceipt);
    });
  };
  const observeExistingWork = state => {
    if (state.exclusive && state.exclusive.phase !== 'reserved') {
      state.exclusive.phase = 'uncertain';
      state.exclusive.revision++;
    }
  };
  return { observeIdle, claimReady, getExclusive, transitionExclusive, settleExclusive, observeExistingWork, issueExecutionCapability };
}
