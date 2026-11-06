// A local-only report exchanged with one currently paired usage peer. Never a
// fleet export: hashed accounting identities may travel, native records may not.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { canonicalStringify } from '../lib/objects.js';
import { ServerError } from '../lib/errorHandler.js';
import { RESPONSE_TOO_LARGE } from '../lib/httpClient.js';
import { peerStreamRequest, readPeerBody, derivePeerAuthToken } from '../lib/peerHttpClient.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { isPairedPeer } from '../lib/peerPairing.js';
import { nativeUsageReportSchema, nativeUsageParticipantKey, reportIsIntact } from '../lib/nativeUsageContract.js';
import { loadData, UNKNOWN_INSTANCE_ID } from './instanceIdentity.js';
import { peerAllowsCategoryPull } from './sharing/peerSyncShared.js';
import { captureDashboardNativeUsageReport } from './nativeUsageReport.js';

export const NATIVE_USAGE_PEER_MAX_BYTES = 16 * 1024 * 1024;
export const NATIVE_USAGE_PEER_TIMEOUT_MS = 60_000;
const MAX_AGE_MS = 5 * 60_000;
const FUTURE_ALLOWANCE_MS = 30_000;
const bindings = new WeakMap();
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const participant = z.string().regex(/^[a-f0-9]{32}$/);
const envelopeSchema = z.strictObject({
  protocolVersion: z.literal(1), sourceParticipantKey: participant, audienceParticipantKey: participant,
  challenge: hex, report: nativeUsageReportSchema, signature: hex,
});
const fail = (code, status = 403) => {
  throw new ServerError('Native usage peer report unavailable or unverified. Existing usage records are unchanged.', { code, status, severity: 'warning' });
};
const transportFailed = error => fail(error?.code === RESPONSE_TOO_LARGE
  ? 'NATIVE_USAGE_PEER_REPORT_TOO_LARGE' : 'NATIVE_USAGE_PEER_UNAVAILABLE', error?.code === RESPONSE_TOO_LARGE ? 413 : 503);
const validInstanceId = id => typeof id === 'string' && id.length > 0 && id.length <= 128 && id !== UNKNOWN_INSTANCE_ID;
const equal = (left, right) => hex.safeParse(left).success && hex.safeParse(right).success
  && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
const signatureOf = (secret, payload) => createHmac('sha256', secret)
  .update(`portos-native-usage-report:v1:${canonicalStringify(payload)}`).digest('hex');

/** The same category/direction policy applies to collection and disclosure. */
export const nativeUsagePeerEligible = peer => validInstanceId(peer?.instanceId)
  && isPairedPeer(peer) && peerAllowsCategoryPull(peer, 'usage');

async function peerIdentity(instanceId) {
  const data = await loadData().catch(() => null);
  const matches = (Array.isArray(data?.peers) ? data.peers : []).filter(candidate => candidate?.instanceId === instanceId);
  const peer = matches.length === 1 ? matches[0] : null;
  const self = data?.self?.instanceId;
  if (!validInstanceId(self) || self === instanceId || !nativeUsagePeerEligible(peer)) fail('NATIVE_USAGE_PEER_FORBIDDEN');
  // Retain a binding, not a mutable reference a registry writer could change.
  return { self, peer: { ...peer }, url: peerBaseUrl(peer) };
}

/** Recheck an earlier result after the collector finishes its other peer reads. */
export async function revalidateNativeUsagePeerReport(report) {
  const identity = bindings.get(report);
  if (!identity) fail('NATIVE_USAGE_PEER_UNVERIFIED', 502);
  assertUnchanged(identity, await peerIdentity(identity.peer.instanceId));
  validatedReport(report, nativeUsageParticipantKey(identity.peer.instanceId));
}

async function authenticateRequest(req) {
  const instanceId = req.headers?.['x-portos-instance-id'];
  if (!validInstanceId(instanceId)) fail('NATIVE_USAGE_PEER_FORBIDDEN');
  const identity = await peerIdentity(instanceId);
  if (!equal(req.headers?.['x-portos-peer-auth'], derivePeerAuthToken(identity.peer.syncSecret, instanceId))) {
    fail('NATIVE_USAGE_PEER_FORBIDDEN');
  }
  return identity;
}

function assertUnchanged(before, after) {
  if (before.self !== after.self || before.peer.id !== after.peer.id
    || before.peer.instanceId !== after.peer.instanceId || before.peer.syncSecret !== after.peer.syncSecret
    || before.url !== after.url) fail('NATIVE_USAGE_PEER_UNVERIFIED', 502);
}

