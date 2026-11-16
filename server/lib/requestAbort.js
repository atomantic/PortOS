// `abortSignalFromResponse(res)`: an AbortSignal that fires only when an Express client disconnects before the response finishes.
//
// Plus `anyAbortSignal(signals)`: combine signals into one (native `AbortSignal.any` with a Node-18 fallback).
//
// Keyed off `res` `close`, NOT `req`'s: `req` can emit `close` once the body is consumed (before the handler runs after body parsing), aborting every normal request. `res` `close` fires when the response is done OR the connection drops; it's a cancel only when `writableEnded` is false.
// The listener only calls `controller.abort()`, which can't throw, so it is safe outside the request lifecycle without try/catch.
/**
 * Combine the supplied live signals into one that aborts when any input does: native `AbortSignal.any`, or a one-shot fan-in fallback (listeners remove themselves on first abort) for early Node 18.
 *
 * @param {(AbortSignal | null | undefined)[]} signals Signals to combine.
 * @returns {AbortSignal | undefined} The sole signal unchanged, a combined signal,
 * or `undefined` when no signal was supplied.
 */
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

/**
 * A cancellation signal for an Express response's unfinished disconnect: `res.close` also fires after a normal response, so it aborts only when `writableEnded` is false (streaming routes stop upstream work on a browser cancel without treating completion as one).
 *
 * @param {import('express').Response} res Express response associated with the work.
 * @returns {AbortSignal} A signal that aborts when the client disconnects early.
 */
export function abortSignalFromResponse(res) {
  const controller = new AbortController();
  if (res?.writableEnded) return controller.signal; // finished normally — never a cancel
  // Already torn down before the response finished: the client is gone and the `close` listener below would never see the event, so abort up front.
  if (res?.destroyed) {
    controller.abort();
    return controller.signal;
  }
  res?.once?.('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
