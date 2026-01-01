import { spawn } from 'child_process';

// Store active log streams per socket
const activeStreams = new Map();

export function initSocket(io) {
  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Handle log streaming requests
    socket.on('logs:subscribe', ({ processName, lines = 100 }) => {
      // Clean up any existing stream for this socket
      cleanupStream(socket.id);

      console.log(`📜 Log stream started: ${processName} (${lines} lines)`);

      // Spawn pm2 logs with --raw flag
      const logProcess = spawn('pm2', ['logs', processName, '--raw', '--lines', String(lines)], {
        shell: false
      });

      activeStreams.set(socket.id, { process: logProcess, processName });

      let buffer = '';

      logProcess.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(line => {
          if (line.trim()) {
            socket.emit('logs:line', {
              line,
              type: 'stdout',
              timestamp: Date.now(),
              processName
            });
          }
        });
      });

      logProcess.stderr.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(line => {
          if (line.trim()) {
            socket.emit('logs:line', {
              line,
              type: 'stderr',
              timestamp: Date.now(),
              processName
            });
          }
        });
      });

      logProcess.on('error', (err) => {
        socket.emit('logs:error', { error: err.message, processName });
      });

      logProcess.on('close', (code) => {
        socket.emit('logs:close', { code, processName });
        activeStreams.delete(socket.id);
      });

      socket.emit('logs:subscribed', { processName, timestamp: Date.now() });
    });

    // Handle unsubscribe
    socket.on('logs:unsubscribe', () => {
      cleanupStream(socket.id);
      socket.emit('logs:unsubscribed');
    });

    // Cleanup on disconnect
    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
      cleanupStream(socket.id);
    });
  });
}

function cleanupStream(socketId) {
  const stream = activeStreams.get(socketId);
  if (stream) {
    stream.process.kill('SIGTERM');
    activeStreams.delete(socketId);
  }
}

// Broadcast to all connected clients
export function broadcast(io, event, data) {
  io.emit(event, data);
}
