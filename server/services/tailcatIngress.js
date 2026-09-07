/** A separate remote ingress: Tailcat's localhost hop must not imply local authority. */
import { createTailscaleServers, watchCertReload } from '../../lib/tailscale-https.js';
import { PORTS } from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { remoteRequestHandler } from '../lib/requestOrigin.js';

let configuration = null;
let listener = null;
let starting = null;
let stopWatching = null;

// Configure only; no listener or Tailcat process starts at import/boot.
export function configureTailcatIngress({ app, io, certDir, httpsEnabled }) {
  configuration = { app, io, certDir, httpsEnabled };
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
  const { app, io, certDir, httpsEnabled: apiHttpsEnabled } = configuration;
  const { server, httpsEnabled } = createTailcatIngressServer(app, { certDir, httpsEnabled: apiHttpsEnabled });
  listener = server;
  starting = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORTS.TAILCAT_INGRESS, '127.0.0.1', () => {
      // Listen callbacks are outside Express's error boundary.
      try {
        if (listener !== server) throw new Error('Tailcat ingress stopped during startup');
        server.removeListener('error', reject);
        server.on('error', (err) => console.error(`❌ Tailcat ingress failed: ${err.message}`));
        io.attach(server);
        if (httpsEnabled) stopWatching = watchCertReload(server, certDir);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }).catch((err) => {
    stopTailcatIngress();
    throw new ServerError(`Could not start Tailcat ingress: ${err.message}`, { status: 503 });
  }).finally(() => { starting = null; });
  return starting;
}

export function stopTailcatIngress() {
  stopWatching?.();
  stopWatching = null;
  const server = listener;
  listener = null;
  if (!server) return;
  server.closeAllConnections?.();
  // Socket.IO's shutdown closes upgraded connections. Never wait for them here.
  server.close();
}
