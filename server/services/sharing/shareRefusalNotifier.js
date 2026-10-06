/**
 * Share-refusal notifier.
 *
 * The importer refuses a manifest this install is too old to apply — a newer
 * share protocol (`incompatible-manifest`) or a storage layout ahead of ours on
 * a category the share carries (`portos-schema-ahead`). Share buckets fill
 * while nobody is watching, so a socket toast alone is missed: this turns each
 * refusal into a persistent bell card, one per manifest, retracted once that
 * manifest imports (after the upgrade) or the sender withdraws it.
 * Machine-local — `data/notifications.json` is never federated.
 */

import { addNotification, exists, removeByMetadata, NOTIFICATION_TYPES, PRIORITY_LEVELS } from '../notifications.js';

const KEY_FIELD = 'shareRefusalKey';

const refusalKey = ({ bucketId, manifestFilename }) => `${bucketId}/${manifestFilename}`;

const describeSender = ({ source, producedByVersion }) => {
  const name = source && source !== 'unknown' ? source : 'A peer';
  return producedByVersion && producedByVersion !== 'unknown' ? `${name} (PortOS ${producedByVersion})` : name;
};

const describeGap = (kind, payload) => (kind === 'incompatible-manifest'
  ? `uses share protocol v${payload.remoteVersion}; this install reads v${payload.localVersion}`
  : `uses a newer ${(payload.ahead || []).map((gap) => gap.category).join(', ') || 'storage'} format than this install`);

async function notifyShareRefused(kind, payload) {
  if (!payload?.bucketId || !payload.manifestFilename) return false;
  const key = refusalKey(payload);
  if (await exists(NOTIFICATION_TYPES.SHARE_BLOCKED, KEY_FIELD, key)) return false;
  await addNotification({
    type: NOTIFICATION_TYPES.SHARE_BLOCKED,
    title: 'Share needs a PortOS update',
    description: `A share from ${describeSender(payload)} ${describeGap(kind, payload)}. Update PortOS — it imports it automatically after the update.`,
    priority: PRIORITY_LEVELS.HIGH,
    link: `/sharing/buckets/${encodeURIComponent(payload.bucketId)}?tab=activity`,
    metadata: { [KEY_FIELD]: key, bucketId: payload.bucketId },
  });
  return true;
}

async function clearShareRefusal(payload) {
  if (!payload?.bucketId || !payload.manifestFilename) return;
  await removeByMetadata(KEY_FIELD, refusalKey(payload));
}

/** Wire the importer's refusal and resolution events to the bell. */
export function installShareRefusalNotifier(sharingEvents) {
  // EventEmitter listeners run outside any request lifecycle: a rejection here
  // would be unhandled, so each one is caught and logged.
  for (const kind of ['incompatible-manifest', 'portos-schema-ahead']) {
    sharingEvents.on(kind, (payload) => {
      notifyShareRefused(kind, payload)
        .catch((err) => console.error(`❌ sharing: refused-share notification failed: ${err.message}`));
    });
  }
  for (const resolved of ['manifest-processed', 'unshared']) {
    sharingEvents.on(resolved, (payload) => {
      clearShareRefusal(payload)
        .catch((err) => console.error(`❌ sharing: refused-share notification cleanup failed: ${err.message}`));
    });
  }
}
