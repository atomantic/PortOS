import { EventEmitter } from 'node:events';

// Public run snapshots only; runtime promises and provider handles stay local.
export const fableLoomRunEvents = new EventEmitter();
