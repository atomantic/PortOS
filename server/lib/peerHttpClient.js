// Federation HTTP/Socket.IO client — TLS validation off (Tailnet is the trust boundary).
import https from 'node:https';
import { createHmac } from 'node:crypto';
import { insecureFetch, RESPONSE_TOO_LARGE } from './httpClient.js';

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

/**
 * Peer-scoped credential (#8356). A paired peer (both machines hold the same
 * `syncSecret`) proves its identity with an HMAC of that secret bound to its
 * own instance id, instead of presenting this install's instance password over
 * HTTP Basic. The receiver maps it to `method: 'peer'`, which authenticates
 * ordinary federation reads and pushes but never operator authority: it cannot
 * pass `requireHostControl`, and because it is not the password it cannot be
 * exchanged for a session at `/api/auth/login`. The token is directional
 * (the sender's id is in the MAC), so the receiver's matching token toward the
 * sender is a different value, and the pair secret itself never crosses the wire
 * except on the record-push endpoint below.
 */
export const PEER_AUTH_HEADER = 'X-PortOS-Peer-Auth';
export const PEER_INSTANCE_HEADER = 'X-PortOS-Instance-Id';

export function derivePeerAuthToken(syncSecret, senderInstanceId) {
  return createHmac('sha256', syncSecret).update(`portos-peer-auth:v1:${senderInstanceId}`).digest('hex');
}

/**
 * Credential headers for one outbound hop. A paired peer gets the peer token;
 * the stored Basic password rides along only until the receiver has confirmed
 * (through the probe's `peerAuth.accepted` answer, persisted as
 * `peer.peerAuthAccepted`) that it verifies the token. An older receiver, or
 * one whose side of the pair secret is missing or different, never confirms, so
 * it keeps receiving Basic and federation continues unchanged.
 */
function peerCredentialHeaders(peer, selfInstanceId) {
  if (!peer) return {};
  const paired = typeof peer.syncSecret === 'string' && peer.syncSecret.length >= 32 && Boolean(selfInstanceId);
  if (!paired) return peerAuthHeaders(peer);
  return {
    [PEER_INSTANCE_HEADER]: selfInstanceId,
    [PEER_AUTH_HEADER]: derivePeerAuthToken(peer.syncSecret, selfInstanceId),
    ...(peer.peerAuthAccepted === true ? {} : peerAuthHeaders(peer)),
  };
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
async function selfInstanceId() {
  if (!cachedSelfInstanceId) {
    const instanceIdentity = await import('../services/instanceIdentity.js').catch(() => null);
    const id = await instanceIdentity?.getInstanceId?.().catch(() => null);
    if (typeof id === 'string' && id && id !== instanceIdentity?.UNKNOWN_INSTANCE_ID) cachedSelfInstanceId = id;
  }
  return cachedSelfInstanceId;
}

/** Test-support: drop the memoized instance id. */
export function __resetSelfInstanceIdForTests() {
  cachedSelfInstanceId = null;
}

/**
 * Fetch a peer URL. Every hop identifies this install with
 * `X-PortOS-Instance-Id` so the receiver can apply the user's per-peer sharing
 * config to PULL requests (#3659) the way it already does to pushes. Pass the
 * `peer` record (third arg) so its credential is attached too (the pair token
 * and/or stored Basic credential, see peerCredentialHeaders); explicit
 * `options.headers` still win over the injected headers. The `peer` arg is optional so existing two-arg callers
 * keep working.
 */
export async function peerFetch(url, options = {}, peer = null) {
  const callerHeaders = normalizeHeaders(options.headers);
  const selfId = await selfInstanceId();
  // Scope the pair credential to the record-push endpoint; never disclose it
  // to general peer queries, redirects, assets, or announcement responses.
  const syncHeaders = peer?.syncSecret && new URL(url).pathname === '/api/peer-sync/push'
    ? { 'X-PortOS-Peer-Sync-Token': peer.syncSecret } : {};
  const finalOptions = {
    ...options,
    ...(Object.keys(syncHeaders).length ? { redirect: 'error' } : {}),
    headers: {
      ...dropOverridden({
        ...(selfId ? { [PEER_INSTANCE_HEADER]: selfId } : {}),
        ...peerCredentialHeaders(peer, selfId),
        ...syncHeaders,
      }, callerHeaders),
      ...callerHeaders,
    },
  };
  return url.startsWith('https://') ? httpsFetch(url, finalOptions) : fetch(url, finalOptions);
}

export const PEER_BODY_IDLE_TIMEOUT = 'PEER_BODY_IDLE_TIMEOUT';
// Well above any legitimate snapshot; a body past it is a broken or hostile peer.
export const PEER_BODY_DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Consume a peer response with a deadline between received body chunks and a
 * running byte cap. Native fetch resolves at headers and ignores `maxBytes`, so
 * a chunked body with no Content-Length is only bounded here; overflow cancels
 * the reader and rejects with the HTTPS shim's `RESPONSE_TOO_LARGE` code. HTTPS
 * already buffers under the caller's request timeout and `maxBytes`, so its
 * response methods keep their existing behavior.
 */
export async function readPeerBody(response, method, {
  idleTimeoutMs = 60000,
  maxBytes = PEER_BODY_DEFAULT_MAX_BYTES,
} = {}) {
  if (!response.body) return response[method]();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
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
            total += value.byteLength;
            if (total > maxBytes) {
              throw Object.assign(
                new Error(`Peer response body exceeded ${maxBytes} bytes`),
                { code: RESPONSE_TOO_LARGE }
              );
            }
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
    // Cancel a stalled or oversized native fetch to release its socket; do not let transport
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
 * Socket.IO client options for a peer connection, with the same credential
 * headers as `peerFetch` injected as `extraHeaders`. In Node both the polling
 * and `ws` websocket transports honor `extraHeaders`, so the relay
 * authenticates regardless of which transport wins. Synchronous, so it reads
 * the memoized instance id: the relay connects only after a successful probe,
 * which has already resolved it; a cold cache degrades to the Basic credential.
 */
export function peerSocketOptionsFor(peer) {
  const authHeaders = peerCredentialHeaders(peer, cachedSelfInstanceId);
  if (Object.keys(authHeaders).length === 0) return peerSocketOptions;
  return { ...peerSocketOptions, extraHeaders: authHeaders };
}
