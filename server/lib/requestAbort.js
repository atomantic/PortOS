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
/**
 * Combine the supplied live signals into one signal that aborts when any input does.
 *
 * Prefers native `AbortSignal.any` and preserves early Node 18 compatibility with a
 * one-shot fan-in fallback. The fallback listeners remove themselves on first abort.
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
 * Create a cancellation signal for an Express response's unfinished disconnect.
 *
 * `res.close` also fires after a normal response, so the signal aborts only when
 * `writableEnded` is false. This lets streaming routes stop upstream work when a
 * browser cancels without treating successful response completion as a cancellation.
 *
 * @param {import('express').Response} res Express response associated with the work.
 * @returns {AbortSignal} A signal that aborts when the client disconnects early.
 */
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
