/** Local operator subscriptions only; notifications never carry host keys or usage records. */
import { getFleetLlmHostQueue, getFleetLlmHostStatus } from './fleetLlmHost.js';
import {
  fleetHostSubscribers as subscribers, noteFleetHostChanged, queueFleetHostEvent, resetFleetHostSignal,
  getFleetHostRevision, getCachedFleetHostStatus, setCachedFleetHostStatus,
} from './fleetHostSignal.js';

export { noteFleetHostChanged };
let timer = null;
let generation = 0;
let reading = null;
let previous = null;
export const FLEET_HOST_OBSERVE_MS = 15_000;

// The observer and concurrent HTTP consumers share the same probe. A mutation
// during a probe invalidates its answer and drains one fresh read before return.
export function readFleetHostStatus({ refresh = false } = {}) {
  if (refresh) setCachedFleetHostStatus(null);
  const snapshot = getCachedFleetHostStatus();
  if (!reading && snapshot && subscribers.size) {
    return Promise.resolve({ ...snapshot, queue: getFleetLlmHostQueue() });
  }
  if (!reading) {
    reading = (async () => {
      let started;
      let result;
      do {
        started = getFleetHostRevision();
        result = await getFleetLlmHostStatus();
      } while (started !== getFleetHostRevision());
      setCachedFleetHostStatus(result);
      return result;
    })().finally(() => { reading = null; });
  }
  return reading;
}

async function observe() {
  const started = generation;
  const signature = await readFleetHostStatus({ refresh: true })
    .then(value => JSON.stringify(value), () => 'probe-unavailable');
  if (started !== generation || !subscribers.size) return;
  if (previous !== null && previous !== signature) {
    // The sample is already cached; do not discard it and probe again.
    noteFleetHostChanged({ usageOnly: true });
    queueFleetHostEvent('fleet-host:changed');
  }
  previous = signature;
  timer = setTimeout(() => {
    timer = null;
    observe().catch(err => console.error(`❌ Fleet host observation failed: ${err.message}`));
  }, FLEET_HOST_OBSERVE_MS);
  timer.unref?.();
}

export function releaseFleetHostSocket(socket) {
  subscribers.delete(socket);
  if (subscribers.size) return;
  generation += 1;
  clearTimeout(timer);
  timer = null;
  previous = null;
  resetFleetHostSignal();
}

export function subscribeFleetHostSocket(socket) {
  const first = subscribers.size === 0;
  subscribers.add(socket);
  if (first) observe().catch(err => console.error(`❌ Fleet host observation failed: ${err.message}`));
}

export function registerFleetHostSocket(socket) {
  socket.on('fleet-host:subscribe', () => subscribeFleetHostSocket(socket));
  socket.on('fleet-host:unsubscribe', () => releaseFleetHostSocket(socket));
  socket.on('disconnect', () => releaseFleetHostSocket(socket));
}
