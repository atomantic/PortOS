import { EventEmitter } from 'node:events';

// Invalidations contain identity only; model contents remain behind the API gate.
export const modelLifecycleEvents = new EventEmitter();
