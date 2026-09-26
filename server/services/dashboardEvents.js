import { EventEmitter } from 'node:events';

// Resource invalidations only: no personal records or configuration on the wire.
// Writers emit after persistence; socket.js forwards to authenticated clients.
export const dashboardEvents = new EventEmitter();

const expiries = new Map();

// Time-window resources become stale even without a write. Arm one shared,
// one-shot invalidation per domain, at its actual next expiry (never a poll).
// A subsequent resource read arms the next boundary; no consumer means no work.
export function scheduleDashboardExpiry(event, expiresAt) {
  const previous = expiries.get(event);
  if (previous?.at === expiresAt) return;
  if (previous) clearTimeout(previous.timer);
  expiries.delete(event);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
  const timer = setTimeout(() => {
    expiries.delete(event);
    dashboardEvents.emit(event);
  }, Math.min(expiresAt - Date.now(), 2147483647));
  timer.unref?.();
  expiries.set(event, { at: expiresAt, timer });
}
