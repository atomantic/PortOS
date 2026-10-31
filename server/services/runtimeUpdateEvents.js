import { EventEmitter } from 'node:events';

// Mutations signal the monitor without coupling installers to the review queue.
export const runtimeUpdateEvents = new EventEmitter();
