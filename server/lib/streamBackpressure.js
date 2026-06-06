// Socket backpressure helper for streaming HTTP responses (SSE / NDJSON).
//
// `res.write()` returns false when the kernel/send buffer is full. A producer
// that ignores that return value buffers the whole response in memory when the
// reader is slower than the writer (a fast local model streaming to a slow
// client). Awaiting `awaitWritableDrain(res)` parks the producer until the
// socket drains — or the client disconnects — so writes stay bounded.
//
// Both listeners are torn down on settle so a client that hangs up mid-drain
// can't leak a `drain`/`close` listener. Resolves immediately when the response
// is already finished (nothing left to drain). Shared by the SSE `send` helper
// in routes/ask.js and the NDJSON `write` helper in routes/localLlm.js.
export const awaitWritableDrain = (res) => {
  if (res.writableEnded || res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = () => {
      res.off('drain', settle);
      res.off('close', settle);
      resolve();
    };
    res.once('drain', settle);
    res.once('close', settle);
  });
};
