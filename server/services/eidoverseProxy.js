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
import { EIDOVERSE_GUEST_COOKIE_NAME } from '../lib/eidoverseGuestCookie.js';
import { browserRequestRefusal, isSessionCookieName, parseCookie } from '../../lib/portosAuthCore.js';
import { PORTS } from '../lib/ports.js';
import { logSecurityEvent } from '../lib/securityAuditLog.js';
import { markUpgradeClaimed } from '../lib/upgradeFallback.js';
import { EIDOVERSE_PORT } from '../lib/eidoversePort.js';
import { proxyGuestWebSocket } from './eidoverse/guestWebSocket.js';

export { EIDOVERSE_HOST_PATH_PREFIX, isEidoverseRootProxyPath, stripEidoverseHostPrefix };

const BAD_GATEWAY_BODY = 'Eidoverse Worlds is not running.';
const HOST_DESCRIPTOR_PATH = '/host';
const EMBED_CONFIG_PATH = '/embed-config';
const FORWARDED_HEADER_NAMES = new Set(['host', 'x-forwarded-host', 'x-forwarded-proto']);

// Eidoverse Worlds is an external third-party process: PortOS operator
// credentials must never reach it, even though the browser attaches them to
// the same-origin proxy requests.
const STRIPPED_UPSTREAM_HEADERS = new Set(['authorization', 'x-portos-peer-auth', 'x-eidoverse-guest']);
const PORTOS_OWNED_COOKIES = new Set(['portos_autofixer_auth', EIDOVERSE_GUEST_COOKIE_NAME]);

export const stripPortosCookies = (cookieHeader) => {
  const kept = String(cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const name = part.split('=')[0].trim();
      return !isSessionCookieName(name) && !PORTOS_OWNED_COOKIES.has(name);
    });
  return kept.length ? kept.join('; ') : null;
};

const targetAuthority = (host, port) => `${host}:${port}`;

export const forwardedHeaders = (req, protocol, targetHost, targetPort) => {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!STRIPPED_UPSTREAM_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== 'cookie') headers[name] = value;
  }
  const cookie = stripPortosCookies(req.headers.cookie);
  if (cookie) headers.cookie = cookie;
  return {
  ...headers,
  host: targetAuthority(targetHost, targetPort),
  'x-forwarded-host': req.headers.host || '',
  'x-forwarded-proto': protocol,
  };
};

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
 * Validate a full Host header value (hostname or hostname:port / [ipv6]:port),
 * keeping a non-5555 forward port like 15555.
 */
const usableHostHeader = (raw) => {
  const host = String(raw || '').trim();
  return /^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?$/.test(host) ? host : null;
};

const ADMITTED = Object.freeze({ refusal: null, guest: false });
const refused = (status, reason, message) => ({ refusal: { status, reason, message }, guest: false });

/**
 * The one admission decision for every Eidoverse HTTP and WebSocket entry point
 * (:5555, its loopback mirror, the Tailcat ingress, and the :5563 bridge). The
 * sequencer joins by name with no token, so reaching it IS owner authority over
 * the world: PortOS must decide before any byte is proxied.
 *
 * The browser guard runs in both auth modes. With a password set, only an
 * operator/agent session or a live federated guest ticket is admitted; peer
 * credentials and Basic are never consulted. Fails closed on an unreadable
 * session store or peer registry.
 *
 * `guest: true` marks admission that must end with the guest's session.
 */
export const authorizeEidoverseProxyRequest = async (req) => {
  const browserRefusal = browserRequestRefusal(req);
  if (browserRefusal) {
    logSecurityEvent('eidoverse.refused', {
      refused: true,
      code: browserRefusal,
      ip: req.socket?.remoteAddress,
      method: req.method,
      path: requestPathname(req.url),
      origin: req.headers?.origin,
      host: req.headers?.host,
    });
    return refused(403, 'Forbidden', 'Cross-origin or untrusted-host browser request rejected.');
  }
  try {
    // Deferred so suites that only reach the proxy don't load the settings store.
    const { isAuthEnabled, verifyRequestSession } = await import('./auth.js');
    const guestTicket = parseCookie(req.headers?.cookie, EIDOVERSE_GUEST_COOKIE_NAME);
    const authEnabled = await isAuthEnabled();
    if ((!authEnabled && !guestTicket) || await verifyRequestSession(req)) return ADMITTED;
    // Deferred: travel reaches this module again through the host bridge, and
    // only a request that presents a guest ticket needs its session table.
    if (guestTicket) {
      const { getEidoverseGuestSession } = await import('./eidoverseTravel.js');
      const session = await getEidoverseGuestSession(req);
      if (session?.identity) return { refusal: null, guest: true, guestIdentity: session.identity };
    }
  } catch (error) {
    console.error(`❌ Eidoverse admission check failed: ${error.message}`);
    return refused(503, 'Service Unavailable', 'Eidoverse admission could not be verified.');
  }
  return refused(401, 'Unauthorized', 'Authentication required.');
};

