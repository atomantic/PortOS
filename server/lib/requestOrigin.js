// Only the listener can mark a request remote. HTTP headers cannot grant local
// authority, even when a transport such as Tailcat connects through localhost.
const remoteRequests = new WeakSet();

export function remoteRequestHandler(handler) {
  return (req, res) => {
    remoteRequests.add(req);
    return handler(req, res);
  };
}

// Socket.IO's `attach` intercepts its own handshake and upgrade requests before
// the server's request handler runs, so a handler-level mark never sees them.
// Prepending here (after `io.attach`) marks every request and upgrade the
// listener accepts; the engine.io socket keeps that handshake request as
// `socket.request`, which is what the socket auth gate checks.
export function markRemoteServer(server) {
  const mark = (req) => { remoteRequests.add(req); };
  server.prependListener('request', mark);
  server.prependListener('upgrade', mark);
  return server;
}

export const isRemoteRequest = (req) => remoteRequests.has(req);
