import { EventEmitter } from 'node:events';

// Invalidation only: no premises, corpus rows, paths or trained weights.
export const jevEvents = new EventEmitter();

export function notifyJevChanged(resource) {
  // Install, idle-reaper and child-exit paths run outside Express.
  try {
    jevEvents.emit(resource, {});
  } catch (error) {
    console.error(`❌ JEV notification failed: ${error.message}`);
  }
}
