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

/**
 * Fetch a peer URL. Pass the `peer` record (third arg) so a stored Basic-auth
 * credential is attached automatically; explicit `options.headers` still win
 * over the injected `Authorization` (they never collide in practice). The
 * `peer` arg is optional so existing two-arg callers keep working.
 */
export function peerFetch(url, options = {}, peer = null) {
  const finalOptions = peer
    ? { ...options, headers: { ...peerAuthHeaders(peer), ...(options.headers || {}) } }
    : options;
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
