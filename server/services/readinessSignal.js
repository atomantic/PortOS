/**
 * Readiness invalidation fan-out: the subscriber set and the coalesced emit.
 *
 * A leaf on purpose (#12285). Writers (PM2 mutations, account services,
 * bootstrap) import this instead of `readinessNotify.js`, whose observer
 * lazily imports the health/capabilities snapshot readers and the service
 * buses. `vitest related` follows those lazy imports, so a writer importing
 * the observer joined every suite that reaches it to the CoS cluster's CI
 * selection. Only `readinessNotify.js` adds subscribers.
 */
export const READINESS_COALESCE_MS = 100;
const EVENTS = { health: 'system:health:changed', capabilities: 'capabilities:changed' };

export const readinessSubscribers = new Set();
const pendingDomains = new Set();
let flushTimer = null;

export function noteReadinessChanged(domain = 'capabilities') {
  if (!EVENTS[domain] || !readinessSubscribers.size) return;
  pendingDomains.add(domain);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const domains = [...pendingDomains];
    pendingDomains.clear();
    for (const socket of readinessSubscribers) {
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

/** Drop a pending coalesced emit (the last subscriber left). */
export function cancelPendingReadiness() {
  clearTimeout(flushTimer);
  flushTimer = null;
  pendingDomains.clear();
}
