import { EventEmitter } from 'node:events';

// No readings, credentials or invocation cache keys cross this boundary.
export const providerQuotaEvents = new EventEmitter();
export const notifyProviderQuotaUpdated = () => providerQuotaEvents.emit('updated', {});
