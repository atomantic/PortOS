import { dataPath } from '../lib/paths.js';
import { createManagedVisitorBroker } from './managedVisitorBroker.js';
import { createManagedVisitorHost } from './managedVisitorHost.js';
import { ServerError } from '../lib/errorHandler.js';
import { isCrossOrigin } from '../../lib/portosAuthCore.js';

let broker;
export function getManagedVisitorBroker() {
  broker ??= createManagedVisitorBroker({ path: dataPath('managed-visitor-credentials.json'),
    getApp: async id => (await import('./apps.js')).getAppById(id), host: createManagedVisitorHost() });
  return broker;
}
export async function authenticateManagedVisitorRequest(req, broker = getManagedVisitorBroker()) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress) || isCrossOrigin(req)) {
    throw new ServerError('Managed visitor API requires a local same-origin caller.', { status: 403 });
  }
  const match = /^Bearer (mv1_[a-f0-9]{64})$/i.exec(req.headers.authorization ?? '');
  return broker.authenticate(match?.[1]);
}
