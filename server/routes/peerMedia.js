/**
 * Peer-only media commands.
 *
 *   POST /api/peer-media/delete  { kind, key }  → delete a row this machine holds
 *   POST /api/peer-media/release { kind, filename, primaryInstanceId, primaryAt }
 *        → drop this machine's copy of the bytes; the item streams from the primary
 *
 * Only a paired peer authenticated by its scoped pair credential reaches the
 * handler (authGate marks it `method: 'peer'`, on PEER_API_SURFACE). The
 * instance password, a browser/agent session and an anonymous caller on a
 * password-free install are not peers and are refused.
 */
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { peerMediaDeleteSchema, peerMediaReleaseSchema, validateRequest } from '../lib/validation.js';
import { executePeerMediaDelete } from '../services/mediaRemoteDelete.js';
import { executePeerMediaRelease } from '../services/mediaHolders.js';

const router = Router();

function requirePeer(req) {
  const auth = req.portosAuthContext;
  if (auth?.authenticated !== true || auth.method !== 'peer' || typeof auth.peerId !== 'string' || !auth.peerId) {
    throw new ServerError('A paired peer credential is required', { status: 403, code: 'PEER_CREDENTIAL_REQUIRED' });
  }
  return auth.peerId;
}

router.post('/delete', asyncHandler(async (req, res) => {
  const peerId = requirePeer(req);
  const body = validateRequest(peerMediaDeleteSchema, req.body ?? {});
  res.json(await executePeerMediaDelete(peerId, body));
}));

router.post('/release', asyncHandler(async (req, res) => {
  const peerId = requirePeer(req);
  const body = validateRequest(peerMediaReleaseSchema, req.body ?? {});
  res.json(await executePeerMediaRelease(peerId, body));
}));

export default router;
