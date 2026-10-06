import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMaintenanceAdmission } from '../lib/maintenanceAdmission.js';
import { createPeerExecutionReceiver } from './peerExecution.js';
import { createPeerExecutionGrants } from './peerExecutionGrants.js';
import { peerExecutionPreflightPayloadSchema, peerExecutionDispatchSchema, peerExecutionGrantSchema } from '../lib/peerAdminValidation.js';
import { peerAdminPairBinding } from './peerAdministration.js';

let directory, pair, ledger, grants, receiver, adapters, coordinator, store, epoch, operations, floors, proofs;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const intent = { action: 'portos.restart' };
const terminal = state => ['succeeded', 'failed'].includes(state);
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'peer-execution-fixture-'));
  pair = { self: { instanceId: randomUUID() }, peer: { id: 'fixture-peer', instanceId: randomUUID(), syncSecret: 'fixture-pair-secret'.repeat(3) } };
  epoch = randomUUID(); operations = new Map(); floors = new Map(); proofs = new Map();
  store = { version: 1, grants: [] };
  ledger = {
    authority: { read: () => ({ epoch, phase: 'ready' }), requireReady: value => { if (value !== epoch) throw Object.assign(new Error('stale epoch'), { code: 'STALE_EPOCH' }); } },
    initialize: async () => ({ epoch, phase: 'ready' }),
    generationFloor: async ({ action }) => floors.get(action) ?? 0,
    advanceGenerationFloor: async ({ action, generation }) => { floors.set(action, generation); return generation; },
    consume: async binding => {
      const existing = [...operations.values()].find(row => row.binding.requestId === binding.requestId);
      if (existing) return { operation: existing, isNew: false };
      const operation = { operationId: randomUUID(), binding, fingerprint: hash(binding), revision: 1, state: 'queued', claim: null, receipt: null };
      operations.set(operation.operationId, operation); return { operation, isNew: true };
    },
    retireUnconsumed: async binding => {
      const { operation, isNew } = await ledger.consume(binding);
      if (!isNew) return operation;
      const retired = { ...operation, state: 'failed', receipt: { outcome: 'failed', code: 'PEER_EXECUTION_NOT_ACCEPTED', evidenceDigest: null, executionEpoch: epoch } };
      operations.set(retired.operationId, retired); return retired;
    },
    read: async id => operations.get(id),
    readRequest: async ({ hostInstanceId, peerInstanceId, requestId }) => [...operations.values()].find(row => row.binding.requestId === requestId
      && row.binding.hostInstanceId === hostInstanceId && row.binding.peerInstanceId === peerInstanceId) ?? null,
    listActive: async () => [...operations.values()].filter(row => !terminal(row.state)),
    transition: async (id, revision, state, extra = {}) => {
      const row = operations.get(id);
      if (row.revision !== revision || terminal(row.state)) throw new Error('stale transition');
      const next = { ...row, state, revision: revision + 1, claim: extra.claim ?? row.claim, receipt: extra.receipt ?? null };
      operations.set(id, next); return next;
    },
  };
  coordinator = createMaintenanceAdmission(directory, { verifyExclusiveReceipt: (claim, receipt) => {
    const proof = proofs.get(claim.operation.operationId);
    return proof?.fingerprint === claim.fingerprint && proof.receiptDigest === receipt.receiptDigest && proof.outcome === receipt.outcome;
  } });
  grants = createPeerExecutionGrants({ ledger, readStore: async () => structuredClone(store), writeStore: async value => { store = structuredClone(value); }, identity: async id => {
    if (id !== pair.peer.id || pair.peer.enabled === false) throw new Error('pair missing'); return pair;
  } });
  adapters = { prepare: vi.fn(async () => ({ version: 1, intent, target: 'fixture-fixed-process' })),
    run: vi.fn(async () => ({ state: 'succeeded', code: 'FIXTURE_FINISHED' })), reconcile: vi.fn(async () => null) };
  receiver = makeReceiver();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const makeReceiver = () => createPeerExecutionReceiver({ ledger, grants, coordinator, adapters, terminalProofs: proofs,
  caller: async req => { if (req !== 'paired') throw Object.assign(new Error('pair required'), { status: 403 }); return pair; }, version: '1.0.0' });
const grantInput = (extra = {}) => peerExecutionGrantSchema.parse({ peerId: pair.peer.id, action: intent.action,
  confirmedHostInstanceId: pair.self.instanceId, confirmedPeerInstanceId: pair.peer.instanceId,
  previousGrantId: store.grants[0]?.id ?? null, expiresInMinutes: 60, allowExecution: true, confirmation: 'execution-v1', ...extra });
