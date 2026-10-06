/** Receiver-owned execution state machine. An accepted request is never a completion. */
import { createHash } from 'node:crypto';
import { canonicalStringify } from '../lib/objects.js';
import { createMutex } from '../lib/asyncMutex.js';
import { peerExecutionError } from './peerExecutionGrants.js';
import { peerExecutionPreflightPayloadSchema } from '../lib/peerAdminValidation.js';
import { peerAdminPairBinding, signPeerAdmin, verifyPeerAdminSignature } from './peerAdministration.js';

const hash = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const claimRef = claim => ({ id: claim.id, revision: claim.revision, fingerprint: claim.fingerprint });
const terminal = operation => ['succeeded', 'failed'].includes(operation.state);
const fail = (code, message) => { throw peerExecutionError(code, message); };
const journalOperation = operation => {
  const { executionEpoch: _epoch, ...binding } = operation.binding;
  return { operationId: operation.operationId, ...binding };
};

export function createPeerExecutionReceiver({ ledger, grants, coordinator, adapters, caller, version,
  now = Date.now, changed = () => {}, identityLock = fn => fn(), terminalProofs = new Map(), resume = input => coordinator.resume(input) }) {
  const withLock = createMutex();
  const locked = fn => identityLock(() => withLock(fn));
  const preflights = new Map();
  const pending = new Map();
  const running = new Set();
  let draining = false;
  let drainAgain = false;
  const emit = () => { try { changed(); } catch { console.error('❌ Peer execution status notification failed.'); } };
  const assertCurrent = async (peerId, binding) => {
    const pair = await grants.current(peerId, binding.intent.action);
    const grant = pair.grant;
    ledger.authority.requireReady(binding.executionEpoch);
    if (pair.self.instanceId !== binding.hostInstanceId || pair.peer.instanceId !== binding.peerInstanceId
      || peerAdminPairBinding(pair.peer, pair.self) !== binding.pairBinding
      || grant.id !== binding.grantId || grant.generation !== binding.grantGeneration
      || version !== binding.receiverVersion) fail('PEER_EXECUTION_AUTHORITY_CHANGED', 'Pair, grant, receiver or execution authority changed.');
    return pair;
  };
  const receipt = (operation, pair) => {
    const payload = { protocolVersion: 1, scope: 'execution-v1', requestId: operation.binding.requestId,
      senderInstanceId: pair.peer.instanceId, targetInstanceId: pair.self.instanceId,
      operationId: operation.operationId, state: operation.state, revision: operation.revision, code: operation.receipt?.code ?? null };
    return { payload, signature: signPeerAdmin(pair.peer, 'execution-receipt', payload) };
  };
  const findRequest = (pair, requestId) => ledger.readRequest({ hostInstanceId: pair.self.instanceId, peerInstanceId: pair.peer.instanceId, requestId });
  const preflight = (req, input) => locked(async () => {
    for (const [key, value] of preflights) if (value.payload.expiresAt <= now()) preflights.delete(key);
    const pair = await caller(req);
    if (await findRequest(pair, input.requestId)) fail('PEER_EXECUTION_CONSUMED', 'Use status for an already-consumed request.');
    if (preflights.size >= 128) fail('PEER_EXECUTION_PREFLIGHT_LIMIT', 'Too many outstanding execution preflights.');
    const { grant } = await grants.current(pair.peer.id, input.intent.action);
    const evidence = await adapters.prepare(input.intent);
    const binding = { hostInstanceId: pair.self.instanceId, peerInstanceId: pair.peer.instanceId,
      requestId: input.requestId, grantId: grant.id, grantGeneration: grant.generation, scope: 'execution-v1',
      pairBinding: peerAdminPairBinding(pair.peer, pair.self), intent: input.intent, receiverVersion: version,
      evidenceDigest: hash(evidence), executionEpoch: grant.executionEpoch };
    await caller(req);
    await assertCurrent(pair.peer.id, binding);
    const payload = { protocolVersion: 1, scope: 'execution-v1', requestId: input.requestId,
      grantId: grant.id, grantGeneration: grant.generation, intent: input.intent, version,
      evidenceDigest: binding.evidenceDigest, executionEpoch: binding.executionEpoch,
      senderInstanceId: pair.peer.instanceId, targetInstanceId: pair.self.instanceId,
      expiresAt: Math.min(now() + 60_000, grant.expiresAt) };
    const key = `${pair.peer.instanceId}:${input.requestId}`;
    if (preflights.has(key)) fail('PEER_EXECUTION_PREFLIGHT_REPLAY', 'Use a fresh request identity for preflight.');
    preflights.set(key, { payload, binding, evidence });
    return { payload, signature: signPeerAdmin(pair.peer, 'execution-preflight', payload) };
  });
  const finish = async (operation, result, claim) => {
    const state = result.state;
    if (!['succeeded', 'failed'].includes(state) || !/^[A-Z0-9_]{1,100}$/.test(result.code))
      fail('PEER_EXECUTION_RECEIPT_INVALID', 'The adapter did not prove a terminal outcome.');
    const epoch = ledger.authority.read()?.epoch;
    const proof = { outcome: state, code: result.code, evidenceDigest: result.evidenceDigest ?? hash(result), executionEpoch: epoch };
    const completed = terminal(operation) ? operation : await ledger.transition(operation.operationId, operation.revision, state, { receipt: proof, authorityEpoch: epoch });
    if (claim) ledger.authority.requireReady(completed.receipt.executionEpoch);
    if (claim) {
      const current = coordinator.getExclusive();
      if (!current || current.id !== claim.id || current.fingerprint !== claim.fingerprint
        || hash(current.operation) !== hash(journalOperation(completed))
        || (completed.claim && (completed.claim.id !== current.id || completed.claim.fingerprint !== current.fingerprint)))
        fail('PEER_EXECUTION_CLAIM_CHANGED', 'Completion cannot release a different maintenance owner.');
      const receiptDigest = hash(completed.receipt);
      terminalProofs.set(current.operation.operationId, { fingerprint: current.fingerprint, receiptDigest, outcome: state });
      coordinator.settleExclusive(claimRef(current), { outcome: state, receiptDigest });
      terminalProofs.delete(current.operation.operationId);
    }
    pending.delete(operation.operationId);
    const status = coordinator.status();
    if (status.hold?.owner === `peer-execution:${operation.operationId}` && !coordinator.getExclusive())
      await resume({ id: status.hold.id, revision: status.hold.revision });
    emit();
    return completed;
  };
  const uncertain = async (operation, claim) => {
    const current = coordinator.getExclusive();
    if (claim && current?.id === claim.id && current.phase !== 'uncertain')
      coordinator.transitionExclusive(claimRef(current), 'uncertain');
    if (!terminal(operation) && operation.state !== 'uncertain')
      await ledger.transition(operation.operationId, operation.revision, 'uncertain');
    pending.delete(operation.operationId);
    emit();
  };
  const drain = async () => {
    if (draining) { drainAgain = true; return; }
    draining = true;
    try {
      for (const [id, accepted] of pending) {
        let launched;
        await locked(async () => {
          let operation = await ledger.read(id);
          if (!operation || terminal(operation)) { pending.delete(id); return; }
          let claim;
          try {
            await assertCurrent(accepted.peerId, operation.binding);
            let status = coordinator.status();
            if (status.state === 'normal') status = coordinator.begin({ reason: 'Authorized peer administration; existing work settles naturally.', owner: `peer-execution:${id}` });
            if (status.hold?.owner !== `peer-execution:${id}`) return;
            if (operation.state === 'queued') operation = await ledger.transition(id, operation.revision, 'draining');
            if (status.state !== 'ready') return;
            claim = coordinator.claimReady({ id: status.hold.id, revision: status.hold.revision, operation: journalOperation(operation) }, coordinator.observeIdle());
            const evidence = await adapters.prepare(operation.binding.intent);
            if (hash(evidence) !== operation.binding.evidenceDigest)
              fail('PEER_EXECUTION_EVIDENCE_CHANGED', 'Receiver-side requirements changed during drain. Preview again.');
            await assertCurrent(accepted.peerId, operation.binding);
            // No await between the last authority check and the coordinator's
            // atomic idle/revision transition; resume and ordinary admission fence here.
            claim = coordinator.transitionExclusive(claimRef(claim), 'in-flight', coordinator.observeIdle());
            operation = await ledger.transition(id, operation.revision, 'in-flight', { claim: claimRef(claim) });
            await assertCurrent(accepted.peerId, operation.binding);
            const capability = coordinator.issueExecutionCapability(claim);
            const result = await adapters.run(operation.binding.intent, evidence, { capability, coordinator });
            launched = { operation, claim, result };
            running.add(id);
            pending.delete(id);
            emit();
          } catch (error) {
            const current = coordinator.getExclusive();
            if (current?.operation.operationId === id && current.phase !== 'reserved') {
              await uncertain(operation, current);
            } else {
              if (current?.operation.operationId === id) coordinator.settleExclusive(claimRef(current), { outcome: 'cancelled', receiptDigest: null });
              await finish(operation, { state: 'failed', code: /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'PEER_EXECUTION_PREFLIGHT_FAILED' }, null);
            }
          }
        });
        if (launched) {
          const { operation, claim, result } = launched;
          // Completion owns its rejection outside the Express lifecycle. No
          // timeout, rejection or reconnect path ever calls run again.
          Promise.resolve(result.completion ?? result).then(outcome => locked(async () => {
            const current = await ledger.read(operation.operationId);
            running.delete(operation.operationId);
            if (outcome.state === 'awaiting-reconnect') {
              const owner = coordinator.getExclusive();
              coordinator.transitionExclusive(claimRef(owner), 'awaiting-reconnect');
              await ledger.transition(current.operationId, current.revision, 'awaiting-reconnect');
              emit();
            } else await finish(current, outcome, claim);
          })).catch(async () => {
            running.delete(operation.operationId);
            try { await locked(async () => uncertain(await ledger.read(operation.operationId), claim)); }
            catch { console.error('❌ Peer execution completion is uncertain; maintenance ownership remains held.'); }
          });
        }
      }
    } finally {
      draining = false;
      if (drainAgain) { drainAgain = false; queueMicrotask(kick); }
    }
  };
  const kick = () => { drain().catch(() => console.error('❌ Peer execution drain needs recovery; no retry launch was scheduled.')); };
  const dispatch = async (req, input) => {
    const response = await locked(async () => {
      const pair = await caller(req);
      const previous = await findRequest(pair, input.requestId);
      if (previous) {
        const b = previous.binding;
        if (b.grantId !== input.grantId || b.grantGeneration !== input.grantGeneration || b.evidenceDigest !== input.evidenceDigest
          || b.executionEpoch !== input.executionEpoch || b.receiverVersion !== input.version || hash(b.intent) !== hash(input.intent))
          fail('PEER_EXECUTION_REPLAY_CONFLICT', 'This request identity already belongs to different input.');
        return receipt(previous, pair);
      }
      const key = `${pair.peer.instanceId}:${input.requestId}`;
      const saved = preflights.get(key);
      if (!saved || saved.payload.expiresAt <= now()) fail('PEER_EXECUTION_PREFLIGHT_STALE', 'A fresh receiver preflight is required.');
      const { scope: _scope, senderInstanceId: _sender, targetInstanceId: _target, expiresAt: _expiry, ...expected } = saved.payload;
      if (hash(expected) !== hash(input)) fail('PEER_EXECUTION_PREFLIGHT_STALE', 'Dispatch differs from the signed preflight.');
      await assertCurrent(pair.peer.id, saved.binding);
      const { operation, isNew } = await ledger.consume(saved.binding);
      preflights.delete(key);
      if (isNew) pending.set(operation.operationId, { peerId: pair.peer.id });
      emit();
      return receipt(operation, pair);
    });
    kick();
    return response;
  };
  const reconcileOperation = async operation => {
    const claim = coordinator.getExclusive();
    const owns = claim?.operation.operationId === operation.operationId;
    if (terminal(operation)) {
      await finish(operation, { state: operation.state, code: operation.receipt.code }, owns ? claim : null);
    } else if ((owns && claim.phase !== 'reserved') || ['in-flight', 'awaiting-reconnect', 'uncertain'].includes(operation.state)) {
      const result = await adapters.reconcile(operation);
      if (result && ['succeeded', 'failed'].includes(result.state)) await finish(operation, result, owns ? claim : null);
      else await uncertain(operation, owns ? claim : null);
    } else {
      if (owns) coordinator.settleExclusive(claimRef(claim), { outcome: 'cancelled', receiptDigest: null });
      await finish(operation, { state: 'failed', code: 'PEER_EXECUTION_INTERRUPTED_BEFORE_LAUNCH' }, null);
    }
  };
  const status = (req, { requestId, preflight: envelope }) => locked(async () => {
    const pair = await caller(req);
    let operation = await findRequest(pair, requestId);
    if (!operation && envelope) {
      const payload = envelope.payload;
      if (!peerExecutionPreflightPayloadSchema.safeParse(payload).success
        || !verifyPeerAdminSignature(pair.peer, 'execution-preflight', payload, envelope.signature)
        || payload.requestId !== requestId || payload.senderInstanceId !== pair.peer.instanceId
        || payload.targetInstanceId !== pair.self.instanceId)
        fail('PEER_EXECUTION_RECOVERY_UNVERIFIED', 'The original request preview could not be verified.');
      operation = await ledger.retireUnconsumed({ hostInstanceId: pair.self.instanceId, peerInstanceId: pair.peer.instanceId,
        requestId, grantId: payload.grantId, grantGeneration: payload.grantGeneration, scope: 'execution-v1',
        pairBinding: peerAdminPairBinding(pair.peer, pair.self), intent: payload.intent, receiverVersion: payload.version,
        evidenceDigest: payload.evidenceDigest, executionEpoch: payload.executionEpoch });
      preflights.delete(`${pair.peer.instanceId}:${requestId}`);
    }
    if (!operation) throw peerExecutionError('PEER_EXECUTION_NOT_FOUND', 'Execution request not found.', 404);
    // A deliberate receipt read may observe completion written after server boot.
    // It never dispatches work, retries a launch, or cancels live local work.
    if (!pending.has(operation.operationId) && !running.has(operation.operationId)) {
      await reconcileOperation(operation);
      operation = await ledger.read(operation.operationId);
    }
    return receipt(operation, pair);
  });
  const recover = () => locked(async () => {
    // Reconcile both sides of the terminal-DB -> journal-settle -> resume gap.
    const rows = new Map((await ledger.listActive()).map(row => [row.operationId, row]));
    const owner = coordinator.getExclusive()?.operation.operationId
      ?? coordinator.status().hold?.owner?.match(/^peer-execution:([a-f0-9-]{36})$/)?.[1];
    if (owner && !rows.has(owner)) {
      const operation = await ledger.read(owner);
      if (!operation) fail('PEER_EXECUTION_OWNER_MISSING', 'Maintenance ownership has no matching durable consumption.');
      rows.set(owner, operation);
    }
    for (const operation of rows.values()) await reconcileOperation(operation);
  });
  return { preflight, dispatch, status, recover, kick, drain, notify: emit,
    describe: peerId => locked(() => grants.describe(peerId)),
    saveGrant: async (input, req) => { const result = await locked(() => grants.save(input, req)); emit(); kick(); return result; } };
}
