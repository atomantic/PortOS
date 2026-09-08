import { request as httpRequest } from 'node:http';
import { createTailscaleServers, watchCertReload } from '../../lib/tailscale-https.js';
import { certPaths } from '../../lib/certPaths.js';
import { isPortReachable } from '../lib/connectivity.js';
import { PATHS } from '../lib/fileUtils.js';
import { PORTS } from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { EIDOVERSE_PORT } from './eidoverse.js';
import {
  handleEidoverseHttp,
  proxyUpgradeToEidoverse,
  createEidoverseExpressMiddleware,
  mountEidoverseWebSocket,
  EIDOVERSE_HOST_PATH_PREFIX,
} from './eidoverseProxy.js';

export { EIDOVERSE_HOST_PATH_PREFIX };

// Where a conflicting listener would sit. A local squatter almost always claims
// loopback — Docker publishes to 127.0.0.1, dev servers bind localhost — and
// loopback is also the address this bridge's own traffic arrives on when the
// page is opened from the host itself. The probe stays short because it runs on
// the startup path, before this bridge will accept anything.
const CONFLICT_PROBE_HOST = '127.0.0.1';
const CONFLICT_PROBE_TIMEOUT_MS = 300;

/**
 * Create the lazy Eidoverse HTTPS bridge. The target is fixed at construction
 * time, so this is not a general-purpose proxy. No listener is opened until
 * `start()` is called by the user-facing Eidoverse page.
 *
 * Prefer the main-server `/eidoverse-host` mount (see `mountEidoverseOnServer`)
 * for same-origin / single-port forwards; :5563 remains an optional ExternalLink
 * fallback when a machine certificate is in play.
 */
export function createEidoverseHost({
  targetHost = '127.0.0.1',
  targetPort = EIDOVERSE_PORT,
  listenHost = '0.0.0.0',
  listenPort = PORTS.EIDOVERSE_HOST,
  certDir = certPaths(PATHS.data).dir,
} = {}) {
  let server = null;
  let httpsEnabled = false;
  let startInFlight = null;
  let stopCertWatch = () => {};
  const sockets = new Set();

  const trackSocket = (rawSocket) => {
    if (sockets.has(rawSocket)) return rawSocket;
    sockets.add(rawSocket);
    rawSocket.once('close', () => sockets.delete(rawSocket));
    return rawSocket;
  };

  const protocol = () => (httpsEnabled ? 'https' : 'http');

  const status = () => {
    const address = server?.address();
    return {
      running: Boolean(server?.listening),
      protocol: protocol(),
      port: address && typeof address === 'object' ? address.port : listenPort,
    };
  };

  const handleHttp = (req, res) => {
    // Bridge mode: parent origin is the PortOS page (API port), not :5563.
    handleEidoverseHttp({
      req,
      res,
      protocol: protocol(),
      embedMode: 'bridge',
      targetHost,
      targetPort,
    });
  };

  const handleUpgrade = (req, clientSocket, head) => {
    proxyUpgradeToEidoverse({
      req,
      clientSocket,
      head,
      targetHost,
      targetPort,
      protocol: protocol(),
      trackSocket,
    });
  };

  const targetIsReady = () => new Promise((resolve) => {
    const probe = httpRequest({ hostname: targetHost, port: targetPort, path: '/', method: 'GET' }, (response) => {
      response.resume();
      resolve(true);
    });
    probe.setTimeout(500, () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', () => resolve(false));
    probe.end();
  });

  const waitUntilReady = async ({ attempts = 20, intervalMs = 250 } = {}) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await targetIsReady()) return status();
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    throw new ServerError('Eidoverse Worlds did not become ready in time.', {
      status: 503,
      code: 'EIDOVERSE_NOT_READY',
    });
  };

  /**
   * Is someone already serving this port? A wildcard bind does NOT collide with
   * an existing address-specific bind — macOS/BSD accept both, and the specific
   * bind wins every connection — so `listen('0.0.0.0')` reports success while
   * this bridge receives nothing and logs that it is listening. `listen` cannot
   * surface that, so probe before binding and fail loudly instead.
   */
  const portIsClaimed = async () => {
    // Port 0 asks the OS for a free ephemeral port, so there is nothing to
    // collide with — and it is not a connectable address to probe.
    if (!listenPort) return false;

    return isPortReachable({ host: CONFLICT_PROBE_HOST, port: listenPort, timeoutMs: CONFLICT_PROBE_TIMEOUT_MS });
  };

  const openListener = async () => {
    if (await portIsClaimed()) {
      throw new ServerError(
        `Port ${listenPort} is already served by another process, so the Eidoverse bridge would bind without ever receiving a request. `
        + `${listenPort} is reserved for PortOS — move that app to the user range (see docs/PORTS.md), then retry.`,
        { status: 409, code: 'EIDOVERSE_HOST_PORT_CONFLICT' },
      );
    }

    const created = createTailscaleServers(handleHttp, { certDir, httpMirror: false });
    server = created.server;
    httpsEnabled = created.httpsEnabled;
    server.on('connection', trackSocket);
    server.on('upgrade', handleUpgrade);

    return new Promise((resolve, reject) => {
      const handleListenError = (error) => reject(error);
      server.once('error', handleListenError);
      server.listen(listenPort, listenHost, () => {
        server.off('error', handleListenError);
        server.on('error', (error) => console.error(`❌ Eidoverse host failed: ${error.message}`));
        stopCertWatch = httpsEnabled ? watchCertReload(server, certDir) : () => {};
        console.log(`🌐 Eidoverse host listening on ${protocol()}://${listenHost}:${status().port}`);
        resolve(status());
      });
    });
  };

  const start = () => {
    if (server?.listening) return Promise.resolve(status());
    if (startInFlight) return startInFlight;

    startInFlight = openListener()
      .catch((error) => {
        server?.close();
        server = null;
        httpsEnabled = false;
        throw error;
      })
      .finally(() => {
        startInFlight = null;
      });
    return startInFlight;
  };

  const close = async () => {
    stopCertWatch();
    stopCertWatch = () => {};
    sockets.forEach((socket) => socket.destroy());
    if (!server?.listening) {
      server = null;
      httpsEnabled = false;
      return;
    }
    const activeServer = server;
    server = null;
    httpsEnabled = false;
    await new Promise((resolve, reject) => {
      activeServer.close((error) => (error ? reject(error) : resolve()));
    });
  };

  return Object.freeze({ start, close, status, waitUntilReady });
}

