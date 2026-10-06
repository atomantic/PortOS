import { randomUUID } from 'node:crypto';
import { peerFetch, readPeerBody } from '../lib/peerHttpClient.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { canonicalStringify } from '../lib/objects.js';
import { ServerError } from '../lib/errorHandler.js';
import { PEER_ADMIN_SCOPE, peerExecutionPreflightPayloadSchema, peerExecutionReceiptPayloadSchema } from '../lib/peerAdminValidation.js';
import { peerAdminIdentity, verifyPeerAdminSignature } from './peerAdministration.js';

const failed = () => { throw new ServerError('Peer administration response could not be verified. No execution was requested.', { status: 502, code: 'PEER_ADMIN_UNVERIFIED_RESPONSE' }); };

const ENDPOINTS = Object.freeze({
  preflight: '/api/federation/admin/v1/preflight',
  plans: '/api/federation/admin/v1/plans',
  executionPreflight: '/api/federation/admin/v1/execution/preflight',
  executionDispatch: '/api/federation/admin/v1/execution/dispatch',
  executionStatus: '/api/federation/admin/v1/execution/status',
});

async function exchange(peer, endpoint, body, signal) {
  const response = await peerFetch(`${peerBaseUrl(peer)}${ENDPOINTS[endpoint]}`, {
    method: 'POST', signal, maxBytes: 64 * 1024,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    // Suppress the legacy Basic fallback even if this peer has not yet
    // advertised pair support. No caller session or broad credential is sent.
  }, { ...peer, auth: null, peerAuthAccepted: true });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ServerError('The peer refused administration. Check pairing, its local grant and protocol support.', {
      status: 502, code: 'PEER_ADMIN_REMOTE_REFUSED',
    });
  }
  return readPeerBody(response, 'json', { maxBytes: 64 * 1024, idleTimeoutMs: 5000 });
}

function verified(peer, self, envelope, purpose) {
  const payload = envelope?.payload;
  if (!payload || !verifyPeerAdminSignature(peer, purpose, payload, envelope.signature)
    || payload.protocolVersion !== 1 || payload.scope !== PEER_ADMIN_SCOPE
    || payload.targetInstanceId !== peer.instanceId || payload.senderInstanceId !== self.instanceId
    || payload.executionSupported !== false || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt <= Date.now()) failed();
  return payload;
}

/** An operator-requested preview only. Never retries a mutation on uncertainty. */
export async function planPeerAdministration({ peerId, intent }) {
  const { peer, self } = await peerAdminIdentity(peerId);
  const requestId = randomUUID();
  const challenge = randomUUID();
  const signal = AbortSignal.timeout(10_000); // one budget for BOTH hops + bodies
  const run = async () => {
    const preflight = verified(peer, self, await exchange(peer, 'preflight', { protocolVersion: 1, challenge, intent }, signal), 'preflight');
    if (preflight.challenge !== challenge || JSON.stringify(preflight.intent) !== JSON.stringify(intent)
      || !Number.isSafeInteger(preflight.observedAt) || preflight.observedAt > Date.now() + 5000
      || preflight.observedAt < Date.now() - 60_000 || preflight.expiresAt > preflight.observedAt + 60_000
      || typeof preflight.version !== 'string') failed();
    // Never borrow a credential/identity after an operator changed the peer
    // during the first hop. The receiver separately checks its current grant.
    const fresh = await peerAdminIdentity(peerId);
    if (fresh.peer.syncSecret !== peer.syncSecret || fresh.peer.instanceId !== peer.instanceId
      || fresh.self.instanceId !== self.instanceId || peerBaseUrl(fresh.peer) !== peerBaseUrl(peer)) failed();
    const plan = verified(peer, self, await exchange(peer, 'plans', {
      protocolVersion: 1, requestId, preflightId: preflight.preflightId, grantId: preflight.grantId, intent,
    }, signal), 'plan');
    if (plan.requestId !== requestId || plan.preflightId !== preflight.preflightId || plan.grantId !== preflight.grantId
      || plan.version !== preflight.version || JSON.stringify(plan.intent) !== JSON.stringify(intent)
      || plan.state !== 'planned' || plan.queued !== false || plan.inFlight !== false) failed();
    return { preflight, plan };
  };
  return run().catch(error => {
    if (error instanceof ServerError) throw error;
    throw new ServerError('Peer planning timed out or became unavailable. No execution was requested; preview again for a fresh plan.', {
      status: 504, code: 'PEER_ADMIN_UNAVAILABLE',
    });
  });
}


