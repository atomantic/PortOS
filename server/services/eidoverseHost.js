import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { createTailscaleServers, watchCertReload } from '../../lib/tailscale-https.js';
import { certPaths } from '../../lib/certPaths.js';
import { PATHS } from '../lib/fileUtils.js';
import { PORTS } from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { EIDOVERSE_PORT } from './eidoverse.js';

const BAD_GATEWAY_BODY = 'Eidoverse Worlds is not running.';

// Where a conflicting listener would sit. A local squatter almost always claims
// loopback — Docker publishes to 127.0.0.1, dev servers bind localhost — and
// loopback is also the address this bridge's own traffic arrives on when the
// page is opened from the host itself.
const CONFLICT_PROBE_HOST = '127.0.0.1';
const CONFLICT_PROBE_TIMEOUT_MS = 300;
const FORWARDED_HEADER_NAMES = new Set(['host', 'x-forwarded-host', 'x-forwarded-proto']);

const targetAuthority = (host, port) => `${host}:${port}`;

const forwardedHeaders = (req, protocol, targetHost, targetPort) => ({
  ...req.headers,
  host: targetAuthority(targetHost, targetPort),
  'x-forwarded-host': req.headers.host || '',
  'x-forwarded-proto': protocol,
});

const writeBadGateway = (res) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(502, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(BAD_GATEWAY_BODY),
  });
  res.end(BAD_GATEWAY_BODY);
};

const websocketRequestHead = (req, protocol, targetHost, targetPort) => {
  const headers = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    if (!FORWARDED_HEADER_NAMES.has(name.toLowerCase())) {
      headers.push(`${name}: ${req.rawHeaders[index + 1]}`);
    }
  }
  headers.push(`Host: ${targetAuthority(targetHost, targetPort)}`);
  headers.push(`X-Forwarded-Host: ${req.headers.host || ''}`);
  headers.push(`X-Forwarded-Proto: ${protocol}`);
  return `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`;
};

/**
 * Create the lazy Eidoverse HTTPS bridge. The target is fixed at construction
 * time, so this is not a general-purpose proxy. No listener is opened until
 * `start()` is called by the user-facing Eidoverse page.
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
    const upstream = httpRequest({
      hostname: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req, protocol(), targetHost, targetPort),
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.once('error', () => res.destroy());
      upstreamResponse.pipe(res);
    });
    upstream.once('error', () => writeBadGateway(res));
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  };

  const handleUpgrade = (req, clientSocket, head) => {
    trackSocket(clientSocket);
    const upstreamSocket = trackSocket(createConnection({ host: targetHost, port: targetPort }));
    let connected = false;

    upstreamSocket.once('connect', () => {
      connected = true;
      upstreamSocket.write(websocketRequestHead(req, protocol(), targetHost, targetPort));
      if (head.length > 0) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });

    upstreamSocket.on('error', () => {
      if (connected) {
        clientSocket.destroy();
        return;
      }
      if (!clientSocket.destroyed) {
        clientSocket.end(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(BAD_GATEWAY_BODY)}\r\nConnection: close\r\n\r\n${BAD_GATEWAY_BODY}`,
        );
      }
    });
    clientSocket.once('error', () => upstreamSocket.destroy());
    clientSocket.once('close', () => upstreamSocket.destroy());
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
  const portIsClaimed = () => new Promise((resolve) => {
    // Port 0 asks the OS for a free ephemeral port, so there is nothing to
    // collide with — and it is not a connectable address to probe.
    if (!listenPort) return resolve(false);

    const probe = createConnection({ host: CONFLICT_PROBE_HOST, port: listenPort });
    const settle = (claimed) => {
      probe.destroy();
      resolve(claimed);
    };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
    probe.setTimeout(CONFLICT_PROBE_TIMEOUT_MS, () => settle(false));
  });

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

export async function ensureEidoverseHost() {
  eidoverseHost ||= createEidoverseHost();
  await eidoverseHost.start();
  return eidoverseHost.waitUntilReady();
}
