/** A separate remote ingress: Tailcat's localhost hop must not imply local authority. */
import { createTailscaleServers, watchCertReload } from '../../lib/tailscale-https.js';
import { remoteDesktopBroker } from './remoteDesktop.js';
import { PORTS } from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { markRemoteServer, remoteRequestHandler } from '../lib/requestOrigin.js';

let configuration = null;
let listener = null;
let starting = null;
let stopListener = null;

// Configure only; no listener or Tailcat process starts at import/boot.
export function configureTailcatIngress({ app, io, certDir, httpsEnabled, broker = remoteDesktopBroker }) {
  stopTailcatIngress();
  configuration = { app, io, certDir, httpsEnabled, broker };
}

export function createTailcatIngressServer(app, { certDir, httpsEnabled } = {}) {
  // Match the main server's boot-time protocol even if provisioning has since
  // created new cert files. Never silently downgrade an active HTTPS install.
  const result = createTailscaleServers(remoteRequestHandler(app), {
    certDir: httpsEnabled === false ? undefined : certDir,
    httpMirror: false,
  });
  if (httpsEnabled === true && !result.httpsEnabled) {
    throw new ServerError('Tailcat ingress requires the active API TLS certificate', { status: 503 });
  }
  return result;
}

export function ensureTailcatIngress() {
  if (listener?.listening) return Promise.resolve();
  if (starting) return starting;
  if (!configuration) return Promise.reject(new ServerError('Tailcat ingress is not configured', { status: 503 }));
  const { app, io, certDir, broker, httpsEnabled: apiHttpsEnabled } = configuration;
  const { server, httpsEnabled } = createTailcatIngressServer(app, { certDir, httpsEnabled: apiHttpsEnabled });
  listener = server;
  const sockets = new Set();
  let rejectStartup;
  let unmountDesktop;
  let stopWatching;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const dispose = () => {
    rejectStartup?.(new Error('Tailcat ingress stopped during startup'));
    stopWatching?.();
    unmountDesktop?.();
    // HTTP closeAllConnections excludes upgrades, including Socket.IO and noVNC.
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  stopListener = dispose;
  const attempt = new Promise((resolve, reject) => {
    rejectStartup = reject;
    server.once('error', reject);
    server.listen(PORTS.TAILCAT_INGRESS, '127.0.0.1', () => {
      // Listen callbacks are outside Express's error boundary.
      try {
        if (listener !== server) throw new Error('Tailcat ingress stopped during startup');
        server.removeListener('error', reject);
        server.on('error', (err) => console.error(`❌ Tailcat ingress failed: ${err.message}`));
        io.attach(server);
        unmountDesktop = broker.mountWebSocket(server);
        markRemoteServer(server);
        if (httpsEnabled) stopWatching = watchCertReload(server, certDir);
        rejectStartup = null;
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }).catch((err) => {
    if (listener === server) stopTailcatIngress();
    else dispose();
    throw new ServerError(`Could not start Tailcat ingress: ${err.message}`, { status: 503 });
  }).finally(() => { if (starting === attempt) starting = null; });
  starting = attempt;
  return attempt;
}

export function stopTailcatIngress() {
  listener = null;
  starting = null;
  const stop = stopListener;
  stopListener = null;
  stop?.();
}
