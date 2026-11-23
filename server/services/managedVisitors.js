import { dataPath } from '../lib/paths.js';
import { createManagedVisitorBroker } from './managedVisitorBroker.js';
import { createManagedVisitorHost } from './managedVisitorHost.js';
import { ServerError } from '../lib/errorHandler.js';
import { browserRequestRefusal, isLocalConnection } from '../../lib/portosAuthCore.js';
import { isRemoteRequest } from '../lib/requestOrigin.js';

let broker;
export function getManagedVisitorBroker() {
  broker ??= createManagedVisitorBroker({ path: dataPath('managed-visitor-credentials.json'),
    getApp: async id => (await import('./apps.js')).getAppById(id), host: createManagedVisitorHost() });
  return broker;
}
export async function authenticateManagedVisitorRequest(req, broker = getManagedVisitorBroker()) {
  // The Vite dev proxy (0.0.0.0:5554) reaches the API from its own loopback
  // socket; its client-address marker names the real caller. Tailcat ingress
  // also proxies over loopback and is marked only by isRemoteRequest. This
  // namespace is handled before the global gate's browser guard, so apply the
  // cross-origin and DNS-rebinding Host checks here.
  if (isRemoteRequest(req) || !isLocalConnection(req.socket?.remoteAddress, req.headers) || browserRequestRefusal(req)) {
    throw new ServerError('Managed visitor API requires a local same-origin caller.', { status: 403 });
  }
  const match = /^Bearer (mv1_[a-f0-9]{64})$/i.exec(req.headers.authorization ?? '');
  return broker.authenticate(match?.[1]);
}
