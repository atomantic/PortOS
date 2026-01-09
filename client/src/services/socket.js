import { io } from 'socket.io-client';

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

socket.on('connect_error', () => {
  // Connection error - Socket.IO will retry automatically
});

export default socket;

/**
 * Check if socket is connected
 */
export function isConnected() {
  return socket.connected;
}
