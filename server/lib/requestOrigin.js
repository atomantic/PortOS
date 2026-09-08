// Only the listener can mark a request remote. HTTP headers cannot grant local
// authority, even when a transport such as Tailcat connects through localhost.
const remoteRequests = new WeakSet();

export function remoteRequestHandler(handler) {
  return (req, res) => {
    remoteRequests.add(req);
    return handler(req, res);
  };
}

export const isRemoteRequest = (req) => remoteRequests.has(req);
