// Read-only bilateral evidence exchange. A pair credential proves possession;
// a fresh challenge binds the exact response to this request, never to a third peer.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { peerFetch, readPeerBody, derivePeerAuthToken } from '../../lib/peerHttpClient.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { isPairedPeer } from '../../lib/peerPairing.js';
import { canonicalStringify } from '../../lib/objects.js';
import { findPeerById, peerAllowsOutbound, peerAllowsCategoryPull } from '../sharing/peerSyncShared.js';
import { getInstanceId, UNKNOWN_INSTANCE_ID } from '../instanceIdentity.js';
import { fail } from './snapshots.js';

const bindings = new WeakMap();
export async function revalidateEvidence(value) {
  const binding = bindings.get(value);
  if (!binding) fail('Missing verified peer evidence', 'CATALOG_IDENTITY_EVIDENCE_INVALID', 403);
  const peer = await identityPeer(binding.owner);
  if (await localIdentity() !== binding.self || peer.syncSecret !== binding.secret || peerBaseUrl(peer) !== binding.url) {
    fail('Owner or peer binding changed during operation', 'CATALOG_IDENTITY_EVIDENCE_INVALID', 403);
  }
}
const mac = (secret, value) => createHmac('sha256', secret).update(`portos-catalog-identity:v1:${canonicalStringify(value)}`).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a)
  && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
export async function identityPeer(instanceId) {
  const peer = await findPeerById(instanceId);
  if (!peer || peer.instanceId !== instanceId || !peerAllowsOutbound(peer)
      || !peerAllowsCategoryPull(peer, 'catalog') || !peer.directions?.includes('inbound') || !isPairedPeer(peer)) {
    fail('A currently paired, enabled catalog peer with outbound sharing is required', 'CATALOG_IDENTITY_PEER_FORBIDDEN', 403);
  }
  return peer;
}
export async function localIdentity() {
  const id = await getInstanceId();
  if (!id || id === UNKNOWN_INSTANCE_ID) fail('Local owner identity unavailable');
  return id;
}
export async function authenticateIdentityPeer(req) {
  const caller = req.headers['x-portos-instance-id'];
  if (typeof caller !== 'string') fail('Paired identity required', 'CATALOG_IDENTITY_PEER_FORBIDDEN', 403);
  const peer = await identityPeer(caller);
  if (!equal(req.headers['x-portos-peer-auth'], derivePeerAuthToken(peer.syncSecret, caller))) {
    fail('Paired identity required', 'CATALOG_IDENTITY_PEER_FORBIDDEN', 403);
  }
  return peer;
}
export function signEvidence(peer, { owner, challenge, kind, target, value }) {
  const evidence = { version: 1, owner, audience: peer.instanceId, challenge, kind, target, value };
  return { ...evidence, mac: mac(peer.syncSecret, evidence) };
}
export async function readEvidence(owner, kind, target) {
  const self = await localIdentity();
  const peer = await identityPeer(owner);
  const challenge = randomBytes(32).toString('hex');
  const key = kind === 'snapshot' ? 'ingredientId' : 'operationId';
  const path = kind === 'snapshot' ? '/api/catalog/identity/peer/snapshot' : '/api/catalog/identity/peer/status';
  const url = `${peerBaseUrl(peer)}${path}?${new URLSearchParams({ [key]: target, challenge })}`;
  let body;
  try {
    // Strip Basic auth even during legacy pairing discovery. This protocol has
    // no password fallback, and does not provision or change a pair secret.
    const response = await peerFetch(url, { signal: AbortSignal.timeout(15000), maxBytes: 16 * 1024 * 1024,
      headers: { 'X-PortOS-Instance-Id': self, 'X-PortOS-Peer-Auth': derivePeerAuthToken(peer.syncSecret, self) } },
    { ...peer, auth: undefined, peerAuthAccepted: true });
    if (!response.ok) fail('Peer refused identity evidence', 'CATALOG_IDENTITY_PEER_UNAVAILABLE', 503);
    body = await readPeerBody(response, 'json', { maxBytes: 16 * 1024 * 1024, idleTimeoutMs: 15000 });
  } catch {
    fail('Peer evidence unavailable; operation is unchanged. Retry this receipt, not a new operation.', 'CATALOG_IDENTITY_PEER_UNAVAILABLE', 503);
  }
  const { mac: signature, ...evidence } = body ?? {};
  if (evidence.version !== 1 || evidence.owner !== owner || evidence.audience !== self || evidence.challenge !== challenge
      || evidence.kind !== kind || evidence.target !== target || !equal(signature, mac(peer.syncSecret, evidence))) {
    fail('Peer evidence authentication failed', 'CATALOG_IDENTITY_EVIDENCE_INVALID', 403);
  }
  // Re-read pair configuration after the network wait. Revocation during the
  // request invalidates the result, including pair-secret replacement.
  const fresh = await identityPeer(owner);
  if (fresh.syncSecret !== peer.syncSecret || peerBaseUrl(fresh) !== peerBaseUrl(peer) || await localIdentity() !== self) fail('Pair binding changed during evidence request', 'CATALOG_IDENTITY_EVIDENCE_INVALID', 403);
  if (!evidence.value || typeof evidence.value !== 'object') fail('Invalid owner evidence');
  bindings.set(evidence.value, { owner, self, secret: peer.syncSecret, url: peerBaseUrl(peer) });
  return evidence.value;
}
