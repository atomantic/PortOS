/**
 * WHERE a provider's endpoint points: this machine (loopback), another host
 * inside the private network (LAN / tailnet / `.local` — a "fleet" provider), or
 * the public internet — and which local daemon (Ollama / LM Studio) a record
 * names, so callers can fold in live-installed models or decide whether a
 * missing API key is a real gap.
 *
 * `isPrivateNetworkEndpoint` is re-exported directly from
 * `server/lib/localEndpoint.js` — the authoritative implementation, not a
 * browser copy. Browser MIRROR of `localBackendForProvider` in
 * `server/lib/localProviderRuntime.js` and `isLocalInstanceEndpoint` in
 * `server/lib/localEndpoint.js` — keep those two in lockstep; the server
 * copies are authoritative and stricter (they gate actions), these only label UI.
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
 * A deliberately CHEAPER client labeler than `localBackendForProvider` in
 * server/lib/localProviderRuntime.js — not a mirror (#6818). The SERVER copy is
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

// THE private-network classification (RFC1918 LAN ranges, link-local, the
// Tailscale CGNAT range, `.local`/`.ts.net`/`.internal` names, single-label
// hosts) — imported directly from the server leaf instead of a browser copy,
// so the two documented edge cases (`http://127.1`, a bracketless IPv6
// literal) can't disagree between client and server again. (Imported, not
// re-exported directly, because isFleetProvider below reads it too.)
import { isPrivateNetworkEndpoint } from '../../../server/lib/localEndpoint.js';
export { isPrivateNetworkEndpoint };

/**
 * Does this provider talk to a daemon on THIS machine?
 *
 * Client mirror of `isLocalInstanceEndpoint` in
 * server/lib/localEndpoint.js, and the guard for anything that explains
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
