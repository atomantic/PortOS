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

/**
 * Hosts inside the trust boundary, where an unauthenticated OpenAI-compatible
 * server is a normal setup rather than a misconfiguration: RFC1918 LAN ranges,
 * link-local, and the Tailscale CGNAT range 100.64.0.0/10 (PortOS is a
 * tailnet-first product — an API provider pointed at another machine's Ollama
 * is a first-class configuration, not an edge case).
 */
const PRIVATE_IP_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * Gate for {@link PRIVATE_IP_RE}: is this host an IPv4 literal at all?
 *
 * The range test above matches a PREFIX, which on its own also claims DNS names
 * that merely start like one — `10.evil.example`, `172.16.evil.example` — and
 * would report a keyless PUBLIC endpoint as needing no key. Hosts arriving here
 * have already been through `URL`, which canonicalizes any IPv4 spelling to a
 * dotted quad, so this is the exact shape a real address takes.
 */
const isIpv4Literal = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

/**
 * IPv6 counterpart to {@link PRIVATE_IP_RE}: unique-local (`fc00::/7`) and
 * link-local (`fe80::/10`). Tailscale hands out a ULA address alongside the
 * CGNAT v4 one, so without this a tailnet peer reached over IPv6 reads as a
 * public host and its keyless provider is blocked on a missing API key.
 *
 * Gated on the host being an IPv6 literal (it contains a `:`) and compared
 * NUMERICALLY on the leading hextet — a bare `/^f[cd]/` prefix test would also
 * claim hostnames like `fdrive.example.com`, and `fd::1` expands to a leading
 * hextet of `0x00fd`, which is not in `fc00::/7` at all.
 */
const isPrivateIpv6 = (host) => {
  if (!host.includes(':')) return false;
  const first = host.split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false; // '' for `::1` — loopback, matched by isLocalInstanceHost
  const n = parseInt(first, 16);
  return (n >= 0xfc00 && n <= 0xfdff) || (n >= 0xfe80 && n <= 0xfebf);
};

/** The hostname of an endpoint (scheme optional), lowercased and de-bracketed; `null` when unparseable. */
const endpointHost = (endpoint) => {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return null;
  const trimmed = endpoint.trim();
  // A scheme-less endpoint ("192.0.2.10:1234/v1") is still a host — give the
  // parser one so it doesn't read the leading segment as a scheme.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!URL.canParse(candidate)) return null;
  return new URL(candidate).hostname.toLowerCase().replace(/^\[|\]$/g, '');
};

/**
 * Is this endpoint inside the private network — loopback, a LAN/tailnet
 * address, a `.local`/`.ts.net`/`.internal` name, or a bare single-label host?
 *
 * Decides whether a missing API key is actually a missing prerequisite. The
 * server attaches an `Authorization` header only when a key is stored, so a
 * keyless call to a private OpenAI-compatible server (LM Studio on the desk
 * machine, Ollama on a tailnet peer) works exactly as configured — treating it
 * as un-runnable would take a supported deployment out of the fallback chain.
 * A public endpoint with no key stays flagged: that one really is misconfigured.
 *
 * THE implementation — `server/lib/providerPrerequisites.js` imports this
 * rather than keeping its own copy, and `client/src/utils/providerEndpoints.js`
 * re-exports it directly rather than carrying a browser mirror. Two edge cases
 * that used to divide a cheap client regex from this URL-based parse (both
 * settled now that there is only one answer):
 *   - `http://127.1` — `URL` expands the compact form to `127.0.0.1`, so this
 *     calls it private. Node's own fetch expands it the same way.
 *   - `http://::1:11434` — an IPv6 literal without brackets, which `URL`
 *     rejects, so this reads it as NOT private; nothing can connect to that
 *     endpoint anyway. A host that cannot be parsed reads as NOT private,
 *     keeping the stricter answer for input we don't understand.
 */
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
