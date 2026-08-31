import { io } from 'socket.io-client';
import { showStaleBuildToast, showBuildDriftToast } from './staleBuildToast';
import { createBuildDriftWatcher, SERVED_BUILD_ID } from '../lib/buildStamp.js';
import { getSystemBuild } from './apiSystem';
import toast from '../components/ui/Toast';

// Connect to Socket.IO using relative path (works with Tailscale)
// The connection will use the same host the page was loaded from
const isHostedAudienceRoute = typeof window !== 'undefined' &&
  window.location.pathname.replace(/\/+$/, '') === '/fableloom/join';
const socket = io({
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  autoConnect: !isHostedAudienceRoute,
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
  // Auth gate rejected the handshake (server: services/authGate.js socketAuthGate).
  // Bounce to /login so the user can sign back in; skip if already there.
  if (err?.data?.code === 'AUTH_REQUIRED' && typeof window !== 'undefined') {
    if (!window.location.pathname.startsWith('/login') && !isHostedAudienceRoute) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`/login?next=${next}`);
    }
  }
  // Other connection errors: Socket.IO will retry automatically.
});

// Embedded build id from the served index.html — the server injects a
// <meta name="portos-build-id"> tag at boot, and a freshly-rebuilt-and-restarted
// server carries a different one. Defined in lib/buildStamp.js so the drift
// check here and the surfaces that DISPLAY the bundle stamp share one answer to
// "was this page served from a real build?".
const EMBEDDED_BUILD_ID = SERVED_BUILD_ID;

// One frame, two different staleness problems with two different remedies —
// `resolveBuildFrame` owns that decision (it is pure and tested); this just
// dispatches, once per kind per tab.
const TOAST_IDS = { reload: 'portos-stale-build', drift: 'portos-build-drift' };

// The bundle hash arrives on the socket; the commit is FETCHED over the
// authenticated API, because the server's `connection` handler also fires for
// peer relays and must not ship this machine's branch name to another install
// (see server/services/socket.js and routes/systemHealth.js). The merge and
// the once-per-kind latching live in a tested factory.
const buildWatcher = createBuildDriftWatcher({
  embeddedBuildId: EMBEDDED_BUILD_ID,
  fetchIdentity: () => getSystemBuild({ silent: true }),
  onShow: (action) => (action === 'reload' ? showStaleBuildToast() : showBuildDriftToast()),
  onClear: (action) => toast.dismiss(TOAST_IDS[action])
});

socket.on('build:id', ({ buildId } = {}) => buildWatcher.onBuildId(buildId));
socket.on('connect', () => { buildWatcher.refreshIdentity(); });

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
