/**
 * Shared reverse-proxy primitives for Eidoverse Worlds.
 *
 * Used by:
 *   - the optional :5563 bridge (eidoverseHost.js)
 *   - the main :5555 server path `/eidoverse-host` + root allowlist (so a
 *     single-port tailcat forward can embed the iframe same-origin)
 */
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import {
  EIDOVERSE_HOST_PATH_PREFIX,
  isEidoverseRootProxyPath,
  stripEidoverseHostPrefix,
} from '../lib/eidoverseProxyRoutes.js';
import { PORTS } from '../lib/ports.js';
import { EIDOVERSE_PORT } from './eidoverse.js';

export { EIDOVERSE_HOST_PATH_PREFIX, isEidoverseRootProxyPath, stripEidoverseHostPrefix };

const BAD_GATEWAY_BODY = 'Eidoverse Worlds is not running.';
const HOST_DESCRIPTOR_PATH = '/host';
const EMBED_CONFIG_PATH = '/embed-config';
const FORWARDED_HEADER_NAMES = new Set(['host', 'x-forwarded-host', 'x-forwarded-proto']);

const targetAuthority = (host, port) => `${host}:${port}`;

export const forwardedHeaders = (req, protocol, targetHost, targetPort) => ({
  ...req.headers,
  host: targetAuthority(targetHost, targetPort),
  'x-forwarded-host': req.headers.host || '',
  'x-forwarded-proto': protocol,
});

export const requestPathname = (url) => String(url || '').split('?')[0].replace(/\/+$/, '') || '/';

export const writePlainText = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
};

export const writeBadGateway = (res) => {
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

/**
 * Hostname from the browser Host header. Keeps IPv6 brackets; refuses junk.
 */
export const requestHostname = (req) => {
  const raw = String(req.headers.host || '').trim();
  if (!raw) return null;
  const bracketed = raw.startsWith('[') && raw.includes(']') ? raw.slice(0, raw.indexOf(']') + 1) : null;
  const hostname = bracketed || raw.split(':')[0];
  return /^\[[0-9a-fA-F:.]+\]$/.test(hostname) || /^[a-zA-Z0-9.-]+$/.test(hostname) ? hostname : null;
};

/**
 * Validate a full Host header value (hostname or hostname:port / [ipv6]:port).
 */
const usableHostHeader = (raw) => {
  const host = String(raw || '').trim();
  if (!host) return null;
  // Reuse hostname extraction — if the hostname portion is usable, keep the
  // whole Host (including a non-5555 forward port like 15555).
  const fakeReq = { headers: { host } };
  return requestHostname(fakeReq) ? host : null;
};

/**
 * Parent origin for GET /embed-config.
 *
 * - `same-origin`: preserve the browser Host as-is (including a tailcat local
 *   forward port such as 127.0.0.1:15555). Used when the iframe is mounted at
 *   `/eidoverse-host` on the main PortOS server.
 * - `bridge`: hostname from Host + PortOS API port (not the :5563 bridge port).
 *   Used by the legacy dedicated bridge so ExternalLink embeds still handshake
 *   with the PortOS page origin.
 */
export const embedParentOrigin = (req, protocol, mode = 'bridge') => {
  if (mode === 'same-origin') {
    const host = usableHostHeader(req.headers.host);
    return host ? `${protocol}://${host}` : null;
  }
  const hostname = requestHostname(req);
  return hostname ? `${protocol}://${hostname}:${Number(process.env.PORT) || PORTS.API}` : null;
};

export const serveEmbedConfig = (req, res, protocol, mode = 'bridge') => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writePlainText(res, 405, 'The PortOS embedding configuration is read-only.', { allow: 'GET, HEAD' });
    return;
  }
  const body = JSON.stringify({ parentOrigin: embedParentOrigin(req, protocol, mode) });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

export const serveHostDescriptor = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writePlainText(res, 405, 'The PortOS host descriptor is read-only.', { allow: 'GET, HEAD' });
    return;
  }
  const descriptor = await import('./eidoverseWorld.js')
    .then(({ readEidoverseHostDescriptor }) => readEidoverseHostDescriptor())
    .catch((error) => {
      console.error(`❌ Eidoverse host descriptor failed: ${error.message}`);
      return null;
    });
  if (!descriptor) {
    writePlainText(res, 503, 'The PortOS host descriptor is unavailable.');
    return;
  }
  const body = JSON.stringify(descriptor);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

export const websocketRequestHead = (req, protocol, targetHost, targetPort, pathOverride) => {
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
  const path = pathOverride ?? req.url;
  return `${req.method} ${path} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`;
};

