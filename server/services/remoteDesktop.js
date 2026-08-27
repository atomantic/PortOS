import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { platform } from 'node:os';
import { createWebSocketStream, WebSocketServer } from 'ws';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_VNC_PORT = 5900;
const PROBE_TIMEOUT_MS = 750;
const SESSION_TTL_MS = 5 * 60 * 1000;
const CONNECTED_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

const parseVncPort = (value) => {
  const port = Number.parseInt(value ?? '', 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_VNC_PORT;
};

const codedError = (message, code) => Object.assign(new Error(message), { code });

export const createRemoteDesktopBroker = ({
  host = LOOPBACK_HOST,
  port = parseVncPort(process.env.PORTOS_VNC_PORT),
  now = () => Date.now(),
  connect = createConnection,
  connectedSessionTtlMs = CONNECTED_SESSION_TTL_MS,
} = {}) => {
  const sessions = new Map();
  const mountedServers = new WeakSet();

  const deleteExpiredSessions = () => {
    const cutoff = now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= cutoff && !session.connected) sessions.delete(token);
    }
  };

  const probe = () => new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

  const status = async () => ({
    supported: true,
    configured: await probe(),
    platform: platform(),
    port,
  });

  const createSession = async () => {
    if (!await probe()) {
      throw codedError(
        `No VNC server is reachable on loopback port ${port}. Run npm run setup:remote-desktop on the PortOS machine.`,
        'VNC_NOT_CONFIGURED',
      );
    }
    deleteExpiredSessions();
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = now() + SESSION_TTL_MS;
    sessions.set(token, { activated: false, connected: false, expiresAt });
    return {
      viewerPath: `/remote-desktop?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  };

  const readSession = (token) => {
    if (typeof token !== 'string' || token.length < 32) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(token);
      return null;
    }
    return session;
  };

  const hasSession = (token) => readSession(token) !== null;

  const claimSession = (token) => {
    const session = readSession(token);
    if (!session || session.connected) return null;
    if (!session.activated) {
      session.activated = true;
      session.expiresAt = now() + connectedSessionTtlMs;
    }
    session.connected = true;
    return session;
  };

  const releaseSession = (token) => {
    const session = sessions.get(token);
    if (!session) return;
    session.connected = false;
    if (session.expiresAt <= now()) sessions.delete(token);
  };

  const mountWebSocket = (httpServer) => {
    if (!httpServer || mountedServers.has(httpServer)) return;
    mountedServers.add(httpServer);
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
      if (request.url?.split('?', 1)[0] !== '/remote-desktop/ws') return;
      let url;
      try {
        url = new URL(request.url, 'http://portos.invalid');
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token');
      const session = claimSession(token);
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      try {
        wss.handleUpgrade(request, socket, head, (webSocket) => {
          wss.emit('connection', webSocket, request, token, session.expiresAt);
        });
      } catch {
        releaseSession(token);
        socket.destroy();
      }
    });

    wss.on('connection', (webSocket, _request, token, expiresAt) => {
      const vncSocket = connect({ host, port });
      const webSocketStream = createWebSocketStream(webSocket, { encoding: null });
      let cleanedUp = false;
      const expiryTimer = setTimeout(() => {
        webSocket.close(1000, 'Remote desktop session expired');
      }, Math.max(1, expiresAt - now()));
      expiryTimer.unref?.();
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(expiryTimer);
        releaseSession(token);
        vncSocket.destroy();
        webSocketStream.destroy();
      };
      vncSocket.once('connect', () => {
        vncSocket.pipe(webSocketStream).pipe(vncSocket);
      });
      vncSocket.once('error', () => webSocket.close(1011, 'VNC server unavailable'));
      webSocket.once('close', cleanup);
      webSocketStream.once('error', cleanup);
    });
  };

  return { createSession, hasSession, mountWebSocket, status };
};

export const remoteDesktopBroker = createRemoteDesktopBroker();
