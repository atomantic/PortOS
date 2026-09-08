/**
 * WHERE a provider's endpoint points: this machine (loopback), another host
 * inside the private network (LAN / tailnet / `.local` — a "fleet" provider), or
 * the public internet — and which local daemon (Ollama / LM Studio) a record
 * names, so callers can fold in live-installed models or decide whether a
 * missing API key is a real gap.
 *
 * Browser MIRROR of `localBackendForProvider` / `isLocalInstanceEndpoint` in
 * `server/lib/localProviderRuntime.js` and `isPrivateNetworkEndpoint` in
 * `server/lib/providerPrerequisites.js` — keep in lockstep. The server copies
 * are authoritative and stricter (they gate actions); these only label UI.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

/**
 * Classify a provider as a local-LLM backend by its id/endpoint/name, so callers
 * can fold in live-installed models (Ollama/LM Studio) that aren't in the
 * provider's stored `models` list. Ollama's native + OpenAI-compat ports are
 * 11434; LM Studio defaults to 1234. The stable provider ids (`ollama` /
 * `lmstudio`) are checked too — AI Assignments' curated provider payload
 * omits `endpoint`, and a renamed display name would otherwise miss detection.
 *
 * Client mirror of `localBackendForProvider` in
 * server/lib/localProviderRuntime.js — keep in lockstep. The SERVER copy is
 * authoritative and stricter: it parses the endpoint as a URL and requires a
 * loopback/bind-all host, so a peer machine's daemon on the same port is not
 * claimed as local. This one only labels UI, so it stays a cheap regex; if it
 * ever gates an action, take the server's rules with it.
 *
 * The pr-reviewer stage pickers (`PipelineStageConfig.jsx`) are downstream of
 * this, the sandboxed actions stage included — but they only choose which model
 * list to SHOW. The pin a stage saves is re-validated at spawn time by
 * `modelPinIsOffered` (server/lib/localProviderRuntime.js), so a
 * misclassification here degrades to a confusing dropdown, never to a model the
 * provider was not allowed to run.
 *
 * @param {{id?:string,endpoint?:string,name?:string}} provider
 * @returns {'ollama'|'lmstudio'|null}
 */
export const localBackendForProvider = (provider) => {
  if (!provider) return null;
  const id = String(provider.id || '').toLowerCase();
  const endpoint = String(provider.endpoint || '');
  const name = String(provider.name || '').toLowerCase();
  if (id === 'ollama' || /:11434\b/.test(endpoint) || name.includes('ollama')) return 'ollama';
  if (
    id === 'lmstudio' ||
    /:1234\b/.test(endpoint) ||
    name.includes('lm studio') ||
    name.includes('lmstudio') ||
    /lm[\s-]?studio/i.test(name)
  ) return 'lmstudio';
  return null;
};

// The whole loopback block (`127.0.0.0/8`), not just `127.0.0.1` — a daemon on a
// loopback alias (`127.0.0.2`) is as local as one on `.1`, and the server's
// `isLocalInstanceHost` already accepts the full block. While they disagreed, a
// provider on `http://127.0.0.2:11434` was badged NEEDS SETUP for an API key a
// loopback endpoint never needs.
const LOCAL_ENDPOINT_RE = /^(https?:\/\/)?(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[?::1\]?|\[?::\]?)(:|\/|$)/i;

export const isLocalEndpoint = (endpoint) =>
  typeof endpoint === 'string' && LOCAL_ENDPOINT_RE.test(endpoint.trim());

// Hosts inside the trust boundary, where an unauthenticated OpenAI-compatible
// server is a normal setup rather than a misconfiguration: RFC1918 LAN ranges,
// link-local, and the Tailscale CGNAT range 100.64.0.0/10 (PortOS is a
// tailnet-first product — an API provider pointed at another machine's Ollama
// is a first-class configuration, not an edge case).
const PRIVATE_IP_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * IPv6 counterpart to {@link PRIVATE_IP_RE}: unique-local (`fc00::/7`) and
 * link-local (`fe80::/10`). Tailscale hands out a ULA address alongside the
 * CGNAT v4 one, so without this a tailnet peer reached over IPv6 read as a
 * public host and its keyless provider was blocked on a missing API key.
 *
 * Gated on the host being an IPv6 literal (it contains a `:`) and compared
 * NUMERICALLY on the leading hextet — a bare `/^f[cd]/` prefix test would also
 * claim hostnames like `fdrive.example.com`, and `fd::1` expands to a leading
 * hextet of `0x00fd`, which is not in `fc00::/7` at all.
 */
/**
 * Gate for {@link PRIVATE_IP_RE}: is this host an IPv4 literal at all?
 *
 * The range test above matches a PREFIX, which on its own also claims DNS names
 * that merely start like one — `10.evil.example` — and would report a keyless
 * PUBLIC endpoint as needing no key. Hosts arriving there have already been
 * through `URL`, which canonicalizes any IPv4 spelling to a dotted quad.
 * Mirror of the server helper in server/lib/providerPrerequisites.js.
 */
const isIpv4Literal = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

const isPrivateIpv6 = (host) => {
  if (!host.includes(':')) return false;
  const first = host.split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false; // '' for `::1` — loopback, already matched above
  const n = parseInt(first, 16);
  return (n >= 0xfc00 && n <= 0xfdff) || (n >= 0xfe80 && n <= 0xfebf);
};

