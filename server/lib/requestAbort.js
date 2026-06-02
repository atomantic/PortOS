// Derive an AbortSignal from an Express response that fires only when the client
// disconnects *before the response is finished* — i.e. a genuine cancel (browser
// fetch aborted, tab closed, network drop) rather than the normal end of a
// request. Long-running route handlers that proxy a streamed upstream call (e.g.
// the Local LLM playground streaming a model's tokens) can forward this signal so
// the upstream reader tears down the moment the user hits Cancel instead of
// running on to a multi-minute timeout with no one left to receive the response.
//
// We key off `res`'s `close` event, NOT `req`'s: `req` (the IncomingMessage) can
// emit `close` once the request body is fully consumed — which, after body
// parsing, is before the handler even runs — so a `req`-based signal would abort
// every normal request immediately. `res` `close` fires when the response is done
// OR the connection drops; we only treat it as a cancel when the response had not
// finished writing (`writableEnded` false), which is the disconnect case.
//
// The listener only calls `controller.abort()`, which can't throw — safe to attach
// outside the request lifecycle without a try/catch.
// Combine several AbortSignals into one that fires when any of them aborts.
// Prefers the native `AbortSignal.any` (Node 20.3+ / 18.17+) and falls back to a
// manual fan-in for older Node 18 builds — PortOS's `package.json` engines accept
// Node 18, and `AbortSignal.any` is absent on the early-18 line. Mirrors the guard
// in `fetchWithTimeout.js`. The fallback's listeners are `{ once: true }` and self-
// removing on first abort, so there's nothing to clean up.
export function anyAbortSignal(signals) {
  const live = signals.filter(Boolean);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(live);
  }
  const controller = new AbortController();
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export function abortSignalFromResponse(res) {
  const controller = new AbortController();
  if (res?.writableEnded) return controller.signal; // finished normally — never a cancel
  // Already torn down before the response finished: the client is gone, so the
  // `close` listener below would never see the event — abort up front.
  if (res?.destroyed) {
    controller.abort();
    return controller.signal;
  }
  res?.once?.('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
