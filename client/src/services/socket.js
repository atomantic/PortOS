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
  console.log('Socket connected:', socket.id);
});

socket.on('disconnect', (reason) => {
  console.log('Socket disconnected:', reason);
});

socket.on('connect_error', (error) => {
  console.error('Socket connection error:', error.message);
});

export default socket;

/**
 * Subscribe to log streaming for a process
 * @param {string} processName - PM2 process name
 * @param {number} lines - Initial lines to fetch
 * @param {function} onLine - Callback for each log line
 * @param {function} onSubscribed - Callback when subscribed
 * @param {function} onError - Error callback
 * @returns {function} Cleanup function
 */
export function subscribeToLogs(processName, lines, { onLine, onSubscribed, onError, onClose }) {
  const handleLine = (data) => {
    if (data.processName === processName) {
      onLine?.(data);
    }
  };

  const handleSubscribed = (data) => {
    if (data.processName === processName) {
      onSubscribed?.(data);
    }
  };

  const handleError = (data) => {
    if (data.processName === processName) {
      onError?.(data);
    }
  };

  const handleClose = (data) => {
    if (data.processName === processName) {
      onClose?.(data);
    }
  };

  socket.on('logs:line', handleLine);
  socket.on('logs:subscribed', handleSubscribed);
  socket.on('logs:error', handleError);
  socket.on('logs:close', handleClose);

  // Start subscription
  socket.emit('logs:subscribe', { processName, lines });

  // Return cleanup function
  return () => {
    socket.off('logs:line', handleLine);
    socket.off('logs:subscribed', handleSubscribed);
    socket.off('logs:error', handleError);
    socket.off('logs:close', handleClose);
    socket.emit('logs:unsubscribe');
  };
}

/**
 * Check if socket is connected
 */
export function isConnected() {
  return socket.connected;
}
