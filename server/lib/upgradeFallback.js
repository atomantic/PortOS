/**
 * Upgrade fallback for HTTP servers sharing a port with Socket.IO.
 *
 * Socket.IO's engine.io server attaches an `upgrade` listener that defaults
 * to destroying any upgrade socket that does not match Socket.IO's path after
 * 1000ms if bytesWritten <= 0 (`destroyUpgrade: true`).
 *
 * For PortOS reverse proxies (e.g. Eidoverse `/ws` proxy) whose upstream
 * handshake can take longer than 1 second, engine.io's timer prematurely
 * ends the client socket before the upstream 101 can arrive.
 *
 * Setting `destroyUpgrade: false` on Socket.IO prevents engine.io from racing
 * legitimate reverse proxies. This PortOS-owned fallback ensures unclaimed
 * upgrade sockets still terminate after a bounded timeout rather than leaking
 * open indefinitely.
 */

const mountedUpgradeFallbackServers = new WeakSet();

export const DEFAULT_UPGRADE_TIMEOUT_MS = 1000;

/**
 * Mark a socket as claimed by a PortOS upgrade handler.
 * Sockets marked claimed will not be destroyed by the fallback timer.
 *
 * @param {import('node:net').Socket} socket
 */
export function markUpgradeClaimed(socket) {
  if (socket) {
    socket.portosUpgradeClaimed = true;
  }
}

function hasEngineIoListener(server) {
  if (!server || typeof server.listeners !== 'function') return false;
  return server.listeners('upgrade').some((fn) => {
    const src = fn.toString();
    return src.includes('handleUpgrade') && src.includes('destroyUpgrade');
  });
}

function isEngineIoUpgrade(server, req, customPath = '/socket.io') {
  if (!hasEngineIoListener(server)) return false;
  const prefix = (customPath || '/socket.io').replace(/\/$/, '') + '/';
  return typeof req?.url === 'string' && req.url.slice(0, prefix.length) === prefix;
}

/**
 * Install an upgrade fallback listener on an HTTP/HTTPS server.
 * Unclaimed sockets that receive no response after `timeoutMs` are ended.
 *
 * @param {import('node:http').Server|import('node:https').Server|null|undefined} server
 * @param {object} [options]
 * @param {number} [options.timeoutMs=1000]
 * @param {string} [options.socketIoPath='/socket.io']
 * @param {((req: import('node:http').IncomingMessage, socket: import('node:net').Socket) => boolean)} [options.isClaimed]
 * @returns {(() => void)} Cleanup function to detach listener
 */
export function installUpgradeFallback(server, {
  timeoutMs = DEFAULT_UPGRADE_TIMEOUT_MS,
  socketIoPath = '/socket.io',
  isClaimed = () => false,
} = {}) {
  if (!server || typeof server.on !== 'function') {
    return () => {};
  }
  if (mountedUpgradeFallbackServers.has(server)) {
    return () => {};
  }
  mountedUpgradeFallbackServers.add(server);

  const onUpgrade = (req, socket) => {
    if (socket.portosUpgradeClaimed || isEngineIoUpgrade(server, req, socketIoPath) || isClaimed(req, socket)) {
      socket.portosUpgradeClaimed = true;
      return;
    }
    const initialBytes = socket.bytesWritten;

    let timer = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    socket.once('close', cleanup);
    socket.once('error', cleanup);

    timer = setTimeout(() => {
      socket.off('close', cleanup);
      socket.off('error', cleanup);
      if (socket.portosUpgradeClaimed) return;
      if (!socket.writable || socket.destroyed) return;
      if (socket.bytesWritten > initialBytes) return;
      socket.on('error', () => {});
      socket.end();
      const destroyTimer = setTimeout(() => {
        if (!socket.destroyed) {
          socket.destroy();
        }
      }, 100);
      destroyTimer.unref?.();
    }, timeoutMs);

    timer.unref?.();
  };

  server.prependListener('upgrade', onUpgrade);

  return () => {
    mountedUpgradeFallbackServers.delete(server);
    server.off('upgrade', onUpgrade);
  };
}

export const mountUpgradeFallback = installUpgradeFallback;
