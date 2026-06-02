// Derive an AbortSignal from an Express request that fires when the client
// disconnects (browser fetch aborted, tab closed, network drop). Long-running
// route handlers that proxy a streamed upstream call (e.g. the Local LLM
// playground streaming a model's tokens) can forward this signal so the upstream
// reader tears down the moment the user hits Cancel instead of running on to a
// multi-minute timeout with no one left to receive the response.
//
// `req.on('close')` fires once the connection is gone; the listener only calls
// `controller.abort()`, which can't throw — safe to attach outside the request
// lifecycle without a try/catch.
export function abortSignalFromRequest(req) {
  const controller = new AbortController();
  if (req?.destroyed || req?.aborted) {
    controller.abort();
    return controller.signal;
  }
  req?.once?.('close', () => controller.abort());
  return controller.signal;
}
