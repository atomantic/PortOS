import { runOutsideBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { EventEmitter } from 'events';
import { makeEmitterFaultIsolating } from '../lib/faultIsolatedEmitter.js';

export const imageGenEvents = makeEmitterFaultIsolating(new EventEmitter());
// Each in-flight image job attaches progress/status/completion listeners and
// watchdog activity tracers. Cloud concurrency is user-configured, so no fixed
// listener threshold distinguishes a large batch from a leak. runJob detaches
// each job's listeners on termination and again in its final cleanup.
imageGenEvents.setMaxListeners(0);

// Async completion listeners own their leases instead of borrowing the provider's.
const emit = imageGenEvents.emit;
imageGenEvents.emit = function (event, ...args) {
  return event === 'completed'
    ? runOutsideBackupAssetPublication(() => emit.call(this, event, ...args))
    : emit.call(this, event, ...args);
};
