/**
 * Dependency-light local-endpoint URL predicates shared by provider safety policy and runtime classification.
 *
 * Must stay below provider/runtime catalogs and not import backend configuration, ports, or daemon managers.
 */

// Loopback and bind-all are local; LAN, Tailnet and link-local addresses intentionally stay external.
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

export function isLocalInstanceEndpoint(endpoint) {
  const url = parseEndpoint(endpoint);
  return url ? isLocalInstanceHost(url.hostname) : false;
}

export function localEndpointPort(endpoint) {
  const url = parseEndpoint(endpoint);
  if (!url || !isLocalInstanceHost(url.hostname)) return null;
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

// Hosts inside the trust boundary where an unauthenticated OpenAI-compatible server is normal: RFC1918, link-local, Tailscale CGNAT 100.64.0.0/10.
const PRIVATE_IP_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

// Gate for PRIVATE_IP_RE, which matches a prefix and would otherwise claim DNS names like `10.evil.example`. URL canonicalizes IPv4 to a dotted quad.
const isIpv4Literal = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

// IPv6 counterpart: unique-local fc00::/7 and link-local fe80::/10 (Tailscale hands out a ULA). Compared numerically on the leading hextet;
// a prefix test would claim `fdrive.example.com`.
const isPrivateIpv6 = (host) => {
  if (!host.includes(':')) return false;
  const first = host.split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false; // '' for `::1` — loopback, matched by isLocalInstanceHost
  const n = parseInt(first, 16);
  return (n >= 0xfc00 && n <= 0xfdff) || (n >= 0xfe80 && n <= 0xfebf);
};

const endpointHost = (endpoint) => {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return null;
  const trimmed = endpoint.trim();
  // A scheme-less endpoint is still a host; give the parser a scheme.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!URL.canParse(candidate)) return null;
  return new URL(candidate).hostname.toLowerCase().replace(/^\[|\]$/g, '');
};

// The single "talks to a local daemon" answer; do not re-implement it as a regex.
export const isLoopbackEndpoint = (endpoint) => {
  const host = endpointHost(endpoint);
  return host !== null && isLocalInstanceHost(host);
};

// Private network: loopback, LAN/tailnet address, `.local`/`.ts.net`/`.internal` name, or a bare single-label host. Decides whether a missing API key is a
// real prerequisite: keyless calls to private servers work as configured, public ones do not. Also re-exported by the client. Unparseable hosts read as NOT private.
export const isPrivateNetworkEndpoint = (endpoint) => {
  const host = endpointHost(endpoint);
  if (host === null) return false;
  if (isLocalInstanceHost(host)) return true;
  if (isIpv4Literal(host) && PRIVATE_IP_RE.test(host)) return true;
  if (isPrivateIpv6(host)) return true;
  if (/\.(local|internal|lan|home\.arpa|ts\.net)$/.test(host)) return true;
  // A single-label host resolves only inside the local network (`http://nas:11434`).
  return !host.includes('.') && !host.includes(':');
};
