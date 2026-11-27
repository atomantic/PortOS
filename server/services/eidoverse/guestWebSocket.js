/** Relay a federated renderer connection under the visitor identity granted by its host. */
import { WebSocket, WebSocketServer } from 'ws';
import { EIDOVERSE_PORT } from '../../lib/eidoversePort.js';

const guests = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 1024 * 1024 });

function visitorMessage(data, isBinary, identity, joined) {
  if (isBinary) return null;
  try {
    const frame = JSON.parse(data.toString());
    if (typeof frame?.type !== 'string') return null;
    if (frame.type !== 'join') return joined ? data : null;
    if (frame.world !== identity.world || frame.id !== identity.name || frame.guest !== true
      || (frame.agent !== undefined && frame.agent !== false)) return null;
    // The renderer omits agent for humans. Build the upstream identity from
    // the ticket, retaining the renderer's wire-version and timing negotiation.
    return JSON.stringify({
      type: 'join', world: identity.world, id: identity.name, avatar: identity.avatar, agent: false, guest: true,
      replica: frame.replica, session: frame.session, clock: frame.clock, hello: frame.hello,
    });
  } catch {
    return null;
  }
}

// Retain TCP backpressure across the two separately terminated WebSockets.
function relay(source, destination, data, binary) {
  source.pause();
  destination.send(data, { binary }, (error) => {
    if (error) source.terminate();
    else source.resume();
  });
}

export function proxyGuestWebSocket({ req, clientSocket, head, pathOverride, targetHost = '127.0.0.1', targetPort = EIDOVERSE_PORT, trackSocket }, identity) {
  if ((pathOverride ?? req.url).split('?')[0] !== '/ws') {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => clientSocket.destroy());
    return;
  }
  trackSocket?.(clientSocket);
  guests.handleUpgrade(req, clientSocket, head, (client) => {
    // Keep early frames on the socket until both ends are ready. The upstream
    // handshake carries no browser credentials, client-supplied URL or headers.
    client.pause();
    const host = targetHost.includes(':') && !targetHost.startsWith('[') ? `[${targetHost}]` : targetHost;
    const upstream = new WebSocket(`ws://${host}:${targetPort}/ws`, { handshakeTimeout: 10000 });
    client.once('error', () => client.terminate());
    client.once('close', () => upstream.terminate());
    upstream.once('error', () => client.close(1011, 'World connection failed.'));
    upstream.once('close', (code, reason) => {
      if (code === 1006) client.terminate();
      else if (code === 1005) client.close();
      else client.close(code, reason);
    });
    upstream.once('open', () => {
      let joined = false;
      client.on('message', (data, isBinary) => {
        if (client.readyState !== WebSocket.OPEN || upstream.readyState !== WebSocket.OPEN) return;
        const frame = visitorMessage(data, isBinary, identity, joined);
        if (!frame) {
          client.close(1008, 'A visitor must use the assigned seat.');
          return;
        }
        joined = true;
        relay(client, upstream, frame, false);
      });
      upstream.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) relay(upstream, client, data, isBinary);
      });
      client.resume();
    });
  });
}
