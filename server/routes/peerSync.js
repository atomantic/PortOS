/**
 * Federated peer-sync HTTP routes.
 *
 *   POST   /api/peer-sync/push                       → receiver: apply incoming push
 *   GET    /api/peer-sync/subscriptions              → list local outgoing subs (optional filter)
 *   POST   /api/peer-sync/subscriptions              → subscribe a record to a peer
 *   DELETE /api/peer-sync/subscriptions/:id          → unsubscribe
 *
 * POST bodies flow through Zod schemas in `server/lib/validation.js`. Query
 * params on GET and the `:id` path param on DELETE are guarded inline:
 *   - GET /subscriptions filter values are accepted only when `typeof === 'string'`
 *     (Express returns arrays for repeated keys; the guard prevents those from
 *     leaking into the filter).
 *   - DELETE /:id is forwarded straight to the service layer, which validates
 *     it via the same `isNonEmptyStr` check used by every other id-keyed
 *     call (returns ERR_NOT_FOUND for missing, ERR_VALIDATION for malformed).
 *
 * Service errors carry an `ERR_*` code that maps to the HTTP status here;
 * anything un-mapped surfaces as a 500 via the global error handler.
 *
 * Stage 3 — the routes themselves; Stage 2 already provided the service
 * functions (`applyIncomingPush`, `subscribePeer`, etc.) that these wrap.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  peerSubscribeSchema,
  peerSyncPushSchema,
  peerSyncRecordSchema,
  peerSyncNowSchema,
  peerPullMetadataSchema,
} from '../lib/validation.js';
import {
  listPeerSubscriptions,
  subscribePeer,
  unsubscribePeer,
  applyIncomingPush,
  forcePushRecord,
  syncNowForPeer,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  ERR_SCHEMA_VERSION_AHEAD,
  PEER_SUBSCRIBABLE_KINDS,
} from '../services/sharing/peerSync.js';
import { buildLocalManifest, getPeerIntegrity } from '../services/sharing/integrity.js';

const router = Router();

const PEER_SYNC_ERROR_STATUS = {
  [ERR_NOT_FOUND]: 404,
  [ERR_VALIDATION]: 400,
  // 409 Conflict — receiver's schema is behind the sender's; sender must
  // wait for the receiver to upgrade PortOS. The body's `details` carries
  // the ahead/behind diff + the receiver's schemaVersions so the sender
  // can surface a precise "Peer X needs to update PortOS" message and
  // pause retries for that subscription.
  [ERR_SCHEMA_VERSION_AHEAD]: 409,
};

function mapAndRethrow(err) {
  const status = PEER_SYNC_ERROR_STATUS[err?.code];
  if (status) {
    // Preserve `err.details` (set by `makeErr` in peerSync.js for the
    // schema-ahead path) — surface it as the ServerError's `context` so the
    // global error handler includes it in the JSON response body. Sender-
    // side parses `body.context` for `ahead` / `behind` / `senderPortosVersion`.
    throw new ServerError(err.message, {
      status,
      code: err.code,
      context: err.details ? { details: err.details } : undefined,
    });
  }
  throw err;
}

// --- POST /push --- receiver-side: apply an incoming record + asset manifest.
//
// This is the endpoint a *sender* peer hits when they push us their latest.
// Validation catches obvious shape errors at the boundary; the service layer
// owns the cross-instance rules (sourceInstanceId !== UNKNOWN_INSTANCE_ID,
// merge-time LWW, reverse-subscribe direction gating).
router.post('/push', asyncHandler(async (req, res) => {
  const payload = validateRequest(peerSyncPushSchema, req.body || {});
  const result = await applyIncomingPush(payload).catch(mapAndRethrow);
  res.json(result);
}));

// --- GET /subscriptions --- list outgoing peer subscriptions.
//
// Optional query filter: `?peerId=…&recordKind=…&recordId=…`. All filters
// AND together; absent filters match everything. Used by the Instances page
// to show "what am I syncing with peer X" + by the Universe / Series pages
// to render the SyncToPeerButton's current state.
router.get('/subscriptions', asyncHandler(async (req, res) => {
  const filter = {};
  if (typeof req.query.peerId === 'string') filter.peerId = req.query.peerId;
  if (typeof req.query.recordKind === 'string') filter.recordKind = req.query.recordKind;
  if (typeof req.query.recordId === 'string') filter.recordId = req.query.recordId;
  const subscriptions = await listPeerSubscriptions(filter);
  res.json({ subscriptions });
}));

// --- POST /subscriptions --- create a subscription + trigger initial push.
//
// Idempotent on the (peerId, recordKind, recordId) key — re-subscribing
// returns the existing record without throwing. The initial push fires
// fire-and-forget so the caller doesn't wait on a slow peer.
router.post('/subscriptions', asyncHandler(async (req, res) => {
  const input = validateRequest(peerSubscribeSchema, req.body || {});
  const subscription = await subscribePeer(input).catch(mapAndRethrow);
  // 201 even on idempotent re-subscribe — matches the share-bucket subscribe
  // convention in server/routes/sharing.js so REST clients can apply the same
  // status-code branching across both transports.
  res.status(201).json({ subscription });
}));

// --- DELETE /subscriptions/:id --- tear down a subscription.
//
// Also drops the per-peer tombstone cursor when this was the last remaining
// subscription to that peer (service-layer handles that cascade).
router.delete('/subscriptions/:id', asyncHandler(async (req, res) => {
  const result = await unsubscribePeer(req.params.id).catch(mapAndRethrow);
  res.json(result);
}));

// Guard: only accept record kinds that the peer-sync pipeline actually handles.
const validKind = (k) => typeof k === 'string' && PEER_SUBSCRIBABLE_KINDS.includes(k);

// --- GET /manifest --- advertise this instance's record manifest for a kind.
//
// Called by peers running `getPeerIntegrity` to compare their local state
// against ours. The response is a flat list of rows — one per record —
// including tombstones so deletes diff correctly. Asset hashes are sorted
// sha256 strings so the diff is order-independent.
router.get('/manifest', asyncHandler(async (req, res) => {
  // Trim once and validate/use the trimmed value — a padded `?kind= universe `
  // should resolve like `universe`, not 400 on whitespace.
  const kind = typeof req.query.kind === 'string' ? req.query.kind.trim() : '';
  if (!validKind(kind)) {
    throw new ServerError('invalid kind', { status: 400, code: 'VALIDATION_ERROR' });
  }
  res.json({ records: await buildLocalManifest(kind) });
}));

// --- GET /integrity --- compare this instance's records against a peer's.
//
// Fetches the peer's /manifest, runs the pure diff, and returns
// `{ available, reason?, records: [{ id, name, status }] }`.
router.get('/integrity', asyncHandler(async (req, res) => {
  // Trim ONCE and use the trimmed values for both validation AND the service
  // call. Validating the trimmed value but passing the raw one let
  // `?peerId=%20peer-a%20` pass the emptiness check yet fail to match the peer
  // registry, returning a confusing `peer-not-found`.
  const peerId = typeof req.query.peerId === 'string' ? req.query.peerId.trim() : '';
  const kind = typeof req.query.kind === 'string' ? req.query.kind.trim() : '';
  if (!peerId) {
    throw new ServerError('peerId required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (!validKind(kind)) {
    throw new ServerError('invalid kind', { status: 400, code: 'VALIDATION_ERROR' });
  }
  res.json(await getPeerIntegrity({ peerId, kind }));
}));

// --- POST /sync-record --- force a push for a specific record to a specific peer.
//
// Bypasses the unchanged-hash short-circuit so the receiver always gets the
// latest state. Creates the subscription if it doesn't exist yet.
router.post('/sync-record', asyncHandler(async (req, res) => {
  const { peerId, recordKind, recordId } = validateRequest(peerSyncRecordSchema, req.body || {});
  res.json(await forcePushRecord(peerId, recordKind, recordId).catch(mapAndRethrow));
}));

// --- POST /sync-now --- trigger an immediate full-sync for a peer.
//
// Backfills subscriptions for every enabled category then retries all pending
// pushes. Best-effort — per-kind failures are swallowed server-side.
router.post('/sync-now', asyncHandler(async (req, res) => {
  const { peerId } = validateRequest(peerSyncNowSchema, req.body || {});
  res.json(await syncNowForPeer(peerId).catch(mapAndRethrow));
}));

// --- POST /pull-metadata --- backfill missing sidecar metadata for images.
//
// Accepts a list of image filenames and attempts to pull their .metadata.json
// sidecar from any peer that has a copy. Delegates to sidecarSync.js.
router.post('/pull-metadata', asyncHandler(async (req, res) => {
  const { filenames } = validateRequest(peerPullMetadataSchema, req.body || {});
  const { backfillMissingSidecars } = await import('../services/sharing/sidecarSync.js');
  res.json(await backfillMissingSidecars({ filenames }));
}));

export default router;
