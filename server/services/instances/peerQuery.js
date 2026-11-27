/** Proxy allowed federation reads to a registered peer. */
import { PROBE_TIMEOUT_MS } from './peerRecord.js';
import { loadData } from '../instanceIdentity.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch, readPeerBody } from '../../lib/peerHttpClient.js';
import { isPeerApiRequestAllowed } from '../../lib/apiAccessPolicy.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';

const PEER_QUERY_BODY_MAX_BYTES = 64 * 1024 * 1024;

// --- Query Proxy ---

const PEER_PLACEHOLDER_ORIGIN = 'http://peer.invalid';

// Resolve a caller-supplied proxy path to "pathname + query" that is guaranteed
// to stay on the peer origin and on the documented federation surface
// (PEER_API_SURFACE), or null. The allowlist runs on the path exactly as it will
// be sent, so a segment a URL parser would normalize away (`..`, tabs, `\`) is
// refused rather than argued past.
function resolvePeerQueryTarget(apiPath) {
  if (typeof apiPath !== 'string' || !apiPath.startsWith('/') || /[\s\\#]/.test(apiPath)) return null;
  const queryAt = apiPath.indexOf('?');
  const rawPath = queryAt === -1 ? apiPath : apiPath.slice(0, queryAt);
  const search = queryAt === -1 ? '' : apiPath.slice(queryAt);
  let parsed;
  try {
    parsed = new URL(rawPath, PEER_PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== PEER_PLACEHOLDER_ORIGIN || parsed.username || parsed.password) return null;
  if (parsed.pathname !== rawPath) return null;
  const lower = rawPath.toLowerCase();
  // The `/api/peer-sync/` read prefix also spans the POST-only push endpoint,
  // which carries the sync secret; a GET proxy never has a reason to name it.
  if (lower.replace(/\/$/, '') === '/api/peer-sync/push') return null;
  if (!isPeerApiRequestAllowed('GET', lower)) return null;
  return `${rawPath}${search}`;
}

export async function queryPeer(id, apiPath) {
  const data = await loadData();
  const peer = data.peers.find(p => p.id === id);
  if (!peer) return { error: 'Peer not found', status: 404 };

  const target = resolvePeerQueryTarget(apiPath);
  if (!target) return { error: 'Path is not on the peer federation surface', status: 400 };

  const url = `${peerBaseUrl(peer)}${target}`;
  return withAbortTimeout(PROBE_TIMEOUT_MS, async (signal) => {
    const res = await peerFetch(url, { signal, maxBytes: PEER_QUERY_BODY_MAX_BYTES }, peer);
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return { error: `Peer query failed (upstream HTTP ${res.status})`, status: 502 };
    }
    return { success: true, data: await readPeerBody(res, 'json', { maxBytes: PEER_QUERY_BODY_MAX_BYTES }) };
  }).catch((err) => ({ error: `Failed to query peer: ${err.message}` }));
}
