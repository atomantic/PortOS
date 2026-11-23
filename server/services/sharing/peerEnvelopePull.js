// Shared fetch → byte-cap → Zod-validate step for the full-sync peer pull sweeps (media library, CoS
// history/tasks, eidoverse foundations). Zero-asset-graph leaf: imports only the peer HTTP client,
// httpClient's size code and abortTimeout, so the lightweight sweeps (see importScoping.test.js) keep
// their import closure.
//
// `peerFetch`'s `maxBytes` only stream-caps the HTTPS shim; a plain-HTTP peer delegates to native
// fetch, which ignores it, so a chunked body would buffer unbounded. The declared content-length is
// the fast path and `readPeerBody` caps the streamed read.

import { peerFetch, readPeerBody } from '../../lib/peerHttpClient.js';
import { RESPONSE_TOO_LARGE } from '../../lib/httpClient.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';

/**
 * @param {object} peer
 * @param {string} url
 * @param {{ maxBytes:number, timeoutMs:number, headers?:object, schema:{safeParse:Function}, label:string, peerName:string }} opts
 *   `label` names the payload in logs; `peerName` is the already-redacted peer display name.
 * @returns {Promise<{ ok:true, data:any } | { ok:false, skipped:'unreachable'|'too-large'|'invalid' }>}
 */
export async function fetchPeerJsonEnvelope(peer, url, { maxBytes, timeoutMs, headers, schema, label, peerName }) {
  const res = await withAbortTimeout(timeoutMs, (signal) =>
    peerFetch(url, { signal, maxBytes, ...(headers ? { headers } : {}) }, peer))
    .catch(() => null);
  if (!res || !res.ok) return { ok: false, skipped: 'unreachable' };
  const declaredLen = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    console.log(`⚠️ peerSync: ${label} from ${peerName} too large (${declaredLen} > ${maxBytes}) — skipping`);
    return { ok: false, skipped: 'too-large' };
  }
  let tooLarge = false;
  const body = await readPeerBody(res, 'json', { maxBytes }).catch((err) => {
    tooLarge = err?.code === RESPONSE_TOO_LARGE;
    return null;
  });
  if (tooLarge) {
    console.log(`⚠️ peerSync: ${label} from ${peerName} streamed past ${maxBytes} bytes — skipping`);
    return { ok: false, skipped: 'too-large' };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    console.log(`⚠️ peerSync: ${label} from ${peerName} failed validation — skipping`);
    return { ok: false, skipped: 'invalid' };
  }
  return { ok: true, data: parsed.data };
}
