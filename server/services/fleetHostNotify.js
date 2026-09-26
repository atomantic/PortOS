/** Local operator subscriptions only; notifications never carry host keys or usage records. */
const subscribers = new Set();
const pendingEvents = new Set();
let timer = null;
let flush = null;
let generation = 0;
let revision = 0;
let cached = null;
let reading = null;
let previous = null;
export const FLEET_HOST_OBSERVE_MS = 15_000;

// The observer and concurrent HTTP consumers share the same probe. A mutation
// during a probe invalidates its answer and drains one fresh read before return.
export function readFleetHostStatus({ refresh = false } = {}) {
  if (refresh) cached = null;
  if (!reading && cached && subscribers.size) {
    const snapshot = cached;
    return import('./fleetLlmHost.js').then(({ getFleetLlmHostQueue }) => ({ ...snapshot, queue: getFleetLlmHostQueue() }));
  }
  if (!reading) {
    reading = (async () => {
      let started;
      let result;
      do {
        started = revision;
        const { getFleetLlmHostStatus } = await import('./fleetLlmHost.js');
        result = await getFleetLlmHostStatus();
      } while (started !== revision);
      cached = result;
      return result;
    })().finally(() => { reading = null; });
  }
  return reading;
}

export function noteFleetHostChanged({ usageOnly = false } = {}) {
  if (!usageOnly) { revision += 1; cached = null; }
  if (!subscribers.size) return;
  pendingEvents.add(usageOnly ? 'fleet-host:usage:changed' : 'fleet-host:changed');
  if (flush) return;
  flush = setTimeout(() => {
    flush = null;
    const events = [...pendingEvents];
    pendingEvents.clear();
    for (const socket of subscribers) {
      if (!socket.connected) continue;
      try {
        for (const event of events) socket.emit(event, {});
      } catch (err) {
        console.error(`❌ Fleet host notification failed: ${err.message}`);
      }
    }
  }, 100);
  flush.unref?.();
}

async function observe() {
  const started = generation;
  const signature = await readFleetHostStatus({ refresh: true })
    .then(value => JSON.stringify(value), () => 'probe-unavailable');
  if (started !== generation || !subscribers.size) return;
  if (previous !== null && previous !== signature) {
    // The sample is already cached; do not discard it and probe again.
    noteFleetHostChanged({ usageOnly: true });
    pendingEvents.add('fleet-host:changed');
  }
  previous = signature;
  timer = setTimeout(() => {
    timer = null;
    observe().catch(err => console.error(`❌ Fleet host observation failed: ${err.message}`));
  }, FLEET_HOST_OBSERVE_MS);
  timer.unref?.();
}

export function registerFleetHostSocket(socket) {
  const release = () => {
    subscribers.delete(socket);
    if (subscribers.size) return;
    generation += 1;
    clearTimeout(timer);
    clearTimeout(flush);
    timer = null;
    flush = null;
    cached = null;
    previous = null;
    pendingEvents.clear();
  };
  socket.on('fleet-host:subscribe', () => {
    const first = subscribers.size === 0;
    subscribers.add(socket);
    if (first) observe().catch(err => console.error(`❌ Fleet host observation failed: ${err.message}`));
  });
  socket.on('fleet-host:unsubscribe', release);
  socket.on('disconnect', release);
}
