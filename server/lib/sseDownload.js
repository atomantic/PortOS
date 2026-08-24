// Pure SSE response plumbing, shared by every streaming route: open a stream
// with write-safe helpers, and notice when the client hangs up.
//
// The HF-repo download driver that used to live here moved to
// `services/hfDownloadStream.js` — it spawns a child process and reads
// settings, so it belongs above this layer (issue #4901). These two helpers do
// not, and 11 routes use them with no HF involvement at all.

import { SSE_HEADERS } from './sseHeaders.js';

/**
 * Open an SSE response and return write-safe helpers. Canonical replacement
 * for the per-route `writeHead → send → safeEnd` boilerplate: `send` JSON-
 * encodes one event per frame and both helpers no-op after the response ends.
 *
 * @param {import('http').ServerResponse} res - Express/HTTP response
 * @returns {{ send: (event: object) => void, safeEnd: () => void }}
 */
export function openSseStream(res) {
  res.writeHead(200, SSE_HEADERS);
  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };
  return { send, safeEnd };
}

/**
 * Run `onDisconnect` when the CLIENT goes away mid-stream.
 *
 * Use this instead of `req.on('close', …)`. On a POST whose JSON body
 * `express.json()` has already consumed, the request is complete before the
 * handler runs (`req.complete === true`), so Node emits `'close'` on the very
 * next tick — a handler that attaches the listener before its first `await`
 * reads that as an instant client disconnect and cancels work that never
 * started. `POST /api/music/models` did exactly that: the download aborted
 * before its first frame, the stream closed empty, and the UI reported the
 * install as a success. GET routes are unaffected (nothing to consume), which
 * is why every other SSE endpoint here looked fine.
 *
 * The response is the right thing to watch: `res` `'close'` fires only when the
 * response actually closes, and `writableEnded` separates our own `safeEnd()`
 * from a genuine disconnect.
 *
 * @param {import('http').IncomingMessage} _req - unused; kept so call sites read as (req, res)
 * @param {import('http').ServerResponse} res
 * @param {() => void} onDisconnect
 */
export function onClientDisconnect(_req, res, onDisconnect) {
  res.on('close', () => {
    if (res.writableEnded) return; // we ended it — normal completion
    onDisconnect();
  });
}