/**
 * Is this endpoint inside the private network — loopback, a LAN/tailnet address,
 * a `.local`/`.ts.net`/`.internal` name, or a bare single-label host?
 *
 * Used to decide whether a missing API key is actually a missing prerequisite.
 * The server only attaches an `Authorization` header when a key is stored, so a
 * keyless call to a private OpenAI-compatible server (LM Studio on the desk
 * machine, Ollama on a tailnet peer) works exactly as configured — reporting it
 * as "needs setup" would be a false alarm on a supported deployment. A public
 * endpoint with no key stays flagged: that one really is misconfigured.
 *
 * A host that cannot be parsed reads as NOT private, keeping the stricter of
 * the two answers for input we don't understand.
 */
export const isPrivateNetworkEndpoint = (endpoint) => {
  if (isLocalEndpoint(endpoint)) return true;
  if (typeof endpoint !== 'string' || !endpoint.trim()) return false;
  const trimmed = endpoint.trim();
  // A scheme-less endpoint ("192.168.1.5:1234/v1") is still a host — give the
  // parser one so it doesn't read the leading segment as a scheme.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!URL.canParse(candidate)) return false;
  const host = new URL(candidate).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIpv4Literal(host) && PRIVATE_IP_RE.test(host)) return true;
  if (isPrivateIpv6(host)) return true;
  if (/\.(local|internal|lan|home\.arpa|ts\.net)$/.test(host)) return true;
  // A single-label host resolves only inside the local network (`http://nas:11434`).
  return !host.includes('.') && !host.includes(':');
};

/**
 * Does this provider talk to a daemon on THIS machine?
 *
 * Client mirror of `isLocalInstanceEndpoint` in
 * server/lib/localProviderRuntime.js, and the guard for anything that explains
 * a provider by inspecting the machine PortOS runs on — "is `lms` installed
 * here?", "start it from Models → LLMs". A provider named for LM Studio
 * but pointed at another box on the tailnet matches
 * {@link localBackendForProvider} by NAME, so without this it collected this
 * machine's install state and offered to start a server it does not own.
 *
 * A blank endpoint reads as local, unlike the server's copy: the record simply
 * hasn't named one, and every default it can fall back to is a loopback URL.
 *
 * @param {{endpoint?:string}} provider
 * @returns {boolean}
 */
export const isLocalInstanceProvider = (provider) => {
  const endpoint = provider?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return true;
  return isLocalEndpoint(endpoint);
};

/**
 * Does this provider run on another machine inside the private network?
 *
 * This is presentation identity, not a trust escalation: prerequisite and key
 * rules still come from {@link isPrivateNetworkEndpoint}. Public hosted APIs
 * stay ordinary remote providers; loopback daemons stay local.
 */
export const isFleetProvider = (provider) =>
  !isLocalInstanceProvider(provider) && isPrivateNetworkEndpoint(provider?.endpoint);

/**
 * Has this fleet host already been configured as a provider on this instance?
 *
 * @param {{endpoint?: string, peerHost?: string, peerAddress?: string}|null|undefined} host
 * @param {Array<object>} providers
 * @returns {boolean}
 */
export const isFleetHostConfigured = (host, providers = []) => {
  if (!host || !Array.isArray(providers)) return false;
  const hostEndpoint = typeof host.endpoint === 'string' ? host.endpoint.toLowerCase().replace(/\/+$/, '') : '';
  const hostHostname = (host.peerHost || (host.endpoint && URL.canParse(host.endpoint) ? new URL(host.endpoint).hostname : ''))?.toLowerCase();
  const hostAddress = (host.peerAddress || '')?.toLowerCase();

  return providers.some((p) => {
    // 1. Direct endpoint string equality
    const pEndpoint = typeof p?.endpoint === 'string' ? p.endpoint.toLowerCase().replace(/\/+$/, '') : '';
    if (hostEndpoint && pEndpoint === hostEndpoint) return true;

    // 2. Parsed hostname/IP match
    if (pEndpoint && URL.canParse(pEndpoint)) {
      const pUrl = new URL(pEndpoint);
      const pHost = pUrl.hostname.toLowerCase();
      if ((hostHostname && pHost === hostHostname) || (hostAddress && pHost === hostAddress)) {
        return true;
      }
    }

    // 3. OpenCode TUI provider configuration check
    if (p?.envVars?.OPENCODE_CONFIG_CONTENT) {
      try {
        const config = typeof p.envVars.OPENCODE_CONFIG_CONTENT === 'string'
          ? JSON.parse(p.envVars.OPENCODE_CONFIG_CONTENT)
          : p.envVars.OPENCODE_CONFIG_CONTENT;
        const vllmBaseUrl = config?.provider?.vllm?.options?.baseURL;
        if (typeof vllmBaseUrl === 'string') {
          const normBase = vllmBaseUrl.toLowerCase().replace(/\/+$/, '');
          if (hostEndpoint && normBase === hostEndpoint) return true;
          if (URL.canParse(normBase)) {
            const bHost = new URL(normBase).hostname.toLowerCase();
            if ((hostHostname && bHost === hostHostname) || (hostAddress && bHost === hostAddress)) {
              return true;
            }
          }
        }
      } catch {
        // ignore parse error
      }
    }

    return false;
  });
};
