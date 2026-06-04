import { io } from 'socket.io-client';
import { showStaleBuildToast } from './staleBuildToast';

// Connect to Socket.IO using relative path (works with Tailscale)
// The connection will use the same host the page was loaded from
const socket = io({
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000
});

socket.on('connect', () => {
  // Connection established
});

socket.on('disconnect', () => {
  // Connection lost - Socket.IO will attempt reconnection automatically
});

socket.on('connect_error', (err) => {
  // Auth gate rejected the handshake (server: lib/authGate.js socketAuthGate).
  // Bounce to /login so the user can sign back in; skip if already there.
  if (err?.data?.code === 'AUTH_REQUIRED' && typeof window !== 'undefined') {
    if (!window.location.pathname.startsWith('/login')) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`/login?next=${next}`);
    }
  }
  // Other connection errors: Socket.IO will retry automatically.
});

// Embedded build id from the served index.html. The server injects a
// <meta name="portos-build-id" content="..."> tag into index.html at boot;
// a freshly-rebuilt-and-restarted server will have a different id, and the
// `build:id` socket event below catches the mismatch so the tab can reload.
const EMBEDDED_BUILD_ID = (() => {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('meta[name="portos-build-id"]');
  return el ? el.getAttribute('content') : null;
})();

let staleToastShown = false;
socket.on('build:id', ({ buildId } = {}) => {
  if (!buildId || !EMBEDDED_BUILD_ID || buildId === EMBEDDED_BUILD_ID) return;
  if (staleToastShown) return;
  staleToastShown = true;
  showStaleBuildToast();
});

export default socket;

/**
 * Check if socket is connected
 */
export function isConnected() {
  return socket.connected;
}

/**
 * The build id the running client was served with. Components that want to
 * key per-session state to a specific bundle version (e.g. anti-loop guards
 * in stale-chunk reload) can import this.
 */
export const CLIENT_BUILD_ID = EMBEDDED_BUILD_ID;
