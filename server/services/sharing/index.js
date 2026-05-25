/**
 * Share Bucket — lifecycle entry point.
 *
 * Called from server/index.js once on boot. Attaches a chokidar watcher to
 * each registered bucket's `manifests/` directory, processes any backlog from
 * while the server was offline, and wires Socket.IO so the UI can react to
 * inbox updates / watcher errors live.
 */

import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { join } from 'path';
import { attachAllWatchers, attachWatcher, detachWatcher, shutdownAllWatchers, listAttachedWatchers } from './watcher.js';
import { sharingEvents } from './importer.js';
import { installSubscriptionListener } from './subscriptions.js';
import { installPeerSyncListener, uninstallPeerSyncListener, peerSyncEvents } from './peerSync.js';
import { initAnnotationsSync } from './annotationsSync.js';

export { sharingEvents } from './importer.js';
export { attachWatcher, detachWatcher, listAttachedWatchers };
export { pullSidecarForImage, backfillMissingSidecars } from './sidecarSync.js';

let initialized = false;
let io = null;

export async function initSharing({ io: socketIo } = {}) {
  if (initialized) return;
  initialized = true;
  io = socketIo || null;
  await ensureDir(join(PATHS.data, 'sharing'));
  await ensureDir(join(PATHS.data, 'sharing', 'cursors'));
  await ensureDir(join(PATHS.data, 'sharing', 'inbox'));

  // Wire socket events for the client UI.
  if (io) {
    sharingEvents.on('manifest-processed', (payload) => {
      io.emit('sharing:manifest-processed', payload);
      if (payload.outcome?.mode === 'inbox') {
        io.emit('sharing:inbox-updated', { bucketId: payload.bucketId });
      }
    });
    sharingEvents.on('inbox-updated', (payload) => {
      io.emit('sharing:inbox-updated', payload);
    });
    sharingEvents.on('watcher-attached', (payload) => {
      io.emit('sharing:watcher-attached', payload);
    });
    sharingEvents.on('watcher-detached', (payload) => {
      io.emit('sharing:watcher-detached', payload);
    });
    sharingEvents.on('incompatible-manifest', (payload) => {
      io.emit('sharing:incompatible-manifest', payload);
    });
    // PortOS storage-layout version is ahead of this instance — the user
    // needs to update PortOS to import the manifest. Separate event from
    // `incompatible-manifest` (which gates on the share-protocol schema, a
    // different version axis) so the UI can render distinct messages for
    // each case.
    sharingEvents.on('portos-schema-ahead', (payload) => {
      io.emit('sharing:portos-schema-ahead', payload);
    });
    // Peer-sync per-record subscription got blocked / unblocked by a schema-
    // version mismatch. Lets the Instances UI swap in the SchemaGapBadge
    // without polling.
    peerSyncEvents.on('subscription-blocked', (payload) => {
      io.emit('peerSync:subscription-blocked', payload);
    });
    peerSyncEvents.on('subscription-unblocked', (payload) => {
      io.emit('peerSync:subscription-unblocked', payload);
    });
    sharingEvents.on('unshared', (payload) => {
      io.emit('sharing:unshared', payload);
    });
    // Peer-driven annotation merges re-use the same `media:annotation:updated`
    // socket event the local PATCH route emits, so open UI consumers handle
    // both transports through the same listener.
    sharingEvents.on('annotation-updated', (payload) => {
      io.emit('media:annotation:updated', payload);
    });
    // Peer-sync asset arrivals → broadcast so the UI can swap the
    // <MediaImage> "syncing" placeholder for the live bytes the moment
    // the receiver's background pull lands them on disk.
    peerSyncEvents.on('asset-arrived', (payload) => {
      io.emit('peerSync:asset-arrived', payload);
    });
  }

  installSubscriptionListener();
  // Federated peer-sync listener — installs alongside the share-bucket
  // subscription listener so a single recordEvents `updated` fan-out drives
  // both transports. No state until at least one peer subscription exists.
  installPeerSyncListener();
  initAnnotationsSync();
  const result = await attachAllWatchers();
  console.log(`📡 sharing: initialized, watchers attached for ${result.attached} bucket(s)`);
  return result;
}

export async function shutdownSharing() {
  await shutdownAllWatchers();
  sharingEvents.removeAllListeners();
  // Detach the recordEvents + instanceEvents listeners that
  // installPeerSyncListener attached. Without this, the peer-sync service
  // listeners stay attached after shutdown and pollute any subsequent
  // re-init or test teardown.
  uninstallPeerSyncListener();
  peerSyncEvents.removeAllListeners();
  initialized = false;
  io = null;
}
