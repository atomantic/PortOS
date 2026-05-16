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

export { sharingEvents } from './importer.js';
export { attachWatcher, detachWatcher, listAttachedWatchers };

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
    sharingEvents.on('unshared', (payload) => {
      io.emit('sharing:unshared', payload);
    });
  }

  installSubscriptionListener();
  const result = await attachAllWatchers();
  console.log(`📡 sharing: initialized, watchers attached for ${result.attached} bucket(s)`);
  return result;
}

export async function shutdownSharing() {
  await shutdownAllWatchers();
  sharingEvents.removeAllListeners();
  initialized = false;
  io = null;
}
