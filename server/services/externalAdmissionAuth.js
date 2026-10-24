import { createHash } from 'node:crypto';
import { assertHostControl } from './authGate.js';
import { isAuthEnabled, verifyRequestSessionIdentity } from './auth.js';
import { ServerError } from '../lib/errorHandler.js';

/** Authority is reverified on each request; the supplied secret is not authority. */
export async function externalAdmissionOwner(req) {
  assertHostControl(req);
  const enabled = await isAuthEnabled();
  const identity = await verifyRequestSessionIdentity(req);
  // Preserve the existing genuine-local operator boundary on password-free
  // installs. assertHostControl has already refused remote/relay callers.
  const principal = enabled === req.portosAuthContext?.enabled
    ? enabled ? identity?.sessionId && `session:${identity.sessionId}` : 'local-operator'
    : null;
  const secret = req.headers?.['x-portos-admission-session'];
  if (!principal || typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) {
    throw new ServerError('A current operator session and a per-run admission secret are required.', {
      status: 403, code: 'EXTERNAL_ADMISSION_SESSION_REQUIRED',
    });
  }
  return createHash('sha256').update(JSON.stringify([principal, secret])).digest('hex');
}
