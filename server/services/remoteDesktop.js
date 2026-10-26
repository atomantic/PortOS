import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { platform } from 'node:os';
import { createWebSocketStream, WebSocketServer } from 'ws';
import { isPortReachable } from '../lib/connectivity.js';
import { markUpgradeClaimed } from '../lib/upgradeFallback.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_VNC_PORT = 5900;
// Long enough to cross a loopback connect on a busy machine without making a
// dead VNC port feel hung. Deliberately looser than the eidoverse bridge's
// 300ms conflict probe — these two are not interchangeable.
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
  // Two separate seams: `connect` opens the VNC data socket the bridge pipes
  // through, `probeFn` only asks whether anything is listening. They were one
  // option while the probe hand-rolled its own socket; isPortReachable owns that
  // lifecycle now, so the reachability check no longer borrows the data-path
  // constructor.
  connect = createConnection,
  probeFn = isPortReachable,
  connectedSessionTtlMs = CONNECTED_SESSION_TTL_MS,
} = {}) => {
  const sessions = new Map();
  // Live bridges per token so revokeAll can end connections the session map no longer gates.
  const liveBridges = new Map();
  const mountedServers = new WeakMap();

  const deleteExpiredSessions = () => {
    const cutoff = now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= cutoff && !session.connected) sessions.delete(token);
    }
  };

  const probe = () => probeFn({ host, port, timeoutMs: PROBE_TIMEOUT_MS });

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
    if (!httpServer) return;
    if (mountedServers.has(httpServer)) return mountedServers.get(httpServer);
    const wss = new WebSocketServer({ noServer: true });

    const onUpgrade = (request, socket, head) => {
      if (request.url?.split('?', 1)[0] !== '/remote-desktop/ws') return;
      markUpgradeClaimed(socket);
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
    };
    httpServer.on('upgrade', onUpgrade);

    wss.on('connection', (webSocket, _request, token, expiresAt) => {
      const vncSocket = connect({ host, port });
      const webSocketStream = createWebSocketStream(webSocket, { encoding: null });
      let cleanedUp = false;
      let bridges = liveBridges.get(token);
      if (!bridges) liveBridges.set(token, bridges = new Set());
      bridges.add(webSocket);
      const expiryTimer = setTimeout(() => {
        webSocket.close(1000, 'Remote desktop session expired');
      }, Math.max(1, expiresAt - now()));
      expiryTimer.unref?.();
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(expiryTimer);
        bridges.delete(webSocket);
        if (bridges.size === 0 && liveBridges.get(token) === bridges) liveBridges.delete(token);
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

    const unmount = () => {
      if (mountedServers.get(httpServer) !== unmount) return;
      mountedServers.delete(httpServer);
      httpServer.off('upgrade', onUpgrade);
      httpServer.off('close', unmount);
      // Terminate rather than waiting for a remote close handshake during shutdown.
      for (const webSocket of wss.clients) webSocket.terminate();
      wss.close();
    };
    mountedServers.set(httpServer, unmount);
    httpServer.once('close', unmount);
    return unmount;
  };

  // Mirrors the auth contract that every PortOS session credential dies on
  // revocation: drop all tokens, then close bridges (close runs cleanup, which
  // destroys the VNC socket).
  const revokeAll = (reason = 'Remote desktop access revoked') => {
    sessions.clear();
    for (const bridges of [...liveBridges.values()]) {
      for (const webSocket of [...bridges]) webSocket.close(1008, reason);
    }
  };

  return { createSession, hasSession, mountWebSocket, revokeAll, status };
};

export const remoteDesktopBroker = createRemoteDesktopBroker();
