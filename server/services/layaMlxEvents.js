import { EventEmitter } from 'node:events';

// Invalidate status without broadcasting experiment inputs or results.
export const layaMlxEvents = new EventEmitter();
export const notifyLayaStatus = () => layaMlxEvents.emit('updated', {});