const executionFailed = () => {
  throw new ServerError('The peer execution response could not be verified. Check the saved request status before requesting another action.', {
    status: 502, code: 'PEER_EXECUTION_UNVERIFIED_RESPONSE',
  });
};

function verifiedExecution(peer, self, envelope, purpose, requestId) {
  const payload = envelope?.payload;
  if (!payload || !verifyPeerAdminSignature(peer, purpose, payload, envelope.signature)
    || payload.protocolVersion !== 1 || payload.scope !== 'execution-v1'
    || payload.targetInstanceId !== peer.instanceId || payload.senderInstanceId !== self.instanceId
    || payload.requestId !== requestId) executionFailed();
  return payload;
}

function verifiedExecutionPreflight(peer, self, envelope, requestId) {
  const payload = verifiedExecution(peer, self, envelope, 'execution-preflight', requestId);
  if (!peerExecutionPreflightPayloadSchema.safeParse(payload).success
    || payload.expiresAt <= Date.now() || payload.expiresAt > Date.now() + 60_000) executionFailed();
  return payload;
}

async function unchangedPair(peerId, peer, self) {
  const fresh = await peerAdminIdentity(peerId);
  if (fresh.peer.syncSecret !== peer.syncSecret || fresh.peer.instanceId !== peer.instanceId
    || fresh.self.instanceId !== self.instanceId || peerBaseUrl(fresh.peer) !== peerBaseUrl(peer)) executionFailed();
}

const executionUnavailable = error => {
  if (error instanceof ServerError) throw error;
  throw new ServerError('Peer execution is unavailable or the response timed out. Preserve this request and check its status; do not repeat dispatch.', {
    status: 504, code: 'PEER_EXECUTION_UNAVAILABLE',
  });
};

/** Preflight authorizes no work. Preserve its signed envelope through the UI. */
export async function preparePeerExecution({ peerId, intent }) {
  const { peer, self } = await peerAdminIdentity(peerId);
  const requestId = randomUUID();
  const envelope = await exchange(peer, 'executionPreflight', { protocolVersion: 1, requestId, intent }, AbortSignal.timeout(10_000))
    .catch(executionUnavailable);
  const payload = verifiedExecutionPreflight(peer, self, envelope, requestId);
  if (canonicalStringify(payload.intent) !== canonicalStringify(intent)) executionFailed();
  await unchangedPair(peerId, peer, self);
  return envelope;
}

function verifiedExecutionReceipt(peer, self, envelope, requestId) {
  const payload = verifiedExecution(peer, self, envelope, 'execution-receipt', requestId);
  if (!peerExecutionReceiptPayloadSchema.safeParse(payload).success) executionFailed();
  return payload;
}

/** Exactly one dispatch attempt; a lost response is recovered through status. */
export async function dispatchPeerExecution({ peerId, preflight }) {
  const { peer, self } = await peerAdminIdentity(peerId);
  const payload = verifiedExecutionPreflight(peer, self, preflight, preflight?.payload?.requestId);
  const { requestId, grantId, grantGeneration, intent, evidenceDigest, executionEpoch, version } = payload;
  const envelope = await exchange(peer, 'executionDispatch', {
    protocolVersion: 1, requestId, grantId, grantGeneration, intent, evidenceDigest, executionEpoch, version,
  }, AbortSignal.timeout(10_000)).catch(executionUnavailable);
  await unchangedPair(peerId, peer, self);
  return verifiedExecutionReceipt(peer, self, envelope, requestId);
}

export async function getPeerExecutionStatus({ peerId, requestId }) {
  const { peer, self } = await peerAdminIdentity(peerId);
  const envelope = await exchange(peer, 'executionStatus', { requestId }, AbortSignal.timeout(10_000)).catch(executionUnavailable);
  await unchangedPair(peerId, peer, self);
  return verifiedExecutionReceipt(peer, self, envelope, requestId);
}