const grant = (extra = {}) => receiver.saveGrant(grantInput(extra), { portosAuthContext: { method: 'session' } });
const prepare = async () => {
  const envelope = await receiver.preflight('paired', { protocolVersion: 1, requestId: randomUUID(), intent });
  expect(peerExecutionPreflightPayloadSchema.safeParse(envelope.payload).success).toBe(true);
  const { scope: _scope, senderInstanceId: _sender, targetInstanceId: _target, expiresAt: _expiry, ...input } = envelope.payload;
  return peerExecutionDispatchSchema.parse(input);
};
const idle = () => vi.waitFor(() => expect([...operations.values()].every(row => terminal(row.state) || row.state === 'uncertain' || row.state === 'awaiting-reconnect')).toBe(true));

describe('receiver execution public workflow with fixture-only side effects', () => {
  it('requires independently confirmed execution authority and refuses unauthenticated callers', async () => {
    expect(peerExecutionGrantSchema.safeParse({ ...grantInput(), confirmation: 'planning-v1' }).success).toBe(false);
    await expect(prepare()).rejects.toMatchObject({ code: 'PEER_EXECUTION_GRANT_REQUIRED' });
    await grant();
    await expect(receiver.preflight('session', { intent, requestId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    expect(adapters.run).not.toHaveBeenCalled();
  });
  it('records acceptance before launch, completes once and permanently refuses mutated replay', async () => {
    await grant(); const input = await prepare();
    const accepted = await receiver.dispatch('paired', input);
    expect(accepted.payload.state).toBe('queued');
    await idle();
    expect(adapters.run).toHaveBeenCalledTimes(1);
    expect(coordinator.status().state).toBe('normal');
    expect((await receiver.dispatch('paired', input)).payload.state).toBe('succeeded');
    await expect(receiver.dispatch('paired', { ...input, intent: { action: 'portos.update' } })).rejects.toMatchObject({ code: 'PEER_EXECUTION_REPLAY_CONFLICT' });
    const restarted = makeReceiver(); await restarted.recover();
    expect((await restarted.status('paired', input)).payload.state).toBe('succeeded');
    expect(adapters.run).toHaveBeenCalledTimes(1);
  });
  it('retires an unconsumed signed request after restart and revocation, preventing every delayed dispatch', async () => {
    await grant();
    const requestId = randomUUID();
    const envelope = await receiver.preflight('paired', { protocolVersion: 1, requestId, intent });
    const { scope: _scope, senderInstanceId: _sender, targetInstanceId: _target, expiresAt: _expiry, ...dispatch } = envelope.payload;
    await grant({ allowExecution: false });
    const restarted = makeReceiver();
    await expect(restarted.status('paired', { requestId })).rejects.toMatchObject({ code: 'PEER_EXECUTION_NOT_FOUND' });
    await expect(restarted.status('paired', { requestId, preflight: { ...envelope, signature: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'PEER_EXECUTION_RECOVERY_UNVERIFIED' });
    expect(operations.size).toBe(0);
    const retired = await restarted.status('paired', { requestId, preflight: envelope });
    expect(retired.payload).toMatchObject({ state: 'failed', code: 'PEER_EXECUTION_NOT_ACCEPTED' });
    expect((await receiver.dispatch('paired', dispatch)).payload).toEqual(retired.payload);
    await grant();
    await expect(restarted.preflight('paired', { protocolVersion: 1, requestId, intent })).rejects.toMatchObject({ code: 'PEER_EXECUTION_CONSUMED' });
    await makeReceiver().recover();
    expect((await restarted.status('paired', { requestId })).payload).toEqual(retired.payload);
    expect(adapters.run).not.toHaveBeenCalled();
    expect(coordinator.status().state).toBe('normal');
  });
  it('returns the existing accepted operation when recovery races an admitted dispatch', async () => {
    const active = coordinator.admit('render', 'Fixture render');
    await grant();
    const requestId = randomUUID();
    const preflight = await receiver.preflight('paired', { protocolVersion: 1, requestId, intent });
    const { scope: _scope, senderInstanceId: _sender, targetInstanceId: _target, expiresAt: _expiry, ...input } = preflight.payload;
    await receiver.dispatch('paired', input);
    const response = await receiver.status('paired', { requestId, preflight });
    expect(['queued', 'draining']).toContain(response.payload.state);
    await active.finish(); await receiver.drain(); await idle();
    expect(adapters.run).toHaveBeenCalledOnce();
  });
  it('lets admitted work settle naturally and rechecks revocation before dispatch', async () => {
    const active = coordinator.admit('provider', 'Fixture provider');
    await grant(); const input = await prepare(); await receiver.dispatch('paired', input);
    await vi.waitFor(() => expect(coordinator.status().state).toBe('draining'));
    expect(adapters.run).not.toHaveBeenCalled();
    await grant({ allowExecution: false });
    await active.finish(); await receiver.drain(); await idle();
    expect((await receiver.status('paired', input)).payload.state).toBe('failed');
    expect(adapters.run).not.toHaveBeenCalled();
  });
  it.each(['credential', 'epoch', 'generation', 'evidence'])('refuses %s changes during drain', async change => {
    const active = coordinator.admit('render', 'Fixture render');
    await grant(); const input = await prepare(); await receiver.dispatch('paired', input);
    await vi.waitFor(() => expect(coordinator.status().state).toBe('draining'));
    if (change === 'credential') pair.peer.syncSecret = 'different-fixture-secret'.repeat(3);
    if (change === 'epoch') epoch = randomUUID();
    if (change === 'generation') floors.set(intent.action, 100);
    if (change === 'evidence') adapters.prepare.mockResolvedValue({ version: 2, target: 'changed' });
    await active.finish(); await receiver.drain(); await idle();
    expect(adapters.run).not.toHaveBeenCalled();
  });
  it('fences resume and never relaunches after an ambiguous launch or process restart', async () => {
    adapters.run.mockRejectedValue(new Error('fixture transport lost after launch'));
    await grant(); const input = await prepare(); await receiver.dispatch('paired', input); await idle();
    expect((await receiver.status('paired', input)).payload.state).toBe('uncertain');
    const hold = coordinator.status().hold;
    expect(() => coordinator.resume({ id: hold.id, revision: hold.revision })).toThrow();
    await makeReceiver().recover(); await receiver.dispatch('paired', input);
    expect(adapters.run).toHaveBeenCalledTimes(1);
    expect(coordinator.getExclusive().phase).toBe('uncertain');
  });
  it('requires exact receiver evidence for reconnect completion before releasing the hold', async () => {
    adapters.run.mockResolvedValue({ state: 'awaiting-reconnect' });
    await grant(); const input = await prepare(); await receiver.dispatch('paired', input); await idle();
    expect(coordinator.getExclusive()).not.toBeNull();
    adapters.reconcile.mockResolvedValue({ state: 'succeeded', code: 'FIXTURE_RESTART_PROVED' });
    await makeReceiver().recover();
    expect((await receiver.status('paired', input)).payload.state).toBe('succeeded');
    expect(coordinator.status().state).toBe('normal');
    expect(adapters.run).toHaveBeenCalledTimes(1);
  });
  it.each(['settle', 'resume'])('recovers a crash after terminal persistence before %s', async boundary => {
    const original = coordinator[boundary === 'settle' ? 'settleExclusive' : 'resume'];
    coordinator[boundary === 'settle' ? 'settleExclusive' : 'resume'] = vi.fn(() => { throw new Error('fixture crash gap'); });
    await grant(); const input = await prepare(); await receiver.dispatch('paired', input); await idle();
    await vi.waitFor(() => expect(coordinator.status().state).not.toBe('normal'));
    coordinator[boundary === 'settle' ? 'settleExclusive' : 'resume'] = original;
    await makeReceiver().recover();
    expect(coordinator.status().state).toBe('normal');
    expect((await receiver.status('paired', input)).payload.state).toBe('succeeded');
    expect(adapters.run).toHaveBeenCalledTimes(1);
  });
  it('reconciles late detached completion on status without restarting or relaunching', async () => {
    adapters.run.mockResolvedValue({ state: 'awaiting-reconnect' });
    await grant(); const input = await prepare(); await receiver.dispatch('paired', input); await idle();
    const rebooted = makeReceiver(); await rebooted.recover();
    expect((await rebooted.status('paired', input)).payload.state).toBe('uncertain');
    adapters.reconcile.mockResolvedValue({ state: 'succeeded', code: 'FIXTURE_LATE_COMPLETION' });
    expect((await rebooted.status('paired', input)).payload.state).toBe('succeeded');
    expect(coordinator.status().state).toBe('normal');
    expect(adapters.run).toHaveBeenCalledTimes(1);
  });
  it('invalidates previous authority if policy publication fails after the generation floor', async () => {
    await grant();
    const failedGrants = createPeerExecutionGrants({ ledger, identity: async () => pair, readStore: async () => structuredClone(store), writeStore: async () => { throw new Error('fixture write failure'); } });
    await expect(failedGrants.save(grantInput({ allowExecution: false }), { portosAuthContext: { method: 'session' } })).rejects.toThrow('fixture write failure');
    await expect(grants.current(pair.peer.id, intent.action)).rejects.toMatchObject({ code: 'PEER_EXECUTION_GRANT_REQUIRED' });
    expect(store.grants[0].pairBinding).toBe(peerAdminPairBinding(pair.peer, pair.self));
  });
});
