// Federation HTTP/Socket.IO client — TLS validation off (Tailnet is the trust boundary).
import https from 'node:https';
import { insecureFetch } from './httpClient.js';

const peerHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpsFetch = insecureFetch(peerHttpsAgent);

export const peerSocketOptions = {
  rejectUnauthorized: false,
  transports: ['websocket', 'polling']
};

/**
 * Build an HTTP Basic `Authorization` header from a peer's stored credential.
 *
 * Some installs sit behind a reverse proxy (Tailscale `serve`, Caddy, nginx)
 * that gates PortOS with HTTP Basic auth — so a peer's probe/sync requests come
 * back 401 unless we present credentials. The user stores `{ username?, password }`
 * on the peer record via the Instances UI; every outbound hop attaches this
 * header. An empty username is valid Basic auth (`base64(":password")`), so a
 * password-only credential works against proxies that ignore the username.
 *
 * Returns an empty object when no credential is set so callers can spread it
 * unconditionally: `{ ...peerAuthHeaders(peer), 'Content-Type': '...' }`.
 */
export function peerAuthHeaders(peer) {
  const cred = peer?.auth;
  if (!cred || typeof cred !== 'object') return {};
  const username = typeof cred.username === 'string' ? cred.username : '';
  const password = typeof cred.password === 'string' ? cred.password : '';
  if (!username && !password) return {};
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

// Our own federation instance id, memoized after the first successful read.
// Resolved through a DYNAMIC import because `services/instances.js` imports
// this module — a static import back would close an evaluation-order cycle.
// A failed/absent identity yields no header at all rather than the
// `UNKNOWN_INSTANCE_ID` sentinel, so a receiver sees "unidentified" instead of
// a bogus id it would then fail to resolve in its peer registry.
let cachedSelfInstanceId = null;
async function selfInstanceHeader() {
  if (!cachedSelfInstanceId) {
    const instances = await import('../services/instances.js').catch(() => null);
    const id = await instances?.getInstanceId?.().catch(() => null);
    if (typeof id === 'string' && id && id !== instances?.UNKNOWN_INSTANCE_ID) cachedSelfInstanceId = id;
  }
  return cachedSelfInstanceId ? { 'X-PortOS-Instance-Id': cachedSelfInstanceId } : {};
}

/** Test-support: drop the memoized instance id. */
export function __resetSelfInstanceIdForTests() {
  cachedSelfInstanceId = null;
}

/**
 * Fetch a peer URL. Every hop identifies this install with
 * `X-PortOS-Instance-Id` so the receiver can apply the user's per-peer sharing
 * config to PULL requests (#3659) the way it already does to pushes. Pass the
 * `peer` record (third arg) so a stored Basic-auth credential is attached too;
 * explicit `options.headers` still win over both injected headers (they never
 * collide in practice). The `peer` arg is optional so existing two-arg callers
 * keep working.
 */
export async function peerFetch(url, options = {}, peer = null) {
  const finalOptions = {
    ...options,
    headers: {
      ...await selfInstanceHeader(),
      ...(peer ? peerAuthHeaders(peer) : {}),
      ...(options.headers || {}),
    },
  };
  return url.startsWith('https://') ? httpsFetch(url, finalOptions) : fetch(url, finalOptions);
}

/**
 * Socket.IO client options for a peer connection, with the peer's Basic-auth
 * credential injected as `extraHeaders` so the handshake survives a 401-gating
 * proxy. In Node both the polling and `ws` websocket transports honor
 * `extraHeaders`, so the relay authenticates regardless of which transport wins.
 */
export function peerSocketOptionsFor(peer) {
  const authHeaders = peerAuthHeaders(peer);
  if (Object.keys(authHeaders).length === 0) return peerSocketOptions;
  return { ...peerSocketOptions, extraHeaders: authHeaders };
}
