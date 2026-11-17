/**
 * WHERE a provider's endpoint points: this machine (loopback), another host in the private network (LAN / tailnet / `.local`, a "fleet" provider), or the public internet.
 *
 * `isPrivateNetworkEndpoint` is re-exported from `server/lib/localEndpoint.js` (authoritative, not a browser copy). The rest is a browser MIRROR of `localBackendForProvider` in
 * `server/lib/localProviderRuntime.js` and `isLocalInstanceEndpoint` in `server/lib/localEndpoint.js`; the server copies are stricter (they gate actions), these only label UI.
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

/**
 * Classify a provider as a local-LLM backend by id/endpoint/name so callers can fold in live-installed models (Ollama/LM Studio) missing from its stored `models`.
 * Ollama's ports are 11434; LM Studio defaults to 1234. Stable ids (`ollama` / `lmstudio`) are checked too: AI Assignments' curated payload omits `endpoint`.
 *
 * A deliberately CHEAPER client labeler than `localBackendForProvider` in server/lib/localProviderRuntime.js, not a mirror (#6818): the server copy parses the
 * endpoint as a URL and requires a loopback/bind-all host. This one only labels UI; if it ever gates an action, take the server's rules with it.
 * The pr-reviewer stage pickers (`PipelineStageConfig.jsx`) only choose which model list to SHOW; the saved pin is re-validated at spawn by `modelPinIsOffered`,
 * so a misclassification degrades to a confusing dropdown, never to a model the provider may not run.
 * @param {{id?:string,endpoint?:string,name?:string}} provider
 * @returns {'ollama'|'lmstudio'|null}
  * Matches by NAME as well, so pair it with isLocalInstanceProvider before claiming this machine's install state.
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

// One shared predicate (full `127.0.0.0/8`, `::`, `0.0.0.0`) so client and server
// cannot disagree on a loopback alias like `http://127.0.0.2:11434`.
export const isLocalEndpoint = isLoopbackEndpoint;

// THE private-network classification (RFC1918, link-local, Tailscale CGNAT, `.local`/`.ts.net`/`.internal`, single-label hosts), imported from the server leaf rather than a
// browser copy so edge cases (`http://127.1`, bracketless IPv6) can't disagree. Imported, not re-exported directly, because isFleetProvider reads it too.
import { isLoopbackEndpoint, isPrivateNetworkEndpoint } from '../../../server/lib/localEndpoint.js';
export { isPrivateNetworkEndpoint };

/**
 * Does this provider talk to a daemon on THIS machine? Client mirror of `isLocalInstanceEndpoint` in server/lib/localEndpoint.js, and the guard for anything that explains
 * a provider by inspecting this machine ("is `lms` installed here?"): a provider named for LM Studio but pointed at another tailnet box matches
 * {@link localBackendForProvider} by NAME and would otherwise offer to start a server it does not own.
 *
 * A blank endpoint reads as local, unlike the server's copy: every default it can fall back to is a loopback URL.
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
    const pEndpoint = typeof p?.endpoint === 'string' ? p.endpoint.toLowerCase().replace(/\/+$/, '') : '';
    if (hostEndpoint && pEndpoint === hostEndpoint) return true;

    if (pEndpoint && URL.canParse(pEndpoint)) {
      const pUrl = new URL(pEndpoint);
      const pHost = pUrl.hostname.toLowerCase();
      if ((hostHostname && pHost === hostHostname) || (hostAddress && pHost === hostAddress)) {
        return true;
      }
    }

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
      }
    }

    return false;
  });
};
