/**
 * Live-install browser audit policy (#13101). The synthetic fixture audit
 * (collectionTraffic.js) proves traffic shape against a disposable origin; this
 * module scopes a delegated session to exactly one loopback PortOS origin and
 * labels every URL by a source-declared pattern, so no record identifier,
 * query, host, header or credential can reach a report.
 */
import { getApiRouteCatalog } from '../../server/lib/apiRouteGraph.js';
import { sessionCookieNameFor } from '../../lib/portosAuthCore.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PAGE_PATH = /^(?:\/[a-z0-9][a-z0-9-]*)+$/;
const API_PATH = /^\/api(?:\/[a-z0-9][a-z0-9-]*)+$/;

/** Large-collection routes and the list endpoint whose completion marks useful content. */
export const COLLECTION_ROUTES = Object.freeze({
  '/media/history': '/api/image-gen/gallery',
  '/messages/inbox': '/api/messages/inbox',
});

/** Fixed operator guidance per UNVERIFIED reason; never interpolates environment values. */
export const NEXT_STEPS = Object.freeze({
  'invalid-origin': 'Set PORTOS_URL to this machine\'s loopback HTTP origin (for example http://127.0.0.1:5553), then rerun.',
  'non-loopback-origin': 'Live audits target only this machine\'s loopback HTTP origin; set PORTOS_URL to it (the :5553 mirror when HTTPS is on), then rerun.',
  'origin-unreachable': 'Start PortOS or point PORTOS_URL at its loopback HTTP origin (the :5553 mirror when HTTPS is on), then rerun.',
  'whoami-unreadable': 'The origin did not answer /api/auth/whoami as PortOS; check PORTOS_URL names this install, then rerun.',
  'credential-missing': 'Run from a PortOS-spawned agent (PORTOS_API_TOKEN) or enable Settings > Security > Agent API key, then rerun.',
  'credential-rejected': 'The delegated session was rejected (expired or revoked); respawn the agent or re-enable the Agent API key, then rerun.',
  'browser-unavailable': 'Install Google Chrome or set LIVE_AUDIT_BROWSER to a Chromium executable, then rerun.',
  'login-redirect': 'The audit browser was sent to /login, so the delegated session cookie was not accepted; verify the credential with `node scripts/portos-api.js whoami`, then rerun.',
});

export const refusal = reason => Object.assign(new Error(reason), { reason });

/** The exact origin a live audit may contact: plain-HTTP loopback with no path or userinfo. */
export function resolveLiveOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { throw refusal('invalid-origin'); }
  if (url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) throw refusal('invalid-origin');
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) throw refusal('non-loopback-origin');
  return url.origin;
}

/** Exact scheme/host/port equality, treating ws: as http: (the Socket.IO upgrade). */
export function sameOrigin(raw, origin) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  const scheme = { 'ws:': 'http:', 'wss:': 'https:' }[url.protocol] || url.protocol;
  return `${scheme}//${url.host}` === origin;
}

/**
 * 'allow' only for same-origin safe reads (and Socket.IO polling writes, the
 * transport itself). Anything else is refused before it leaves the browser:
 * a foreign origin could receive the cookie or observe the audit, and a
 * mutation could start a provider, sync, send or host action.
 */
export function classifyBrowserRequest({ url, method, origin }) {
  if (!sameOrigin(url, origin)) return 'foreign-origin';
  if (SAFE_METHODS.has(String(method).toUpperCase())) return 'allow';
  return new URL(url).pathname.startsWith('/socket.io/') ? 'allow' : 'mutation';
}

