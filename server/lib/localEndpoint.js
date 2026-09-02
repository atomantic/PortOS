/**
 * Dependency-light local-endpoint predicates.
 *
 * Keep host/URL classification below provider and runtime catalogs. It must be
 * safe to use from static provider policy reads without importing backend
 * configuration, ports, or daemon managers.
 */

/**
 * True when a hostname names the same local machine as the PortOS process.
 * Loopback and bind-all addresses are local; LAN, Tailnet, and link-local
 * addresses intentionally remain external instances.
 */
export function isLocalInstanceHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function parseEndpoint(endpoint) {
  const cleaned = String(endpoint || '').replace(/\/v\d+\/?$/, '').replace(/\/+$/, '');
  try {
    return new URL(cleaned);
  } catch {
    return null;
  }
}

/** True when an HTTP(S) endpoint resolves to this machine's local instance. */
export function isLocalInstanceEndpoint(endpoint) {
  const url = parseEndpoint(endpoint);
  return url ? isLocalInstanceHost(url.hostname) : false;
}

/** Return a local endpoint's explicit or protocol-default port, else null. */
export function localEndpointPort(endpoint) {
  const url = parseEndpoint(endpoint);
  if (!url || !isLocalInstanceHost(url.hostname)) return null;
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}
