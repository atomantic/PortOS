/**
 * Peer-only media commands.
 *
 *   POST /api/peer-media/copy { kind, filename, sha256? } → inspect local bytes or fetch a verified copy from the caller
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
import { validateRequest } from '../lib/validateRequest.js';
import { executePeerMediaDelete } from '../services/mediaRemoteDelete.js';
import { executePeerMediaCopy, executePeerMediaRelease } from '../services/mediaHolders.js';
import { peerMediaCopySchema, peerMediaDeleteSchema, peerMediaReleaseSchema } from '../lib/federatedMediaValidation.js';

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

router.post('/copy', asyncHandler(async (req, res) => {
  const peerId = requirePeer(req);
  const body = validateRequest(peerMediaCopySchema, req.body ?? {});
  res.json(await executePeerMediaCopy(peerId, body));
}));

router.post('/release', asyncHandler(async (req, res) => {
  const peerId = requirePeer(req);
  const body = validateRequest(peerMediaReleaseSchema, req.body ?? {});
  res.json(await executePeerMediaRelease(peerId, body));
}));

export default router;
