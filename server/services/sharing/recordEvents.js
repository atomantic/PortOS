/**
 * Cross-service event bus for record mutations the sharing subsystem
 * cares about. Each pipeline / universe write path emits `updated` with
 * `{ recordKind, recordId }` after a successful persist; subscriptions.js
 * listens and re-exports the record into any bucket it's currently
 * subscribed to.
 *
 * Kept separate from the service modules so importing this bus doesn't
 * drag in the heavyweight pipeline graph.
 */

import { EventEmitter } from 'events';

export const recordEvents = new EventEmitter();
// Many subscriptions per record + the subscriptions listener itself can
// add up past the default 10-listener warning threshold under load.
recordEvents.setMaxListeners(100);

/** Fire-and-forget — listeners' failures shouldn't poison the caller. */
export function emitRecordUpdated(recordKind, recordId) {
  if (!recordKind || !recordId) return;
  recordEvents.emit('updated', { recordKind, recordId });
}

/** Local deletion of a subscribed record auto-unsubscribes via the listener. */
export function emitRecordDeleted(recordKind, recordId) {
  if (!recordKind || !recordId) return;
  recordEvents.emit('deleted', { recordKind, recordId });
}

// Re-export suppression — lets a multi-write cascade (e.g. season delete
// re-pointing N child issues) avoid scheduling N debounced re-exports of
// the same record. Lives here (not in subscriptions.js) so service modules
// can use it without transitively pulling the exporter/file-IO graph in.
const suppressedReexports = new Map(); // `${kind}:${id}` → ref-count

function suppressionKey(recordKind, recordId) {
  return `${recordKind}:${recordId}`;
}

export function isReexportSuppressed(recordKind, recordId) {
  return suppressedReexports.has(suppressionKey(recordKind, recordId));
}

export async function withReexportSuppressed(recordKind, recordId, fn) {
  if (!recordKind || !recordId || typeof fn !== 'function') return fn?.();
  const key = suppressionKey(recordKind, recordId);
  suppressedReexports.set(key, (suppressedReexports.get(key) || 0) + 1);
  try {
    return await fn();
  } finally {
    const next = (suppressedReexports.get(key) || 1) - 1;
    if (next <= 0) suppressedReexports.delete(key);
    else suppressedReexports.set(key, next);
  }
}

/** Test-only: clear the suppression registry. */
export function __resetReexportSuppression() {
  suppressedReexports.clear();
}
