/** Worker lifecycle and wake signal shared by queue mutations and the scheduler. */

// Once quiesced, no path promotes a waiting job or re-arms the worker.
// Waiting jobs stay durably queued for the next process.
export const workerState = {
  started: false,
  operation: null,
  wake: null,
  pendingWake: false,
  quiesced: false,
  resettingForTests: false,
};

export function wakeWorker() {
  // The scheduler can be between its queue snapshot and its next wait.
  workerState.pendingWake = true;
  workerState.wake?.();
}
