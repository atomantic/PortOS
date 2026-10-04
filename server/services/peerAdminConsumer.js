import { randomUUID } from 'node:crypto';
import { peerFetch, readPeerBody } from '../lib/peerHttpClient.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { ServerError } from '../lib/errorHandler.js';
import { PEER_ADMIN_SCOPE } from '../lib/peerAdminValidation.js';
import { peerAdminIdentity, verifyPeerAdminSignature } from './peerAdministration.js';

const failed = () => { throw new ServerError('Peer administration response could not be verified. No execution was requested.', { status: 502, code: 'PEER_ADMIN_UNVERIFIED_RESPONSE' }); };

const ENDPOINTS = Object.freeze({
  preflight: '/api/federation/admin/v1/preflight',
  plans: '/api/federation/admin/v1/plans',
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
    throw new ServerError('The peer refused administration planning. Check pairing, its local grant and protocol support.', {
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
