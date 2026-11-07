import { EventEmitter } from 'events';

/** Emits `updated` after a provider app usage history refresh changed a store. Kept apart so socket wiring stays off the scanners' import graph. */
export const nativeUsageEvents = new EventEmitter();
