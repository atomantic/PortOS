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
// Resolved through a dynamic import of the identity leaf (#6836): harmless to
// static-import now (services/instanceIdentity.js is a leaf with no edge back
// to this module — the old cycle ran through services/instances.js, which
// still imports peerFetch), kept lazy here to match this file's peer-registry
// call shape. A failed/absent identity yields no header at all rather than the
// `UNKNOWN_INSTANCE_ID` sentinel, so a receiver sees "unidentified" instead of
// a bogus id it would then fail to resolve in its peer registry.
let cachedSelfInstanceId = null;
async function selfInstanceHeader() {
  if (!cachedSelfInstanceId) {
    const instanceIdentity = await import('../services/instanceIdentity.js').catch(() => null);
    const id = await instanceIdentity?.getInstanceId?.().catch(() => null);
    if (typeof id === 'string' && id && id !== instanceIdentity?.UNKNOWN_INSTANCE_ID) cachedSelfInstanceId = id;
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
  const callerHeaders = normalizeHeaders(options.headers);
  // Scope the pair credential to the record-push endpoint; never disclose it
  // to general peer queries, redirects, assets, or announcement responses.
  const syncHeaders = peer?.syncSecret && new URL(url).pathname === '/api/peer-sync/push'
    ? { 'X-PortOS-Peer-Sync-Token': peer.syncSecret } : {};
  const finalOptions = {
    ...options,
    ...(Object.keys(syncHeaders).length ? { redirect: 'error' } : {}),
    headers: {
      ...dropOverridden({ ...await selfInstanceHeader(), ...(peer ? peerAuthHeaders(peer) : {}), ...syncHeaders }, callerHeaders),
      ...callerHeaders,
    },
  };
  return url.startsWith('https://') ? httpsFetch(url, finalOptions) : fetch(url, finalOptions);
}

export const PEER_BODY_IDLE_TIMEOUT = 'PEER_BODY_IDLE_TIMEOUT';

/**
 * Consume a peer response with a deadline between received body chunks. Native
 * fetch resolves at headers; HTTPS already buffers under the caller's request
 * timeout, so its response methods keep their existing behavior.
 */
export async function readPeerBody(response, method, { idleTimeoutMs = 60000 } = {}) {
  if (!response.body) return response[method]();

  const reader = response.body.getReader();
  const chunks = [];
  let timer;
  let rejectIdle;
  const idle = new Promise((_, reject) => { rejectIdle = reject; });
  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => rejectIdle(Object.assign(
      new Error('Peer response body stalled'), { code: PEER_BODY_IDLE_TIMEOUT }
    )), idleTimeoutMs);
  };
  resetIdle();
  try {
    await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.byteLength) {
            chunks.push(value);
            resetIdle();
          }
        }
      })(),
      idle,
    ]);
    return new Response(Buffer.concat(chunks))[method]();
  } finally {
    clearTimeout(timer);
    // Cancel a stalled native fetch to release its socket; do not let transport
    // cleanup hold the sync lock after the deadline has already fired.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers[Symbol.iterator] === 'function') return Object.fromEntries(new Headers(headers));
  return { ...headers };
}

/**
 * Drop injected headers the caller already set under ANY casing. Object spread
 * is case-sensitive, so `{ 'X-PortOS-Instance-Id': a, 'x-portos-instance-id': b }`
 * survives as two keys and fetch sends the value twice — which Express then
 * hands the receiver as `"a, b"`, matching no registered peer.
 */
function dropOverridden(injected, callerHeaders) {
  const callerKeys = new Set(Object.keys(callerHeaders).map((k) => k.toLowerCase()));
  return Object.fromEntries(Object.entries(injected).filter(([k]) => !callerKeys.has(k.toLowerCase())));
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
