/**
 * Share-bucket subscriptions.
 *
 * A subscription is a persistent (bucketId, recordKind, recordId) tuple. It
 * says "as long as this exists, I am continuously sharing this record into
 * that bucket — every local edit auto-re-exports onto a deterministic file
 * in the bucket, replacing the previous snapshot."
 *
 * Per the user mental model: clicking a bucket in ShareToButton creates a
 * subscription + does the initial export. Clicking again removes it (and
 * deletes the bucket-side file so recipients see the share go away). Local
 * mutations to the subscribed record fire `recordEvents` which this service
 * listens to and re-exports via the same deterministic filename.
 *
 * Subscriptions are local-only state (data/sharing/subscriptions.json) — the
 * bucket itself only holds the deterministic manifest file. Multiple peers
 * may both be subscribing the same bucket; each writes their own
 * sub-<kind>-<recordId>-<senderInstanceId>.json with their own source
 * attribution, so two peers sharing the same record don't collide.
 */

import { join } from 'path';
import { unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../../lib/fileUtils.js';
import { isStr } from '../../lib/storyBible.js';
import { getBucket } from './buckets.js';
import { exportSeries, exportUniverse } from './exporter.js';
import {
  recordEvents,
  isReexportSuppressed,
  withReexportSuppressed,
  __resetReexportSuppression,
} from './recordEvents.js';

// Re-export so existing callers (importer.js etc.) keep their import path
// stable; the canonical implementation now lives in recordEvents.js.
export { withReexportSuppressed };
import { subscriptionFilename, legacySubscriptionFilename } from './manifest.js';
import { getInstanceId } from '../instances.js';

// Re-export from the canonical source so other modules can import the
// filename helper from either side without forcing a manifest.js import.
export { subscriptionFilename };

export const SUBSCRIBABLE_KINDS = Object.freeze(['series', 'universe']);

export const ERR_NOT_FOUND = 'SHARING_SUBSCRIPTION_NOT_FOUND';
export const ERR_VALIDATION = 'SHARING_SUBSCRIPTION_VALIDATION';
export const ERR_DUPLICATE = 'SHARING_SUBSCRIPTION_DUPLICATE';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

const STATE_PATH = () => join(PATHS.data, 'sharing', 'subscriptions.json');

function subId({ bucketId, recordKind, recordId }) {
  return `sub-${recordKind}-${recordId}-${bucketId}`;
}

async function readState() {
  await ensureDir(join(PATHS.data, 'sharing'));
  const raw = await readJSONFile(STATE_PATH(), { subscriptions: [] }, { logError: false });
  const subs = Array.isArray(raw.subscriptions) ? raw.subscriptions : [];
  return { subscriptions: subs };
}

async function writeState(state) {
  await ensureDir(join(PATHS.data, 'sharing'));
  await atomicWrite(STATE_PATH(), state);
}

export async function listSubscriptions(filter = {}) {
  const { subscriptions } = await readState();
  return subscriptions.filter((s) => {
    if (filter.bucketId && s.bucketId !== filter.bucketId) return false;
    if (filter.recordKind && s.recordKind !== filter.recordKind) return false;
    if (filter.recordId && s.recordId !== filter.recordId) return false;
    return true;
  });
}

export async function findSubscription(bucketId, recordKind, recordId) {
  if (!bucketId || !recordKind || !recordId) return null;
  const { subscriptions } = await readState();
  return subscriptions.find(
    (s) => s.bucketId === bucketId && s.recordKind === recordKind && s.recordId === recordId,
  ) || null;
}

/**
 * Adopt an inbound subscription as a local outgoing subscription without
 * immediately exporting back into the bucket. Importing a subscribed record
 * means the local user has joined that collaboration, so ShareToButton should
 * show the source bucket as checked and future local edits should re-export.
 */
export async function adoptImportedSubscription({ bucketId, recordKind, recordId, lastManifestId = null }) {
  if (!SUBSCRIBABLE_KINDS.includes(recordKind)) return null;
  if (!isStr(bucketId) || !isStr(recordId)) return null;
  await getBucket(bucketId);

  const state = await readState();
  const id = subId({ bucketId, recordKind, recordId });
  const now = new Date().toISOString();
  let sub = state.subscriptions.find((s) => s.id === id);
  if (!sub) {
    sub = {
      id,
      bucketId,
      recordKind,
      recordId,
      createdAt: now,
      updatedAt: now,
      lastManifestId,
      lastExportedAt: null,
      adoptedFromImport: true,
    };
    state.subscriptions.push(sub);
  } else {
    sub.updatedAt = now;
    sub.lastManifestId = lastManifestId || sub.lastManifestId || null;
  }
  await writeState(state);
  return sub;
}

/**
 * Create a subscription and trigger the first export. If a subscription
 * already exists for the same (bucket, kind, id), idempotently re-export
 * rather than throwing — clicking "subscribe" on an already-subscribed
 * bucket should be a no-op refresh, not an error.
 */
export async function subscribe({ bucketId, recordKind, recordId }) {
  if (!SUBSCRIBABLE_KINDS.includes(recordKind)) {
    throw makeErr(`subscribable kinds are ${SUBSCRIBABLE_KINDS.join(', ')} (got "${recordKind}")`, ERR_VALIDATION);
  }
  if (!isStr(bucketId) || !isStr(recordId)) {
    throw makeErr('bucketId and recordId are required', ERR_VALIDATION);
  }
  // Validate the bucket exists (throws ERR_NOT_FOUND otherwise).
  await getBucket(bucketId);

  const state = await readState();
  const id = subId({ bucketId, recordKind, recordId });
  let sub = state.subscriptions.find((s) => s.id === id);
  const now = new Date().toISOString();
  if (!sub) {
    sub = { id, bucketId, recordKind, recordId, createdAt: now, updatedAt: now, lastManifestId: null, lastExportedAt: null };
    state.subscriptions.push(sub);
    await writeState(state);
  }

  const exp = await runExport({ bucketId, recordKind, recordId });
  if (exp) {
    sub.lastManifestId = exp.manifestId;
    sub.lastExportedAt = now;
    sub.updatedAt = now;
    await writeState(state);
  }
  return sub;
}

/** Internal: dispatch to the right exporter based on recordKind. */
async function runExport({ bucketId, recordKind, recordId }) {
  const opts = { subscription: { recordKind, recordId } };
  if (recordKind === 'series') return exportSeries(recordId, bucketId, opts);
  if (recordKind === 'universe') return exportUniverse(recordId, bucketId, opts);
  return null;
}

export async function unsubscribe(id) {
  if (!isStr(id)) throw makeErr('subscription id required', ERR_VALIDATION);
  const state = await readState();
  const idx = state.subscriptions.findIndex((s) => s.id === id);
  if (idx < 0) throw makeErr(`Subscription not found: ${id}`, ERR_NOT_FOUND);
  const sub = state.subscriptions[idx];

  // Cancel any pending debounced re-export — otherwise the timer fires ~3s
  // later, the sub is gone, and reexportNow no-ops, but the timer + the
  // reference to its closure linger in the pendingTimers Map until the
  // setTimeout callback runs.
  const pending = pendingTimers.get(sub.id);
  if (pending) {
    clearTimeout(pending);
    pendingTimers.delete(sub.id);
  }

  // Delete the deterministic file from the bucket. Best-effort: the bucket
  // path may be unmounted; the subscription record removal still wins so the
  // user's "I want to stop sharing" intent is honored regardless. Importers
  // on other peers see the file vanish via chokidar `unlink`.
  //
  // Also clean up the pre-sharing-v2 legacy filename (`sub-<kind>-<id>.json`)
  // if it exists AND was authored by THIS instance — a peer that subscribed
  // pre-upgrade and unsubscribed post-upgrade would otherwise leave a phantom
  // file in the bucket. Read the file's `senderInstanceId` before unlinking
  // so we don't stomp on a different peer's pre-upgrade share. We only unlink
  // on a strict positive match — a legacy file missing `senderInstanceId`
  // (very early v1 or malformed) is left alone, since ownership cannot be
  // verified and removing a peer's share is worse than leaving a phantom.
  const bucket = await getBucket(sub.bucketId).catch(() => null);
  if (bucket) {
    const myInstanceId = await getInstanceId().catch(() => null);
    const filename = subscriptionFilename({ ...sub, senderInstanceId: myInstanceId });
    const filePath = join(bucket.path, 'manifests', filename);
    if (existsSync(filePath)) {
      await unlink(filePath).catch((err) => {
        console.log(`⚠️ sharing.subscriptions: failed to remove ${filePath}: ${err.message}`);
      });
    }
    const legacyName = legacySubscriptionFilename(sub);
    const legacyPath = join(bucket.path, 'manifests', legacyName);
    if (existsSync(legacyPath) && isStr(myInstanceId)) {
      const legacy = await readJSONFile(legacyPath, null, { logError: false });
      if (legacy && legacy.senderInstanceId === myInstanceId) {
        await unlink(legacyPath).catch((err) => {
          console.log(`⚠️ sharing.subscriptions: failed to remove legacy ${legacyPath}: ${err.message}`);
        });
      }
    }
  }

  state.subscriptions.splice(idx, 1);
  await writeState(state);
  return { id, removed: true };
}

/**
 * Drop every subscription that targets a given (recordKind, recordId). Used
 * by the `deleted` recordEvents listener so deleting a series/universe
 * automatically tears down its outgoing subscriptions instead of leaving
 * orphaned entries that fail every re-export.
 */
export async function unsubscribeAllForRecord(recordKind, recordId) {
  const matching = await listSubscriptions({ recordKind, recordId });
  const removed = [];
  for (const sub of matching) {
    await unsubscribe(sub.id).catch((err) => {
      console.log(`⚠️ sharing.subscriptions: auto-unsubscribe failed for ${sub.id}: ${err.message}`);
    });
    removed.push(sub.id);
  }
  return { removed };
}

/**
 * Re-export every subscription for a given (recordKind, recordId). Called by
 * the recordEvents listener. Debounced per subscription so a flurry of edits
 * coalesces into one export per ~3s window.
 */
const DEBOUNCE_MS = 3000;
const pendingTimers = new Map(); // subId → Timeout

async function reexportNow(sub) {
  const exp = await runExport(sub).catch((err) => {
    console.log(`⚠️ sharing.subscriptions: re-export failed for ${sub.id}: ${err.message}`);
    return null;
  });
  if (!exp) return;
  const state = await readState();
  const live = state.subscriptions.find((s) => s.id === sub.id);
  if (!live) return; // unsubscribed between the trigger and the write
  live.lastManifestId = exp.manifestId;
  live.lastExportedAt = new Date().toISOString();
  live.updatedAt = live.lastExportedAt;
  await writeState(state);
}

export async function reexportSubscribedRecord(recordKind, recordId) {
  if (isReexportSuppressed(recordKind, recordId)) return;
  const subs = await listSubscriptions({ recordKind, recordId });
  for (const sub of subs) {
    const existing = pendingTimers.get(sub.id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      pendingTimers.delete(sub.id);
      reexportNow(sub).catch(() => {});
    }, DEBOUNCE_MS);
    // unref so a pending debounce can't keep the process alive past shutdown.
    if (typeof t.unref === 'function') t.unref();
    pendingTimers.set(sub.id, t);
  }
}