export const proxyHttpToEidoverse = ({
  req,
  res,
  targetHost = '127.0.0.1',
  targetPort = EIDOVERSE_PORT,
  protocol,
  pathOverride,
}) => {
  const upstream = httpRequest({
    hostname: targetHost,
    port: targetPort,
    method: req.method,
    path: pathOverride ?? req.url,
    headers: forwardedHeaders(req, protocol, targetHost, targetPort),
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.once('error', () => res.destroy());
    upstreamResponse.pipe(res);
  });
  upstream.once('error', () => writeBadGateway(res));
  req.once('aborted', () => upstream.destroy());
  req.pipe(upstream);
};

export const proxyUpgradeToEidoverse = ({
  req,
  clientSocket,
  head,
  targetHost = '127.0.0.1',
  targetPort = EIDOVERSE_PORT,
  protocol,
  pathOverride,
  trackSocket = (socket) => socket,
}) => {
  trackSocket(clientSocket);
  const upstreamSocket = trackSocket(createConnection({ host: targetHost, port: targetPort }));
  let connected = false;

  upstreamSocket.once('connect', () => {
    connected = true;
    upstreamSocket.write(websocketRequestHead(req, protocol, targetHost, targetPort, pathOverride));
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

/**
 * Terminate PortOS-owned paths, else reverse-proxy to the sequencer.
 * `pathname` is the upstream path (prefix already stripped for path mounts).
 */
export const handleEidoverseHttp = ({
  req,
  res,
  protocol,
  embedMode = 'bridge',
  targetHost = '127.0.0.1',
  targetPort = EIDOVERSE_PORT,
  pathOverride,
}) => {
  const pathname = requestPathname(pathOverride ?? req.url);
  if (pathname === EMBED_CONFIG_PATH) {
    serveEmbedConfig(req, res, protocol, embedMode);
    return;
  }
  if (pathname === HOST_DESCRIPTOR_PATH) {
    serveHostDescriptor(req, res).catch((error) => {
      console.error(`❌ Eidoverse host descriptor response failed: ${error.message}`);
      res.destroy();
    });
    return;
  }
  proxyHttpToEidoverse({ req, res, targetHost, targetPort, protocol, pathOverride });
};

/**
 * Express middleware: `/eidoverse-host/*` (prefix stripped) + allowlisted root
 * routes, only while `isActive()` is true. Mount before the SPA fallback and
 * before the `/eidoverse-host` SERVER_OWNED terminator.
 */
export function createEidoverseExpressMiddleware({
  isActive,
  targetHost = '127.0.0.1',
  targetPort = EIDOVERSE_PORT,
  getProtocol = (req) => (req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'),
} = {}) {
  return function eidoverseExpressProxy(req, res, next) {
    if (!isActive?.()) return next();

    const stripped = stripEidoverseHostPrefix(req.url);
    if (stripped !== null) {
      const protocol = getProtocol(req);
      handleEidoverseHttp({
        req,
        res,
        protocol,
        embedMode: 'same-origin',
        targetHost,
        targetPort,
        pathOverride: stripped,
      });
      return;
    }

    const pathname = String(req.path || requestPathname(req.url));
    if (!isEidoverseRootProxyPath(pathname)) return next();

    const protocol = getProtocol(req);
    handleEidoverseHttp({
      req,
      res,
      protocol,
      embedMode: 'same-origin',
      targetHost,
      targetPort,
      pathOverride: req.url,
    });
  };
}

const mountedUpgradeServers = new WeakSet();

/**
 * Attach an `upgrade` listener for `/ws` and `/eidoverse-host/**` while active.
 * Safe to call for both the HTTPS server and the loopback HTTP mirror.
 */
export function mountEidoverseWebSocket(httpServer, {
  isActive,
  targetHost = '127.0.0.1',
  targetPort = EIDOVERSE_PORT,
  getProtocol = () => 'http',
} = {}) {
  if (!httpServer || mountedUpgradeServers.has(httpServer)) return;
  mountedUpgradeServers.add(httpServer);

  httpServer.on('upgrade', (req, clientSocket, head) => {
    if (!isActive?.()) return;

    const stripped = stripEidoverseHostPrefix(req.url);
    let pathOverride = null;
    if (stripped !== null) {
      pathOverride = stripped;
    } else {
      const pathname = requestPathname(req.url);
      if (pathname !== '/ws') return;
      pathOverride = req.url;
    }

    const protocol = typeof getProtocol === 'function' ? getProtocol(req) : getProtocol;
    proxyUpgradeToEidoverse({
      req,
      clientSocket,
      head,
      targetHost,
      targetPort,
      protocol,
      pathOverride,
    });
  });
}

export const BAD_GATEWAY_MESSAGE = BAD_GATEWAY_BODY;
