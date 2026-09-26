import { EventEmitter } from 'node:events';

// Invalidation only: personal inputs remain behind the normal API boundary.
export const meatspaceEvents = new EventEmitter();
