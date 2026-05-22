/**
 * Federated peer-sync HTTP routes.
 *
 *   POST   /api/peer-sync/push                       → receiver: apply incoming push
 *   GET    /api/peer-sync/subscriptions              → list local outgoing subs (optional filter)
 *   POST   /api/peer-sync/subscriptions              → subscribe a record to a peer
 *   DELETE /api/peer-sync/subscriptions/:id          → unsubscribe
 *
 * All inputs flow through Zod schemas in `server/lib/validation.js`. Service
 * errors carry an `ERR_*` code that maps to the HTTP status here; anything
 * un-mapped surfaces as a 500 via the global error handler.
 *
 * Stage 3 — the routes themselves; Stage 2 already provided the service
 * functions (`applyIncomingPush`, `subscribePeer`, etc.) that these wrap.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  peerSubscribeSchema,
  peerSyncPushSchema,
} from '../lib/validation.js';
import {
  listPeerSubscriptions,
  subscribePeer,
  unsubscribePeer,
  applyIncomingPush,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
} from '../services/sharing/peerSync.js';

const router = Router();

const PEER_SYNC_ERROR_STATUS = {
  [ERR_NOT_FOUND]: 404,
  [ERR_VALIDATION]: 400,
};

function mapAndRethrow(err) {
  const status = PEER_SYNC_ERROR_STATUS[err?.code];
  if (status) {
    throw new ServerError(err.message, { status, code: err.code });
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
  res.json({ subscription });
}));

// --- DELETE /subscriptions/:id --- tear down a subscription.
//
// Also drops the per-peer tombstone cursor when this was the last remaining
// subscription to that peer (service-layer handles that cascade).
router.delete('/subscriptions/:id', asyncHandler(async (req, res) => {
  const result = await unsubscribePeer(req.params.id).catch(mapAndRethrow);
  res.json(result);
}));

export default router;