function validatedReport(raw, expectedParticipant) {
  const parsed = nativeUsageReportSchema.safeParse(raw);
  if (!parsed.success || parsed.data.contractVersion !== 4 || !reportIsIntact(parsed.data)
    || parsed.data.participantKey !== expectedParticipant) fail('NATIVE_USAGE_PEER_UNVERIFIED', 502);
  const report = parsed.data;
  const captured = Date.parse(report.capturedAt);
  const now = Date.now();
  if (!Number.isFinite(captured) || new Date(captured).toISOString() !== report.capturedAt
    || captured < now - MAX_AGE_MS || captured > now + FUTURE_ALLOWANCE_MS) fail('NATIVE_USAGE_PEER_STALE', 502);
  return report;
}

/** Pair-only HTTP handler service. No Basic, anonymous, or operator shortcut. */
export async function getNativeUsagePeerReport(req, challenge) {
  if (!hex.safeParse(challenge).success) fail('VALIDATION_ERROR', 400);
  const identity = await authenticateRequest(req);
  const raw = await captureDashboardNativeUsageReport().catch(() => fail('NATIVE_USAGE_PEER_UNAVAILABLE', 503));
  const report = validatedReport(raw, nativeUsageParticipantKey(identity.self));
  assertUnchanged(identity, await authenticateRequest(req));
  const payload = {
    protocolVersion: 1, sourceParticipantKey: report.participantKey,
    audienceParticipantKey: nativeUsageParticipantKey(identity.peer.instanceId), challenge, report,
  };
  const envelope = { ...payload, signature: signatureOf(identity.peer.syncSecret, payload) };
  if (Buffer.byteLength(JSON.stringify(envelope)) > NATIVE_USAGE_PEER_MAX_BYTES) fail('NATIVE_USAGE_PEER_REPORT_TOO_LARGE', 413);
  return envelope;
}

/** One bounded, challenge-bound read. A failure never returns a cached report. */
export async function readNativeUsagePeerReport(instanceId) {
  const identity = await peerIdentity(instanceId);
  const { peer, self, url } = identity;
  const challenge = randomBytes(32).toString('hex');
  const signal = AbortSignal.timeout(NATIVE_USAGE_PEER_TIMEOUT_MS);
  // Stream both HTTP and HTTPS: peerFetch's HTTPS shim buffers the whole body
  // before returning, which would bypass readPeerBody's per-chunk idle deadline.
  const response = await peerStreamRequest(`${url}/api/usage/native-report/v1?${new URLSearchParams({ challenge })}`, {
    signal,
    headers: { 'X-PortOS-Instance-Id': self, 'X-PortOS-Peer-Auth': derivePeerAuthToken(peer.syncSecret, self) },
  }, { ...peer, auth: undefined, peerAuthAccepted: true }).catch(transportFailed);
  if (response.status < 200 || response.status >= 300) {
    response.stream.destroy();
    if (response.status === 413) fail('NATIVE_USAGE_PEER_REPORT_TOO_LARGE', 413);
    if (response.status === 401 || response.status === 403) fail('NATIVE_USAGE_PEER_FORBIDDEN');
    fail('NATIVE_USAGE_PEER_UNAVAILABLE', 503);
  }
  if (Number(response.headers['content-length']) > NATIVE_USAGE_PEER_MAX_BYTES) {
    response.stream.destroy();
    fail('NATIVE_USAGE_PEER_REPORT_TOO_LARGE', 413);
  }
  const body = await readPeerBody(new Response(Readable.toWeb(response.stream)), 'json', {
    maxBytes: NATIVE_USAGE_PEER_MAX_BYTES, idleTimeoutMs: 5000,
  }).finally(() => response.stream.destroy())
    .catch(transportFailed);
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) fail('NATIVE_USAGE_PEER_UNVERIFIED', 502);
  const { signature, ...payload } = parsed.data;
  if (payload.sourceParticipantKey !== nativeUsageParticipantKey(instanceId)
    || payload.audienceParticipantKey !== nativeUsageParticipantKey(self) || payload.challenge !== challenge
    || !equal(signature, signatureOf(peer.syncSecret, payload))) fail('NATIVE_USAGE_PEER_UNVERIFIED', 502);
  const report = validatedReport(payload.report, payload.sourceParticipantKey);
  assertUnchanged(identity, await peerIdentity(instanceId));
  bindings.set(report, identity);
  return report;
}
