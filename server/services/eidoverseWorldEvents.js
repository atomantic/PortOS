import { EventEmitter } from 'node:events';

// Invalidate persisted progress without broadcasting world records or identity.
export const eidoverseWorldEvents = new EventEmitter();
