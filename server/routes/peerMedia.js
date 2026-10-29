/**
 * Peer-only media commands.
 *
 *   POST /api/peer-media/delete  { kind, key }  → delete a row this machine holds
 *
 * Only a paired peer authenticated by its scoped pair credential reaches the
 * handler (authGate marks it `method: 'peer'`, on PEER_API_SURFACE). The
 * instance password, a browser/agent session and an anonymous caller on a
 * password-free install are not peers and are refused.
 */
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { peerMediaDeleteSchema, validateRequest } from '../lib/validation.js';
import { executePeerMediaDelete } from '../services/mediaRemoteDelete.js';

const router = Router();

router.post('/delete', asyncHandler(async (req, res) => {
  const auth = req.portosAuthContext;
  if (auth?.authenticated !== true || auth.method !== 'peer' || typeof auth.peerId !== 'string' || !auth.peerId) {
    throw new ServerError('A paired peer credential is required', { status: 403, code: 'PEER_CREDENTIAL_REQUIRED' });
  }
  const body = validateRequest(peerMediaDeleteSchema, req.body ?? {});
  res.json(await executePeerMediaDelete(auth.peerId, body));
}));

export default router;