let eidoverseHost = null;

/** True once the on-demand host bridge has been started for this process. */
export function isEidoverseHostActive() {
  return Boolean(eidoverseHost?.status()?.running);
}

export async function ensureEidoverseHost() {
  eidoverseHost ||= createEidoverseHost();
  await eidoverseHost.start();
  return eidoverseHost.waitUntilReady();
}

/**
 * Wire the same-origin `/eidoverse-host` path proxy + root allowlist onto the
 * main Express app and HTTP(S) servers. Call once at boot (like
 * `remoteDesktopBroker.mountWebSocket`). Proxies only fire while the host is
 * active after `ensureEidoverseHost()`.
 */
export function mountEidoverseOnServer(app, httpServers = []) {
  if (app) {
    app.use(createEidoverseExpressMiddleware({
      isActive: isEidoverseHostActive,
      targetHost: '127.0.0.1',
      targetPort: EIDOVERSE_PORT,
      getProtocol: (req) => {
        if (req.secure) return 'https';
        const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        if (forwarded === 'https' || forwarded === 'http') return forwarded;
        // HTTPS main server with HTTP loopback mirror: mirror is plain HTTP.
        return 'http';
      },
    }));
  }
  for (const httpServer of httpServers) {
    if (!httpServer) continue;
    mountEidoverseWebSocket(httpServer, {
      isActive: isEidoverseHostActive,
      targetHost: '127.0.0.1',
      targetPort: EIDOVERSE_PORT,
      getProtocol: (req) => {
        // Socket upgrades on the TLS server are https; the loopback mirror is http.
        // `req.socket.encrypted` is set for TLS sockets.
        if (req.socket?.encrypted) return 'https';
        return 'http';
      },
    });
  }
}

/** Test helper: replace the process-wide host singleton. */
export function __setEidoverseHostForTests(host) {
  eidoverseHost = host;
}
