/**
 * Bounded readiness invalidations. No snapshot, credentials or record content
 * goes onto the socket. One observer serves all open readiness views; it stops
 * with the last subscriber. Snapshot readers only inspect readiness (never
 * generate, warm a model, restart a process, or run CoS's repairing health check).
 *
 * Internal inputs: settings (health/voice/network/reviewer config), app and PM2
 * mutations, CoS lifecycle/config/memory, media queues, providers/status,
 * calendar/message accounts, genome and Telegram lifecycle.
 * External inputs: filesystem and OS telemetry, DB/forge reachability, PM2
 * changes outside PortOS, CUDA, provider binaries/local daemon readiness and
 * Tailscale/cert state. Shared snapshot readers keep observer and HTTP failure
 * semantics identical; timestamps alone never trigger an invalidation.
 */
const subscribers = new Set();
const previous = new Map();
const pendingDomains = new Set();
let flushTimer = null;
let observerTimer = null;
let observing = false;
let generation = 0;
let stopWatchers = null;

const READERS = {
  health: () => import('./systemHealthSnapshot.js').then(m => m.getSystemHealthSnapshot()),
  capabilities: () => import('./capabilitiesSnapshot.js').then(m => m.getCapabilitiesSnapshot()),
};
const EVENTS = { health: 'system:health:changed', capabilities: 'capabilities:changed' };
export const READINESS_OBSERVE_MS = 20_000;
export const READINESS_COALESCE_MS = 100;

// Clock fields must not turn an unchanged observer sample into an invalidation.
// Resource usage is real telemetry and remains part of health change detection.
function signature(snapshot) {
  return JSON.stringify(snapshot, (key, value) =>
    ['timestamp', 'checkedAt', 'responseTime', 'uptime', 'uptimeFormatted'].includes(key) ? undefined : value);
}

export function noteReadinessChanged(domain = 'capabilities') {
  if (!EVENTS[domain] || !subscribers.size) return;
  pendingDomains.add(domain);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const domains = [...pendingDomains];
    pendingDomains.clear();
    for (const socket of subscribers) {
      if (!socket.connected) continue;
      try {
        for (const name of domains) socket.emit(EVENTS[name], {});
      } catch (err) {
        console.error(`❌ Readiness notification failed: ${err.message}`);
      }
    }
  }, READINESS_COALESCE_MS);
  flushTimer.unref?.();
}

async function observe() {
  if (observing || !subscribers.size) return;
  observing = true;
  const started = generation;
  try {
    await Promise.all(Object.entries(READERS).map(async ([domain, read]) => {
      // Failure is a distinct state, never an empty or healthy snapshot.
      const value = await read().then(signature, () => 'probe-unavailable');
      if (started !== generation || !subscribers.size) return;
      if (previous.has(domain) && previous.get(domain) !== value) noteReadinessChanged(domain);
      previous.set(domain, value);
    }));
  } finally {
    observing = false;
    // A new subscriber may have arrived while an old generation was draining.
    if (subscribers.size && !observerTimer) scheduleObservation();
  }
}

function scheduleObservation() {
  observerTimer = setTimeout(() => {
    observerTimer = null;
    observe().catch(err => console.error(`❌ Readiness observation failed: ${err.message}`));
  }, READINESS_OBSERVE_MS);
  observerTimer.unref?.();
}

function stopObservation() {
  generation += 1;
  clearTimeout(observerTimer);
  clearTimeout(flushTimer);
  observerTimer = null;
  flushTimer = null;
  pendingDomains.clear();
  previous.clear();
}

export function registerReadinessSocket(socket) {
  const release = () => {
    subscribers.delete(socket);
    if (!subscribers.size) stopObservation();
  };
  socket.on('readiness:subscribe', () => {
    const first = subscribers.size === 0;
    subscribers.add(socket);
    if (first) observe().catch(err => console.error(`❌ Readiness observation failed: ${err.message}`));
  });
  socket.on('readiness:unsubscribe', release);
  socket.on('disconnect', release);
}

/** Forward existing service buses without their private payloads. */
export async function armReadinessWatchers() {
  if (stopWatchers) return;
  const offs = [];
  // Set synchronously to make concurrent initialization idempotent.
  stopWatchers = () => offs.splice(0).forEach(off => off());
  try {
    const [{ cosEvents }, { settingsEvents }, { appsEvents }, { providerStatusEvents }, { mediaJobEvents }] = await Promise.all([
      import('./cosEvents.js'), import('./settings.js'), import('./apps.js'), import('./providerStatus.js'), import('./mediaJobQueue/index.js'),
    ]);
    const listen = (bus, events, domains) => {
      for (const event of events) {
        const handler = () => domains.forEach(noteReadinessChanged);
        bus.on(event, handler);
        offs.push(() => bus.off(event, handler));
      }
    };
    listen(settingsEvents, ['settings:updated', 'settings:invalidated'], ['health', 'capabilities']);
    listen(appsEvents, ['changed'], ['health', 'capabilities']);
    listen(mediaJobEvents, ['enqueued', 'started', 'completed', 'failed', 'canceled'], ['health']);
    listen(providerStatusEvents, ['status:changed'], ['capabilities']);
    listen(cosEvents, ['health:check', 'health:critical', 'agent:spawned', 'agent:completed', 'agent:terminate', 'tasks:changed', 'status', 'status:paused', 'status:resumed'], ['health']);
    listen(cosEvents, ['config:changed', 'memory:created', 'memory:updated', 'memory:deleted', 'memory:approved', 'memory:rejected'], ['capabilities']);
  } catch (err) {
    stopWatchers();
    stopWatchers = null;
    throw err;
  }
}

export function __resetReadinessForTests() {
  subscribers.clear();
  stopObservation();
  stopWatchers?.();
  stopWatchers = null;
}