const compileRoute = path => new RegExp('^' + path.split('/').map(segment =>
  segment.startsWith(':') ? '[^/]+' : segment.startsWith('*') ? '.+'
    : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '/?$');

/**
 * URL -> report label. API paths become the matching source route pattern
 * (`/api/messages/:accountId/:messageId`), so a label only ever contains
 * literals declared in server/routes; unmatched API paths keep only their
 * mount. Pages keep only the operator-chosen static paths. Hosts, queries and
 * every other segment value are dropped.
 */
export function createEndpointRedactor({ origin, pages = [], catalog = getApiRouteCatalog() }) {
  const routes = catalog.routes.map(({ method, path }) => ({
    method, path, re: compileRoute(path),
    statics: path.split('/').filter(segment => segment && !/^[:*]/.test(segment)).length,
  }));
  const mounts = [...new Set(catalog.mounts)].sort((a, b) => b.length - a.length);
  const knownPages = new Set(['/', ...pages]);
  return (raw, method = 'GET') => {
    let url;
    try { url = new URL(raw); } catch { return '/invalid-url'; }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '/non-http';
    if (!sameOrigin(raw, origin)) return ':foreign-origin';
    const path = url.pathname;
    if (path === '/socket.io' || path.startsWith('/socket.io/')) return '/socket.io/';
    if (path.startsWith('/assets/')) return '/assets/:asset';
    if (path.startsWith('/data/')) return '/data/:asset';
    if (/^\/(?:api|sdapi)(?:\/|$)/.test(path)) {
      const verb = String(method).toUpperCase() === 'HEAD' ? 'GET' : String(method).toUpperCase();
      let best = null;
      for (const route of routes) {
        if (!route.re.test(path)) continue;
        const rank = [route.method === verb ? 1 : 0, route.statics];
        if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { route, rank };
      }
      if (best) return best.route.path;
      const mount = mounts.find(prefix => path === prefix || path.startsWith(prefix + '/'));
      return (mount || (path.startsWith('/sdapi') ? '/sdapi' : '/api')) + '/:unmatched';
    }
    if (knownPages.has(path)) return path;
    return /^\/[^/]+\.[a-z0-9]+$/i.test(path) ? '/:static' : '/:page';
  };
}

/**
 * Install the transport on a fresh, disposable browser context. The guard is
 * registered before the credential exists in the context. The session cookie is
 * host-only and HttpOnly; cookies are not port-scoped, so the guard (not the
 * cookie jar) is what keeps it from another loopback port: every request and
 * WebSocket to a different origin is aborted before it is sent.
 */
export async function installLiveTransport(context, { origin, token, onBlocked }) {
  await context.route(() => true, async route => {
    const request = route.request();
    const decision = classifyBrowserRequest({ url: request.url(), method: request.method(), origin });
    if (decision === 'allow') return route.continue();
    onBlocked(decision, request.url(), request.method());
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket(url => !sameOrigin(url.href, origin), ws => {
    onBlocked('foreign-origin', ws.url(), 'GET');
    return ws.close({ code: 1008, reason: 'live audit origin guard' });
  });
  if (token) {
    await context.addCookies([{ name: sessionCookieNameFor(new URL(origin).host), value: token,
      url: origin, httpOnly: true, sameSite: 'Strict' }]);
  }
}

/**
 * Confirm the credential against the exact origin before any browser starts.
 * `request` is portos-api's requestApi: no redirect following, so the bearer
 * cannot be forwarded to another location.
 */
export async function preflightLiveTransport({ origin, token, request }) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await request(`${origin}/api/auth/whoami`, { method: 'GET', headers, body: null, timeoutMs: 10000 });
  } catch { return { ok: false, reason: 'origin-unreachable' }; }
  let body = null;
  try { body = JSON.parse(response.text); } catch { /* handled below */ }
  if (response.status !== 200 || typeof body?.required !== 'boolean') return { ok: false, reason: 'whoami-unreadable' };
  if (!body.required) return { ok: true, mode: 'password-free' };
  if (body.authenticated === true && token) return { ok: true, mode: 'delegated-session' };
  return { ok: false, reason: token ? 'credential-rejected' : 'credential-missing' };
}

/** Findings from aggregate live traffic; inputs and outputs carry only patterns and counts. */
export function liveFindings({ phases, inFlight, blocked, collectionEndpoint }) {
  const findings = [];
  const blockedAt = new Map(blocked.map(({ phase, endpoint, count }) => [phase + '\0' + endpoint, count]));
  for (const [phase, endpoints] of Object.entries(phases)) {
    for (const [endpoint, row] of Object.entries(endpoints)) {
      if (row.httpErrors) findings.push({ phase, endpoint, reason: 'http-error', count: row.httpErrors });
      const failed = row.failed - row.canceled - (blockedAt.get(phase + '\0' + endpoint) || 0);
      if (failed > 0) findings.push({ phase, endpoint, reason: 'request-failed', count: failed });
      if (row.overlapping) findings.push({ phase, endpoint, reason: 'overlapping-duplicate-request', count: row.overlapping });
      if (phase !== 'cold' && endpoint === collectionEndpoint && row.requests) {
        findings.push({ phase, endpoint, reason: 'sibling-collection-refetch', count: row.requests });
      }
    }
  }
  for (const { phase, endpoint, reason, count } of blocked) findings.push({ phase, endpoint, reason: 'blocked-' + reason, count });
  // An open engine.io long-poll is the transport waiting by design; it stays in
  // the report's inFlight rows but is not a defect.
  for (const [endpoint, count] of Object.entries(inFlight)) {
    if (endpoint !== '/socket.io/') findings.push({ phase: 'end', endpoint, reason: 'in-flight-at-end', count });
  }
  return findings;
}

/** Per-phase sums so a reader need not add endpoint rows. */
export function phaseTotals(phases) {
  return Object.fromEntries(Object.entries(phases).map(([phase, endpoints]) => [phase,
    Object.values(endpoints).reduce((sum, row) => {
      for (const [key, value] of Object.entries(row)) sum[key] = (sum[key] || 0) + value;
      return sum;
    }, {})]));
}

/** CLI: [output] [--route=/path] [--sibling=/path] [--collection-endpoint=/api/...] [--idle-ms=N]. */
export function parseLiveAuditArgs(argv) {
  const out = { output: undefined, route: '/media/history', sibling: '/media/collections', collectionEndpoint: null, idleMs: 60000 };
  for (const arg of argv) {
    const [flag, ...rest] = arg.split('=');
    const value = rest.join('=');
    if (flag === '--route' || flag === '--sibling') {
      if (!PAGE_PATH.test(value)) throw new Error(flag + ' must be a static lowercase path such as /media/history');
      out[flag.slice(2)] = value;
    } else if (flag === '--collection-endpoint') {
      if (!API_PATH.test(value)) throw new Error('--collection-endpoint must be a static /api path');
      out.collectionEndpoint = value;
    } else if (flag === '--idle-ms') {
      out.idleMs = Number(value);
      if (!Number.isInteger(out.idleMs) || out.idleMs < 60000 || out.idleMs > 600000) throw new Error('--idle-ms must be 60000-600000');
    } else if (!arg.startsWith('--') && out.output === undefined) out.output = arg;
    else throw new Error('Unknown argument: ' + flag);
  }
  out.collectionEndpoint ??= COLLECTION_ROUTES[out.route] ?? null;
  if (!out.collectionEndpoint) throw new Error('--collection-endpoint is required for a route without a registered collection');
  if (out.sibling === out.route) throw new Error('--sibling must differ from --route');
  return out;
}
