/**
 * Which origin the Beeper OAuth `redirect_uri` may be built from (fork issue
 * #1, final live pass).
 *
 * The redirect URI used to be derived from `req.protocol` + `req.headers.host`
 * alone. Under the Vite dev proxy that is wrong in the one way that breaks the
 * flow: the proxy sets `changeOrigin: true` and forwards no `x-forwarded-*`, so
 * the server sees its OWN origin — the HTTPS API on the API port — rather than
 * the UI origin the browser is actually on. Beeper's consent screen then
 * redirects the browser to a host the TLS certificate does not cover (a
 * Tailscale cert covers `<machine>.<tailnet>.ts.net` and nothing else), so the
 * user lands on a certificate error even though the exchange completed.
 *
 * The browser knows its own origin, so it sends it. That makes it UNTRUSTED
 * input — whatever ends up in `redirect_uri` is where Beeper sends the
 * authorization code — so it is validated here rather than used as given:
 *
 *   - It has to be a bare `http(s)` origin: scheme, host, optional port, and
 *     nothing else. A value carrying a path, a query, credentials or a
 *     trailing slash is not an origin and is refused rather than trimmed.
 *   - Its HOST has to be one PortOS already answers on: a loopback spelling,
 *     the host this very request arrived on, or a host named by the install's
 *     configured UI/API origins (`PORTOS_UI_URL` / `PORTOS_API_URL`, both
 *     env-overridable in `ports.js`). The PORT is deliberately not pinned:
 *     the UI and the API are different ports of the same install, which is the
 *     whole case this exists for.
 *
 * Anything else is refused and the caller falls back to the request-derived
 * origin — the previous behaviour, so a rejected value never leaves the user
 * worse off than before.
 *
 * Pure: no I/O, no request object, nothing to mock.
 */

// `localhost`, `127.0.0.1` and `::1` are the same host wearing different
// spellings — a dual-stack box resolves them differently, and Beeper's own base
// URL defaults to `127.0.0.1` for exactly that reason.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Exported so other Beeper-facing modules that make the same "is this
// loopback" decision (the `settings.beeper.baseUrl` gate, #30/SEC-2; the OAuth
// token-endpoint host pin, SEC-3) reuse this one predicate rather than each
// keeping their own copy of the loopback-spelling list.
export const isLoopbackHostname = (hostname) => LOOPBACK_HOSTNAMES.has(String(hostname).toLowerCase())
  // 127.0.0.0/8 is all loopback, not just .0.1.
  || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(hostname));

/**
 * Parse a browser-supplied origin string. Returns the `URL`, or `null` when the
 * value is anything other than a bare `http(s)://host[:port]`.
 */
export function parseBrowserOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (!url.hostname) return null;
  // `URL.origin` normalizes away a path, a query, a fragment and credentials —
  // so demanding the input equal it is one check for all four.
  if (url.origin !== trimmed) return null;
  return url;
}

/** The hostname of an origin-ish string, lowercased, or `null`. */
export function hostnameOf(value) {
  const url = parseBrowserOrigin(value) || (() => {
    try {
      return new URL(String(value));
    } catch {
      return null;
    }
  })();
  return url?.hostname ? url.hostname.toLowerCase() : null;
}

/**
 * Decide which origin the redirect URI is built from.
 *
 * @param {object} options
 * @param {string} [options.clientOrigin] - `window.location.origin`, as sent by the browser.
 * @param {string} [options.requestOrigin] - The origin derived from the request headers (the fallback).
 * @param {string[]} [options.configuredOrigins] - Origins this install is configured to serve on.
 * @returns {{origin: string|null, source: 'client'|'request'|'none', rejectedClientOrigin: boolean}}
 */
export function resolveOAuthOrigin({ clientOrigin, requestOrigin, configuredOrigins = [] } = {}) {
  const parsed = parseBrowserOrigin(clientOrigin);
  if (!parsed) {
    return {
      origin: requestOrigin || null,
      source: requestOrigin ? 'request' : 'none',
      // Only a value that was actually SENT counts as rejected; an omitted one
      // is just an older client.
      rejectedClientOrigin: typeof clientOrigin === 'string' && clientOrigin.trim().length > 0,
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const loopback = isLoopbackHostname(hostname);

  // An https→http downgrade of the redirect origin: the request reached this
  // install over TLS, but the browser-supplied origin proposes handing the
  // authorization code back over plaintext HTTP on a non-loopback host — a
  // network attacker on that path could otherwise intercept the code. The
  // loopback branch is exempt: Beeper Desktop and the Vite dev proxy both
  // round-trip through plain `http://127.0.0.1`/`localhost` even when the API
  // itself terminates TLS, and loopback traffic never leaves the machine.
  const requestIsHttps = parseBrowserOrigin(requestOrigin)?.protocol === 'https:';
  if (!loopback && requestIsHttps && parsed.protocol === 'http:') {
    return {
      origin: requestOrigin || null,
      source: requestOrigin ? 'request' : 'none',
      rejectedClientOrigin: true,
    };
  }

  const allowedHostnames = new Set(
    [requestOrigin, ...configuredOrigins].map(hostnameOf).filter(Boolean),
  );
  if (loopback || allowedHostnames.has(hostname)) {
    return { origin: parsed.origin, source: 'client', rejectedClientOrigin: false };
  }
  return {
    origin: requestOrigin || null,
    source: requestOrigin ? 'request' : 'none',
    rejectedClientOrigin: true,
  };
}
