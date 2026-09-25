// Graceful request drain for the HTTP listeners at shutdown (#8323).
//
// `createHttpDrain(servers)` starts tracking every ordinary request the given
// servers accept (upgrades never emit 'request', so WebSockets are not tracked —
// their owners close them). `begin(windowMs)` is the synchronous "stop intake"
// step the signal handler calls before it first awaits:
//
//   - each listener stops accepting connections (`server.close()`, which also
//     drops idle keep-alive sockets);
//   - every request listener is swapped for a 503 + `Connection: close` refusal,
//     so a request that arrives on a still-open keep-alive socket is never
//     handed to the app — `server.close()` alone keeps serving those;
//   - in-flight responses are told not to keep their socket alive, and an open
//     SSE stream (which never ends on its own) is dropped outright.
//
// It returns a promise that resolves once every accepted request has finished,
// or at the window's deadline, with `{ remaining }` — the count still running.
// Force-closing whatever remains (`closeAllConnections()`) is the caller's next
// step. The deadline timer is unref'd so it never holds the process open.

const EVENT_STREAM = /^content-type:\s*text\/event-stream/im;

// `writeHead(status, headersObject)` writes the header block without populating
// `getHeader()`, so fall back to the serialized header once it has been sent.
const isEventStream = (res) =>
  /text\/event-stream/i.test(String(res.getHeader('content-type') ?? ''))
  || EVENT_STREAM.test(res._header || '');

const refuseDuringDrain = (req, res) => {
  res.shouldKeepAlive = false;
  res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close', 'Retry-After': '5' });
  res.end(JSON.stringify({ error: 'Server is shutting down', code: 'SHUTTING_DOWN' }));
};

export const createHttpDrain = (servers) => {
  const listeners = servers.filter(Boolean);
  const inFlight = new Set();
  let draining = null;
  let settle = null;

  const settleIfIdle = () => {
    if (settle && inFlight.size === 0) settle();
  };

  const track = (req, res) => {
    inFlight.add(res);
    res.once('close', () => {
      inFlight.delete(res);
      if (!draining) return;
      // A response whose headers went out before the drain began still
      // advertised keep-alive; its socket turns idle now, so drop it before a
      // next request can arrive on it.
      setImmediate(() => { for (const server of listeners) server.closeIdleConnections?.(); });
      settleIfIdle();
    });
  };
  for (const server of listeners) server.prependListener('request', track);

  const begin = (windowMs) => {
    if (draining) return draining;
    draining = new Promise((resolve) => {
      let timer = null;
      settle = () => {
        clearTimeout(timer);
        settle = null;
        resolve({ remaining: inFlight.size });
      };
      timer = setTimeout(() => settle?.(), windowMs);
      timer.unref?.();
    });

    for (const server of listeners) {
      server.removeAllListeners('request');
      server.on('request', refuseDuringDrain);
      // Already-closed (never listened) is fine — the refusal gate above is
      // what matters for sockets that are still open.
      server.close(() => {});
    }
    for (const res of inFlight) {
      if (isEventStream(res)) res.socket?.destroy();
      else if (!res.headersSent) res.shouldKeepAlive = false;
    }
    settleIfIdle();
    return draining;
  };

  return { begin };
};
