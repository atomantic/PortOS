/**
 * Fleet host change fan-out: the subscriber set, the read cache and the coalesced emit.
 *
 * A zero-import leaf on purpose, mirroring `readinessSignal.js` (#12285).
 * `fleetLlmHost.js` calls `noteFleetHostChanged` on every mutation while the
 * observer in `fleetHostNotify.js` imports `fleetLlmHost.js` to probe status;
 * keeping the signal here lets the observer import the host statically without
 * a cycle. Only `fleetHostNotify.js` adds subscribers.
 */
export const fleetHostSubscribers = new Set();
const pendingEvents = new Set();
let flush = null;
let revision = 0;
let cached = null;

export const getFleetHostRevision = () => revision;
export const getCachedFleetHostStatus = () => cached;
export const setCachedFleetHostStatus = (value) => { cached = value; };

export function noteFleetHostChanged({ usageOnly = false } = {}) {
  if (!usageOnly) { revision += 1; cached = null; }
  if (!fleetHostSubscribers.size) return;
  pendingEvents.add(usageOnly ? 'fleet-host:usage:changed' : 'fleet-host:changed');
  if (flush) return;
  flush = setTimeout(() => {
    flush = null;
    const events = [...pendingEvents];
    pendingEvents.clear();
    for (const socket of fleetHostSubscribers) {
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

/** Queue an event for the next coalesced emit without scheduling one. */
export function queueFleetHostEvent(event) {
  pendingEvents.add(event);
}

/** Drop pending events and the cache (the last subscriber left). */
export function resetFleetHostSignal() {
  clearTimeout(flush);
  flush = null;
  cached = null;
  pendingEvents.clear();
}