// Track the listener handles we install so __resetForTests can remove just
// ours — `removeAllListeners('updated')` would also kill listeners installed
// by neighboring test files that share the recordEvents bus.
let onUpdated = null;
let onDeleted = null;

/** Attach the recordEvents listeners — call once during sharing init. */
export function installSubscriptionListener() {
  if (onUpdated || onDeleted) return;
  onUpdated = ({ recordKind, recordId }) => {
    reexportSubscribedRecord(recordKind, recordId).catch((err) => {
      console.log(`⚠️ sharing.subscriptions: listener error for ${recordKind}/${recordId}: ${err.message}`);
    });
  };
  onDeleted = ({ recordKind, recordId }) => {
    unsubscribeAllForRecord(recordKind, recordId).catch((err) => {
      console.log(`⚠️ sharing.subscriptions: delete-listener error for ${recordKind}/${recordId}: ${err.message}`);
    });
  };
  recordEvents.on('updated', onUpdated);
  recordEvents.on('deleted', onDeleted);
}

/** Test-only: clear pending debounces and detach our own listeners. */
export function __resetForTests() {
  for (const t of pendingTimers.values()) clearTimeout(t);
  pendingTimers.clear();
  __resetReexportSuppression();
  if (onUpdated) recordEvents.off('updated', onUpdated);
  if (onDeleted) recordEvents.off('deleted', onDeleted);
  onUpdated = null;
  onDeleted = null;
}
