/**
 * Federated peer-sync shared kernel: the subscription state machine (file read/write + serialized
 * write tail), error constants, predicates, the subscribable-kind list, the kind→category map,
 * peer-capability predicates and the event bus. The leaf of the peer-sync graph (imports no
 * siblings, so no evaluation-order cycle); split out of the former peerSync.js (#1830).
 */
import { join } from 'path';
import { EventEmitter } from 'events';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import { getPeers, resolveEffectiveCategories } from '../instances.js';

import { KIND_TO_CATEGORY } from '../../lib/instanceSyncCategories.js';

export { PEER_SUBSCRIBABLE_KINDS, KIND_TO_CATEGORY } from '../../lib/instanceSyncCategories.js';

/**
 * The optional top-level keys a NEWER sender may attach to a push envelope beyond the
 * `{ kind, record, assetManifest, sourceInstanceId }` core (`server/lib/schemaVersions.js`).
 * Every row shares ONE lifecycle that both wire sides drive off this table (#6844):
 *
 *   1. STRIP: an older receiver's `.strict()` push schema 400-rejects the envelope naming the
 *      key; the sender drops the named keys and retries once, and the next push re-includes them.
 *   2. PENDING: `pendingKey` is the response flag the RECEIVER raises when that bundle's merge
 *      threw after the record merged (2xx); the sender reads it and counts its own strip as pending.
 *   3. WITHHOLD: while pending, the sender withholds `lastPushedHash` so the next cycle re-sends
 *      (`resolvePushWatermarks` in peerSyncPush.js, #3928's `lastPushedLegacyHash`); the sidecar
 *      rows also form the change-hash input (`pushPayloadHash`).
 *
 * `pendingKey: null` marks a key with its OWN reconciliation cycle (`portosMeta` via the
 * version-gate handshake, `catalogBundle` via catalog sync); the three sidecar docs have none.
 *
 * Wire names are frozen (`server/lib/peerSyncValidation.js` validates the keys). Adding a doc is
 * one row plus build/merge hooks, never a new flag pair; `peerSync.test.js` ("envelope
 * extensions") fails until every row has a carrier on both sides.
 */
export const ENVELOPE_EXTENSIONS = Object.freeze([
  // The schema-version handshake (`buildPortosMeta`); a pre-version-gate
  // receiver's strict schema has no field for it.
  Object.freeze({ key: 'portosMeta', pendingKey: null }),
  // Catalog-federation enrichment riding a universe push; a peer newer than
  // the version gate but older than catalog federation rejects it.
  Object.freeze({ key: 'catalogBundle', pendingKey: null }),
  // The "Finish the draft" manuscript-review doc riding a series push.
  Object.freeze({ key: 'manuscriptReview', pendingKey: 'reviewSyncPending' }),
  // The scene-by-scene reverse outline riding a series push (#1348).
  Object.freeze({ key: 'reverseOutline', pendingKey: 'outlineSyncPending' }),
  // The linked track record riding a musicVideoProject push (#1858) — a
  // musicVideoProjects-only subscriber has no `tracks` cycle to fall back on.
  Object.freeze({ key: 'linkedTrack', pendingKey: 'trackSyncPending' }),
  Object.freeze({ key: 'bibleManifest', pendingKey: 'bibleSyncPending' }),
]);

/**
 * Envelope key → the receiver's pending flag, for the sidecar rows only
 * (derived from ENVELOPE_EXTENSIONS; the self-reconciling keys are absent).
 */
export const ENVELOPE_PENDING_KEYS = Object.freeze(Object.fromEntries(
  ENVELOPE_EXTENSIONS.filter((e) => e.pendingKey).map((e) => [e.key, e.pendingKey]),
));

/**
 * Cross-cutting event bus for the peer-sync receiver. The asset-pull worker emits `asset-arrived`
 * ({ filename, kind, peerId }); `sharing/index.js` relays it to a socket so MediaImage swaps its
 * placeholder without polling. `maybeCreateReverseSubscription` emits `subscription-created`
 * ({ peerId, recordKind, recordId, subId }), relayed as `peerSync:subscription:created`.
 */
export const peerSyncEvents = new EventEmitter();
peerSyncEvents.setMaxListeners(100);

export const ERR_NOT_FOUND = 'PEER_SYNC_SUBSCRIPTION_NOT_FOUND';
export const ERR_VALIDATION = 'PEER_SYNC_SUBSCRIPTION_VALIDATION';
// Receiver-side rejection: the payload's `portosMeta.schemaVersions` is ahead of ours for some
// category. The HTTP route maps it to 409 + { ahead, behind, senderPortosVersion } so the sender
// can persist the gap on the subscription and show it in the UI.
export const ERR_SCHEMA_VERSION_AHEAD = 'PEER_SYNC_SCHEMA_VERSION_AHEAD';
export const makeErr = (message, code, details = null) => {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
};

