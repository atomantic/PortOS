import { EventEmitter } from 'node:events';

// Invalidation only: run paths and worker errors stay on the status endpoint.
export const usageBackfillEvents = new EventEmitter();
export const notifyUsageBackfillUpdated = () => usageBackfillEvents.emit('updated', {});