/**
 * Answer a refused HTTP request. Returns true when the caller must stop: either
 * the refusal was written, or the client left while admission was pending.
 */
const stopRefusedHttp = (res, { refusal }) => {
  if (res.destroyed) return true;
  if (!refusal) return false;
  writePlainText(res, refusal.status, refusal.message, { 'cache-control': 'no-store', connection: 'close' });
  return true;
};

// Some sequencer control routes also accept GET (notably logout). Match the
// upstream URL parser, including dot segments, before forwarding a guest read.
const guestControlPaths = new Set(['/upload', '/auth', '/logout', '/seat-profile', '/perflog']);
const guestReadAllowed = ({ req, pathOverride }) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = pathOverride ?? req.url;
  const url = URL.parse(path, 'http://sequencer.invalid');
  return url?.origin === 'http://sequencer.invalid' && !guestControlPaths.has(requestPathname(url.pathname));
};

/** Gate + terminate/proxy one HTTP request (see handleEidoverseHttp for options). */
export const handleGatedEidoverseHttp = async (options) => {
  const admission = await authorizeEidoverseProxyRequest(options.req);
  if (stopRefusedHttp(options.res, admission)) return;
  if (admission.guest && !guestReadAllowed(options)) {
    writePlainText(options.res, 403, 'Visitor access is read-only.', { 'cache-control': 'no-store' });
    return;
  }
  handleEidoverseHttp(options);
};

// Live upgraded client sockets. An upgrade is admitted once, so a revoked
// credential must also end the connections it already opened.
const upgradedSockets = new Set();

/** Drop every proxied WebSocket; a still-authorized renderer reconnects. */
export const closeEidoverseProxySockets = () => {
  for (const socket of upgradedSockets) socket.destroy();
};

/** Gate + proxy one WebSocket upgrade (see proxyUpgradeToEidoverse for options). */
export const handleGatedEidoverseUpgrade = async (options) => {
  const { req, clientSocket } = options;
  // Before the first await: Node has detached its own listeners, so a reset
  // during admission would otherwise be an uncaught 'error'.
  markUpgradeClaimed(clientSocket);
  clientSocket.on('error', () => clientSocket.destroy());
  const { refusal, guest, guestIdentity } = await authorizeEidoverseProxyRequest(req);
  if (clientSocket.destroyed) return;
  if (refusal) {
    const { status, reason, message } = refusal;
    clientSocket.end(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`,
      () => clientSocket.destroy(),
    );
    return;
  }
  upgradedSockets.add(clientSocket);
  clientSocket.once('close', () => upgradedSockets.delete(clientSocket));
  if (guest) {
    const { bindEidoverseGuestSocket } = await import('./eidoverseTravel.js');
    // The ticket can lapse between admission and here.
    if (!bindEidoverseGuestSocket(req, clientSocket)) {
      clientSocket.destroy();
      return;
    }
    proxyGuestWebSocket(options, guestIdentity);
    return;
  }
  proxyUpgradeToEidoverse(options);
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
    const lower = name.toLowerCase();
    if (FORWARDED_HEADER_NAMES.has(lower) || STRIPPED_UPSTREAM_HEADERS.has(lower)) continue;
    if (lower === 'cookie') {
      const cookie = stripPortosCookies(req.rawHeaders[index + 1]);
      if (cookie) headers.push(`${name}: ${cookie}`);
      continue;
    }
    headers.push(`${name}: ${req.rawHeaders[index + 1]}`);
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
    if (stripped === null && !isEidoverseRootProxyPath(String(req.path || requestPathname(req.url)))) return next();

    return handleGatedEidoverseHttp({
      req,
      res,
      protocol: getProtocol(req),
      embedMode: 'same-origin',
      targetHost,
      targetPort,
      pathOverride: stripped ?? req.url,
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
    handleGatedEidoverseUpgrade({
      req,
      clientSocket,
      head,
      targetHost,
      targetPort,
      protocol,
      pathOverride,
    }).catch((error) => {
      console.error(`❌ Eidoverse upgrade failed: ${error.message}`);
      clientSocket.destroy();
    });
  });
}
