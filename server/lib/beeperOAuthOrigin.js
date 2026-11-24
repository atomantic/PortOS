/**
 * Which origin the Beeper OAuth `redirect_uri` may be built from (fork issue #1).
 *
 * Under the Vite dev proxy (`changeOrigin: true`, no `x-forwarded-*`) the server
 * sees its OWN origin, not the UI origin the browser is on, and Beeper would
 * redirect to a host the TLS certificate does not cover. So the browser sends its
 * origin. That is UNTRUSTED input — `redirect_uri` is where Beeper sends the
 * authorization code — so it is validated here:
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
 * Anything else is refused and the caller falls back to the request-derived origin.
 *
 * Pure: no I/O, no request object.
 */
import { isAllowedHost, isLoopbackHostname } from '../../lib/portosAuthCore.js';

// Re-exported so other Beeper-facing modules reuse this one loopback-spelling predicate.
export { isLoopbackHostname };

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

/**
 * The origin this request actually arrived on, from the socket scheme
 * (`req.secure`) and the `Host` header. `X-Forwarded-*` is deliberately ignored:
 * PortOS enables no `trust proxy` and sits behind no trusted reverse proxy, so
 * those headers are caller-controlled and would let a forged request poison the
 * OAuth `redirect_uri`. The host must also be one PortOS answers on
 * (`isAllowedHost`). Returns `null` when no valid origin can be derived.
 */
export function requestOriginFrom(req) {
  const host = req?.headers?.host;
  if (typeof host !== 'string' || !isAllowedHost(host)) return null;
  const candidate = `${req.secure ? 'https' : 'http'}://${host.trim().toLowerCase()}`;
  return parseBrowserOrigin(candidate)?.origin ?? null;
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

  // Refuse an https→http downgrade on a non-loopback host: it would hand the
  // authorization code back over plaintext. Loopback is exempt (Beeper Desktop and
  // the Vite dev proxy use plain http there and traffic never leaves the machine).
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
