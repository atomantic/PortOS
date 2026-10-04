/**
 * Bounded peer administration planning. No executor is imported or registered.
 * Grants authorize planning-v1 only; execution needs a separately reviewed
 * maintenance lease, durable operation ledger and a new operator grant scope.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { parseFilesystemStats } from '../lib/fileCore.js';
import { createMutex } from '../lib/asyncMutex.js';
import { ServerError } from '../lib/errorHandler.js';
import { loadData } from './instanceIdentity.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { PEER_ADMIN_ACTIONS, PEER_ADMIN_SCOPE, peerAdminActionSchema } from '../lib/peerAdminValidation.js';
import { LOCAL_LLM_CATALOG, catalogSizeBytes } from '../lib/localLlmCatalog.js';

const PREFLIGHT_TTL_MS = 60_000;
const PLAN_TTL_MS = 5 * 60_000;
const MAX_RECEIPTS = 128;
const MAX_GRANTS = 300;
const withLock = createMutex();
const preflights = new Map();
const plans = new Map();
const grantFile = () => join(PATHS.data, 'peer-admin-grants.json');
const uuid = z.string().uuid();
const grantRecord = z.object({
  id: uuid, peerId: z.string(), peerInstanceId: uuid, hostInstanceId: uuid,
  action: peerAdminActionSchema, scope: z.literal(PEER_ADMIN_SCOPE),
  pairBinding: z.string().regex(/^[a-f0-9]{64}$/),
  allowed: z.boolean(), expiresAt: z.number().int(), createdAt: z.number().int(),
  authority: z.enum(['operator-session', 'local-operator']),
}).strict();
const grantStore = z.object({ schemaVersion: z.literal(1), grants: z.array(grantRecord).max(MAX_GRANTS) }).strict();
const refuse = (code, message, status = 403) => { throw new ServerError(message, { status, code, severity: 'warning' }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameSecret = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const binding = (peer, self) => createHmac('sha256', peer.syncSecret)
  .update(`portos-peer-admin:binding:v1:${self.instanceId}:${peer.id}:${peer.instanceId}`).digest('hex');
const wireGrant = ({ pairBinding: _pairBinding, ...grant }) => grant;

async function readGrants() {
  const raw = await readJSONFile(grantFile(), { schemaVersion: 1, grants: [] }, { strict: true, logError: false });
  const parsed = grantStore.safeParse(raw);
  if (!parsed.success) refuse('PEER_ADMIN_STORE_UNAVAILABLE', 'Peer administration policy is unreadable', 503);
  return parsed.data;
}

export async function peerAdminIdentity(peerId) {
  const { self, peers } = await loadData();
  const peer = peers?.find(entry => entry.id === peerId);
  if (!uuid.safeParse(self?.instanceId).success || !uuid.safeParse(peer?.instanceId).success
    || peer.instanceId === self.instanceId || peer.enabled === false
    || typeof peer.syncSecret !== 'string' || peer.syncSecret.length < 32) {
    refuse('PEER_ADMIN_PAIR_REQUIRED', 'An enabled pair with verified instance identities is required');
  }
  return { peer, self };
}

// Revalidate the CURRENT pair credential at each receiver operation and after
// preflight probes. Names, headers alone, Basic and operator sessions cannot
// impersonate a paired caller on the receiver endpoints, even with auth off.
async function caller(req) {
  if (req.portosAuthContext?.method !== 'peer' || req.portosAuthContext?.authenticated !== true) {
    refuse('PEER_ADMIN_PEER_REQUIRED', 'A scoped paired-peer credential is required');
  }
  const identity = await peerAdminIdentity(req.portosAuthContext.peerId);
  if (req.get(PEER_INSTANCE_HEADER) !== identity.peer.instanceId
    || !sameSecret(req.get(PEER_AUTH_HEADER), derivePeerAuthToken(identity.peer.syncSecret, identity.peer.instanceId))) {
    refuse('PEER_ADMIN_PEER_REQUIRED', 'The paired identity is no longer valid');
  }
  return identity;
}

async function currentGrant(identity, action) {
  const { peer, self } = identity;
  const store = await readGrants();
  const grant = store.grants.find(entry => entry.peerId === peer.id && entry.action === action);
  if (!grant || !grant.allowed || grant.expiresAt <= Date.now() || grant.scope !== PEER_ADMIN_SCOPE
    || grant.peerInstanceId !== peer.instanceId || grant.hostInstanceId !== self.instanceId
    || !sameSecret(grant.pairBinding, binding(peer, self))) {
    refuse('PEER_ADMIN_GRANT_REQUIRED', 'This paired identity has no current grant for that action');
  }
  return grant;
}

export async function describePeerAdminSetup(peerId) {
  const { self, peers } = await loadData();
  const peer = peers?.find(entry => entry.id === peerId);
  if (!peer) refuse('PEER_ADMIN_PEER_NOT_FOUND', 'Peer not found', 404);
  const paired = uuid.safeParse(self?.instanceId).success && uuid.safeParse(peer.instanceId).success
    && peer.instanceId !== self.instanceId && peer.enabled !== false && typeof peer.syncSecret === 'string' && peer.syncSecret.length >= 32;
  const store = await readGrants();
  return {
    scope: PEER_ADMIN_SCOPE, executionSupported: false,
    hostInstanceId: self?.instanceId ?? null, peerId, peerInstanceId: peer.instanceId ?? null, paired,
    actions: PEER_ADMIN_ACTIONS.map(action => {
      const grant = store.grants.find(entry => entry.peerId === peerId && entry.action === action);
      const active = Boolean(paired && grant?.allowed && grant.expiresAt > Date.now()
        && grant.hostInstanceId === self.instanceId && grant.peerInstanceId === peer.instanceId
        && sameSecret(grant.pairBinding, binding(peer, self)));
      return { action, grant: grant ? wireGrant(grant) : null, active };
    }),
  };
}

export const savePeerAdminGrant = (input, req) => withLock(async () => {
  // The route applies requireHostControl; record its server-derived authority,
  // never a caller-supplied operator label or remote display name.
  const registry = await loadData();
  const identity = input.allowPlanning ? await peerAdminIdentity(input.peerId)
    : { self: registry.self, peer: registry.peers?.find(entry => entry.id === input.peerId) };
  const { peer, self } = identity;
  if (!peer || !self) refuse('PEER_ADMIN_PEER_NOT_FOUND', 'Peer or host identity not found', 404);
  if (input.confirmedPeerInstanceId !== peer.instanceId || input.confirmedHostInstanceId !== self.instanceId) {
    refuse('PEER_ADMIN_IDENTITY_CHANGED', 'The confirmed instance identity changed', 409);
  }
  const store = await readGrants();
  const index = store.grants.findIndex(entry => entry.peerId === peer.id && entry.action === input.action);
  if ((store.grants[index]?.id ?? null) !== input.previousGrantId) {
    refuse('PEER_ADMIN_GRANT_CHANGED', 'Refresh the grant before changing it', 409);
  }
  if (!input.allowPlanning && index < 0) refuse('PEER_ADMIN_GRANT_CHANGED', 'There is no grant to revoke', 409);
  const now = Date.now();
  const grant = {
    id: randomUUID(), peerId: peer.id, peerInstanceId: peer.instanceId, hostInstanceId: self.instanceId,
    action: input.action, scope: PEER_ADMIN_SCOPE,
    pairBinding: input.allowPlanning ? binding(peer, self) : store.grants[index].pairBinding,
    allowed: input.allowPlanning, createdAt: now, expiresAt: now + input.expiresInMinutes * 60_000,
    authority: req.portosAuthContext.method === 'session' ? 'operator-session' : 'local-operator',
  };
  if (index >= 0) store.grants[index] = grant;
  else if (store.grants.length < MAX_GRANTS) store.grants.push(grant);
  else refuse('PEER_ADMIN_GRANT_LIMIT', 'The bounded grant store is full', 409);
  await atomicWrite(grantFile(), store);
  return describePeerAdminSetup(peer.id);
});

function sweep() {
  const now = Date.now();
  for (const map of [preflights, plans]) for (const [id, value] of map) if (value.expiresAt <= now) map.delete(id);
}

export function signPeerAdmin(peer, purpose, payload) {
  return createHmac('sha256', peer.syncSecret).update(`portos-peer-admin:v1:${purpose}:${JSON.stringify(payload)}`).digest('hex');
}
export const verifyPeerAdminSignature = (peer, purpose, payload, signature) => sameSecret(signPeerAdmin(peer, purpose, payload), signature);

function catalogTarget(intent) {
  if (intent.action !== 'catalog.install') return null;
  const entry = LOCAL_LLM_CATALOG.find(model => model.key === intent.catalogKey && model[intent.backend]);
  if (!entry) refuse('PEER_ADMIN_UNKNOWN_MODEL', 'Choose an existing catalog entry for this backend', 400);
  if (entry.gated || entry.ollamaImport || entry.appleSiliconOnly && (process.platform !== 'darwin' || process.arch !== 'arm64')) {
    refuse('PEER_ADMIN_MODEL_UNSUPPORTED', 'This catalog entry requires local setup or source review', 409);
  }
  return {
    catalogKey: entry.key, backend: intent.backend, modelId: entry[intent.backend],
    estimatedDownloadBytes: catalogSizeBytes(intent.backend, entry[intent.backend]),
    sourceLicenseReview: 'required-locally',
  };
}

async function resourceSnapshot() {
  const disk = await statfs(PATHS.data).catch(() => null);
  return {
    dataVolumeFreeBytes: parseFilesystemStats(disk)?.freeBytes ?? null,
    totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
    // Data-volume space and OS free memory are advisory; model destinations,
    // inference residency and an exclusive maintenance lease are not checked.
    destinationDiskChecked: false, runtimeMemoryChecked: false,
  };
}

export const createPeerAdminPreflight = (req, input) => withLock(async () => {
  sweep();
  const identity = await caller(req);
  const grant = await currentGrant(identity, input.intent.action);
  const model = catalogTarget(input.intent);
  if (preflights.has(input.challenge)) refuse('PEER_ADMIN_REPLAY', 'Use a fresh preflight challenge', 409);
  if (preflights.size >= MAX_RECEIPTS) refuse('PEER_ADMIN_BUSY', 'Too many outstanding preflights', 429);
  const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const resources = await resourceSnapshot();
  // Re-read after probes, so rotation/revocation during I/O invalidates admission.
  const fresh = await caller(req);
  const freshGrant = await currentGrant(fresh, input.intent.action);
  if (freshGrant.id !== grant.id) refuse('PEER_ADMIN_GRANT_CHANGED', 'Grant changed during preflight', 409);
  const now = Date.now();
  const payload = {
    protocolVersion: 1, scope: PEER_ADMIN_SCOPE, challenge: input.challenge, preflightId: randomUUID(),
    senderInstanceId: fresh.peer.instanceId, targetInstanceId: fresh.self.instanceId,
    version, grantId: grant.id, intent: input.intent, model, resources,
    observedAt: now, expiresAt: Math.min(now + PREFLIGHT_TTL_MS, grant.expiresAt),
    executionSupported: false, maintenance: 'exclusive-lease-unavailable',
    blockers: ['MAINTENANCE_EXECUTOR_UNAVAILABLE', ...(model ? ['MODEL_SOURCE_LICENSE_REVIEW_REQUIRED', 'MODEL_DESTINATION_PREFLIGHT_REQUIRED', 'MODEL_RUNTIME_MEMORY_PREFLIGHT_REQUIRED'] : [])],
  };
  const record = { ...payload, peerId: fresh.peer.id, consumedBy: null };
  preflights.set(input.challenge, record);
  return { payload, signature: signPeerAdmin(fresh.peer, 'preflight', payload) };
});

export const createPeerAdminPlan = (req, input) => withLock(async () => {
  sweep();
  const identity = await caller(req);
  const grant = await currentGrant(identity, input.intent.action);
  if (grant.id !== input.grantId) refuse('PEER_ADMIN_GRANT_CHANGED', 'The preflight grant is stale', 409);
  const key = `${identity.peer.id}:${input.requestId}`;
  const previous = plans.get(key);
  if (previous) {
    if (previous.fingerprint !== digest(input)) refuse('PEER_ADMIN_REPLAY', 'Request identity was reused with different input', 409);
    return { payload: previous.payload, signature: signPeerAdmin(identity.peer, 'plan', previous.payload) };
  }
  const preflight = [...preflights.values()].find(entry => entry.preflightId === input.preflightId && entry.peerId === identity.peer.id);
  if (!preflight || preflight.expiresAt <= Date.now() || preflight.consumedBy) {
    refuse('PEER_ADMIN_PREFLIGHT_STALE', 'A fresh, unused preflight is required', 409);
  }
  if (preflight.grantId !== grant.id || digest(preflight.intent) !== digest(input.intent)
    || preflight.targetInstanceId !== identity.self.instanceId || preflight.senderInstanceId !== identity.peer.instanceId) {
    refuse('PEER_ADMIN_PREFLIGHT_STALE', 'The preflight no longer matches this request', 409);
  }
  if (plans.size >= MAX_RECEIPTS) refuse('PEER_ADMIN_BUSY', 'Too many outstanding plans', 429);
  const now = Date.now();
  const payload = {
    protocolVersion: 1, scope: PEER_ADMIN_SCOPE, requestId: input.requestId, preflightId: input.preflightId,
    grantId: grant.id, senderInstanceId: identity.peer.instanceId, targetInstanceId: identity.self.instanceId,
    intent: input.intent, version: preflight.version, createdAt: now,
    expiresAt: Math.min(now + PLAN_TTL_MS, grant.expiresAt), state: 'planned',
    queued: false, inFlight: false, executionSupported: false, blockers: preflight.blockers,
  };
  preflight.consumedBy = input.requestId;
  plans.set(key, { fingerprint: digest(input), payload, expiresAt: payload.expiresAt });
  return { payload, signature: signPeerAdmin(identity.peer, 'plan', payload) };
});

export const getPeerAdminPlan = (req, requestId) => withLock(async () => {
  sweep();
  const identity = await caller(req);
  const receipt = plans.get(`${identity.peer.id}:${requestId}`);
  if (!receipt) refuse('PEER_ADMIN_PLAN_NOT_FOUND', 'Plan expired or not found; it has not been queued', 404);
  const grant = await currentGrant(identity, receipt.payload.intent.action);
  if (grant.id !== receipt.payload.grantId) refuse('PEER_ADMIN_GRANT_CHANGED', 'The plan grant is stale', 409);
  return { payload: receipt.payload, signature: signPeerAdmin(identity.peer, 'plan', receipt.payload) };
});

export async function rejectPeerAdminExecution(req, requestId) {
  await getPeerAdminPlan(req, requestId);
  refuse('PEER_ADMIN_EXECUTION_UNAVAILABLE', 'Planning only: no work was queued or started. Exclusive maintenance and execution reconciliation are required.', 503);
}
