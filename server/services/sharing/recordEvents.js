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

// === Subscription adapter (registration-based) =============================
// Subscription lifecycle calls flow domain → sharing like the events above,
// but two call sites must AWAIT completion (an ephemeral flip has to settle
// BEFORE emitRecordUpdated fires, or pushes get scheduled against subs that
// are about to be torn down) — so these go through a registered adapter that
// returns the implementation's promise rather than the fire-and-forget
// EventEmitter. peerSync.js registers the real implementation at module load
// (sharing/index.js imports it during server boot, before any HTTP write can
// land). Until registration every call is a silent no-op — which is exactly
// what record-creating tests want: no peer fan-out without mocking anything.
//
// This replaces the old `await import('./sharing/peerSync.js')` sites in
// universeBuilder/series/mediaCollections/instances — peerSync statically
// imports their merge entry points, so importing it back (even dynamically)
// formed a load-order-sensitive cycle.
let subscriptionAdapter = null;

export function registerSubscriptionAdapter(adapter) {
  subscriptionAdapter = adapter;
}

/** Whether an adapter is wired — initSharing() uses this as a boot sanity check. */
export function hasSubscriptionAdapter() {
  return subscriptionAdapter !== null;
}

/** Test-only: detach the adapter so later suites see the unregistered state. */
export function __resetSubscriptionAdapter() {
  subscriptionAdapter = null;
}

/** Subscribe one record to every peer with its category enabled. */
export async function autoSubscribeRecordToAllPeers(recordKind, recordId) {
  return subscriptionAdapter?.autoSubscribeRecordToAllPeers?.(recordKind, recordId);
}

/** Tear down every per-record subscription (e.g. record turned ephemeral). */
export async function unsubscribeAllForRecord(recordKind, recordId) {
  return subscriptionAdapter?.unsubscribeAllForRecord?.(recordKind, recordId);
}

/** Backfill-subscribe every local record of a kind to one peer. */
export async function autoSubscribePeerToAllRecords(peerInstanceId, recordKind) {
  return subscriptionAdapter?.autoSubscribePeerToAllRecords?.(peerInstanceId, recordKind);
}
