// Pure SSE response plumbing shared by every streaming route.
//
// Pure SSE response plumbing shared by every streaming route: open a stream with write-safe helpers, and notice when the client hangs up. (The HF-repo download driver moved to `services/hfDownloadStream.js`, #4901: it spawns a child process and reads settings; these two helpers don't, and 11 routes use them with no HF involvement.)

import { SSE_HEADERS } from './sseHeaders.js';

/**
 * Open an SSE response and return write-safe helpers: the canonical replacement for per-route `writeHead → send → safeEnd` boilerplate (`send` JSON-encodes one event per frame; both helpers no-op after the response ends).
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
 * Run `onDisconnect` when the CLIENT goes away mid-stream. Use this instead of `req.on('close', …)`: on a POST whose JSON body `express.json()` already consumed, the request is complete before the handler runs (`req.complete === true`), so Node emits `'close'` on the next tick, and a listener attached before the first `await` reads that as an instant disconnect and cancels work that never started
 * (`POST /api/music/models` aborted before its first frame, closed empty, and the UI reported success; GET routes are unaffected). The response is the right thing to watch: `res` `'close'` fires only when it actually closes, and `writableEnded` separates our own `safeEnd()` from a real disconnect.
 */
export function onClientDisconnect(_req, res, onDisconnect) {
  res.on('close', () => {
    if (res.writableEnded) return; // we ended it — normal completion
    onDisconnect();
  });
}