const STATE_PATH = () => join(PATHS.data, 'sharing', 'peer_subscriptions.json');
export const DEBOUNCE_MS = 3000;
export const PUSH_TIMEOUT_MS = 30000;

export function subscriptionId({ peerId, recordKind, recordId }) {
  return `peer-${recordKind}-${recordId}-${peerId}`;
}

export async function readState() {
  await ensureDir(join(PATHS.data, 'sharing'));
  // Strict: every mutation writes this value back, and a swallowed read failure would replace the whole federation with one row.
  const raw = await readJSONFile(STATE_PATH(), { subscriptions: [] }, { logError: false, strict: true });
  const subs = Array.isArray(raw?.subscriptions) ? raw.subscriptions : [];
  return { subscriptions: subs };
}

export async function writeState(state) {
  await ensureDir(join(PATHS.data, 'sharing'));
  await atomicWrite(STATE_PATH(), state);
}

// Serialize every readState→modify→writeState pair through one tail promise: the fire-and-forget
// push pipeline's `persistPushDeliveryEvidence` writes race the subscribe's writes to the same file
// and can clobber a just-persisted record in either order. A module-level tail suffices.
let writeTail = Promise.resolve();
export function withStateLock(fn) {
  const next = writeTail.then(() => fn(), () => fn());
  writeTail = next.catch(() => {});
  return next;
}

// The half every outbound predicate shares: the peer exists, is not disabled, and the relationship was
// established FROM here. Absent/empty `directions` is legacy (permissive); `['inbound']` is a peer that
// merely announced itself (auto-created, no approval), so nothing flows back out to it.
export function peerOutboundEligible(peer) {
  if (!peer || peer.enabled === false) return false;
  const directions = Array.isArray(peer.directions) ? peer.directions : [];
  return directions.length === 0 || directions.includes('outbound');
}

export function peerAllowsOutbound(peer) {
  if (!peerOutboundEligible(peer)) return false;
  // `syncEnabled` is the global per-peer toggle (separate from `syncCategories.*`): when off, auto-subscribe
  // MUST NOT create subscriptions or push, since the category check alone would leak to a silenced peer.
  if (peer.syncEnabled === false) return false;
  return true;
}

/**
 * Category-level counterpart of `peerHasCategory` for the snapshot transport
 * (`server/routes/dataSync.js`), whose unit of consent is a sync CATEGORY. Resolves through
 * `resolveEffectiveCategories` so the pull gate agrees with the sync loop and settings UI,
 * including the master `syncEnabled` switch masking down to default-ON categories (so `usage`
 * still flows for a peer the user otherwise silenced).
 */
export function peerAllowsCategoryPull(peer, category) {
  if (!peerOutboundEligible(peer)) return false;
  // `resolveEffectiveCategories` short-circuits `fullSync` BEFORE the master-switch mask: right for
  // deciding what to ASK for, wrong for what to HAND OUT (`{ fullSync: true, syncEnabled: false }`
  // would pass every category while `peerAllowsOutbound` refuses pushes). Drop fullSync so the mask wins.
  const masked = peer.syncEnabled === false ? { ...peer, fullSync: false } : peer;
  return resolveEffectiveCategories(masked)[category] === true;
}

export function peerHasCategory(peer, recordKind) {
  const cat = KIND_TO_CATEGORY[recordKind];
  if (!cat) return false;
  // A full-sync ("mirror everything") peer implies every current and future category, so new
  // subscribable kinds are covered with no per-peer change.
  if (peer?.fullSync === true) return true;
  const cats = peer?.syncCategories;
  return !!(cats && cats[cat] === true);
}

export async function findPeerById(peerId) {
  const peers = await getPeers().catch(() => []);
  return peers.find((p) => p.instanceId === peerId) || null;
}
// A failed store read is NOT "record does not exist": only a not-found error (ServerError 404 /
// `*NOT_FOUND` code) maps to null; anything else rethrows so the push rejects before any network
// call or lastPushedHash write (#11455).
function isNotFoundError(err) {
  const code = err?.code;
  return err?.status === 404 || (typeof code === 'string' && (code === 'NOT_FOUND' || code.endsWith('_NOT_FOUND')));
}

export async function loadOrNotFound(fn) {
  try {
    return await fn();
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

export const FORCE_REVALIDATE_EVERY = 10; // ~10 min at the 60s sweep cadence

/**
 * Test-support: await the in-flight subscription-write tail (used by `__resetForTests` / `__drainForTests` in peerSync.js).
 */
export function drainWriteTail() {
  return writeTail.catch(() => {});
}
