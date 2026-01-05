import { spawn } from 'child_process';
import { streamDetection } from './streamingDetect.js';
import { cosEvents } from './cos.js';
import { errorEvents } from '../lib/errorHandler.js';
import { handleErrorRecovery } from './autoFixer.js';
import * as pm2Standardizer from './pm2Standardizer.js';

// Store active log streams per socket
const activeStreams = new Map();
// Store CoS subscribers
const cosSubscribers = new Set();
// Store error subscribers for auto-fix notifications
const errorSubscribers = new Set();

export function initSocket(io) {
  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Handle streaming app detection
    socket.on('detect:start', async ({ path }) => {
      console.log(`🔍 Starting detection: ${path}`);
      await streamDetection(socket, path);
    });

    // Handle PM2 standardization
    socket.on('standardize:start', async ({ repoPath, providerId }) => {
      console.log(`🔧 Starting PM2 standardization: ${repoPath}`);

      const emit = (step, status, data = {}) => {
        socket.emit('standardize:step', { step, status, data, timestamp: Date.now() });
      };

      // Step 1: Analyze
      emit('analyze', 'running', { message: 'Analyzing project configuration...' });

      const analysis = await pm2Standardizer.analyzeApp(repoPath, providerId)
        .catch(err => ({ success: false, error: err.message }));

      if (!analysis.success) {
        emit('analyze', 'error', { message: analysis.error });
        socket.emit('standardize:complete', { success: false, error: analysis.error });
        return;
      }

      emit('analyze', 'done', {
        message: `Found ${analysis.proposedChanges.processes?.length || 0} processes`,
        processes: analysis.proposedChanges.processes,
        strayPorts: analysis.proposedChanges.strayPorts
      });

      socket.emit('standardize:analyzed', { plan: analysis });

      // Step 2: Backup
      emit('backup', 'running', { message: 'Creating git backup...' });

      const backup = await pm2Standardizer.createGitBackup(repoPath)
        .catch(err => ({ success: false, reason: err.message }));

      if (backup.success) {
        emit('backup', 'done', { message: `Backup branch: ${backup.branch}`, branch: backup.branch });
      } else {
        emit('backup', 'skipped', { message: backup.reason || 'No git repository' });
      }

      // Step 3: Apply changes
      emit('apply', 'running', { message: 'Writing ecosystem.config.cjs...' });

      const result = await pm2Standardizer.applyStandardization(repoPath, analysis)
        .catch(err => ({ success: false, errors: [err.message] }));

      if (result.errors?.length > 0) {
        emit('apply', 'error', { message: result.errors.join(', ') });
        socket.emit('standardize:complete', { success: false, error: result.errors.join(', ') });
        return;
      }

      emit('apply', 'done', {
        message: `Modified ${result.filesModified.length} files`,
        filesModified: result.filesModified
      });

      // Complete
      socket.emit('standardize:complete', {
        success: true,
        result: {
          backupBranch: result.backupBranch,
          filesModified: result.filesModified,
          processes: analysis.proposedChanges.processes
        }
      });

      console.log(`✅ Standardization complete: ${result.filesModified.length} files modified`);
    });

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

    // CoS subscriptions
    socket.on('cos:subscribe', () => {
      cosSubscribers.add(socket);
      socket.emit('cos:subscribed');
    });

    socket.on('cos:unsubscribe', () => {
      cosSubscribers.delete(socket);
      socket.emit('cos:unsubscribed');
    });

    // Error event subscriptions
    socket.on('errors:subscribe', () => {
      errorSubscribers.add(socket);
      socket.emit('errors:subscribed');
    });

    socket.on('errors:unsubscribe', () => {
      errorSubscribers.delete(socket);
      socket.emit('errors:unsubscribed');
    });

    // Handle error recovery requests (can trigger auto-fix agents)
    socket.on('error:recover', async ({ code, context }) => {
      console.log(`🔧 Error recovery requested: ${code}`);

      // Create auto-fix task
      const task = await handleErrorRecovery(code, context);

      // Broadcast recovery task created
      io.emit('error:recover:requested', {
        code,
        context,
        taskId: task.id,
        timestamp: Date.now()
      });
    });

    // Cleanup on disconnect
    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
      cleanupStream(socket.id);
      cosSubscribers.delete(socket);
      errorSubscribers.delete(socket);
    });
  });

  // Set up CoS event forwarding to subscribers
  setupCosEventForwarding();

  // Set up error event forwarding to subscribers
  setupErrorEventForwarding();
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

// Broadcast to CoS subscribers only
function broadcastToCos(event, data) {
  for (const socket of cosSubscribers) {
    socket.emit(event, data);
  }
}

// Broadcast to error subscribers only
function broadcastToErrors(event, data) {
  for (const socket of errorSubscribers) {
    socket.emit(event, data);
  }
}

// Set up CoS event forwarding
function setupCosEventForwarding() {
  // Status events
  cosEvents.on('status', (data) => broadcastToCos('cos:status', data));

  // Log events for real-time UI feedback
  cosEvents.on('log', (data) => broadcastToCos('cos:log', data));

  // Task events
  cosEvents.on('tasks:user:changed', (data) => broadcastToCos('cos:tasks:user:changed', data));
  cosEvents.on('tasks:user:added', (data) => broadcastToCos('cos:tasks:user:added', data));
  cosEvents.on('tasks:user:completed', (data) => broadcastToCos('cos:tasks:user:completed', data));
  cosEvents.on('tasks:cos:changed', (data) => broadcastToCos('cos:tasks:cos:changed', data));

  // Agent events
  cosEvents.on('agent:spawned', (data) => broadcastToCos('cos:agent:spawned', data));
  cosEvents.on('agent:updated', (data) => broadcastToCos('cos:agent:updated', data));
  cosEvents.on('agent:completed', (data) => broadcastToCos('cos:agent:completed', data));
  cosEvents.on('agent:output', (data) => broadcastToCos('cos:agent:output', data));

  // Memory events
  cosEvents.on('memory:created', (data) => broadcastToCos('cos:memory:created', data));
  cosEvents.on('memory:updated', (data) => broadcastToCos('cos:memory:updated', data));
  cosEvents.on('memory:deleted', (data) => broadcastToCos('cos:memory:deleted', data));
  cosEvents.on('memory:extracted', (data) => broadcastToCos('cos:memory:extracted', data));
  cosEvents.on('memory:approval-needed', (data) => broadcastToCos('cos:memory:approval-needed', data));

  // Health events
  cosEvents.on('health:check', (data) => broadcastToCos('cos:health:check', data));
  cosEvents.on('health:critical', (data) => broadcastToCos('cos:health:critical', data));

  // Evaluation events
  cosEvents.on('evaluation', (data) => broadcastToCos('cos:evaluation', data));
  cosEvents.on('task:ready', (data) => broadcastToCos('cos:task:ready', data));

  // Watcher events
  cosEvents.on('watcher:started', (data) => broadcastToCos('cos:watcher:started', data));
  cosEvents.on('watcher:stopped', (data) => broadcastToCos('cos:watcher:stopped', data));
}

// Set up error event forwarding
function setupErrorEventForwarding() {
  // Forward error events to error subscribers
  errorEvents.on('error', (error) => {
    broadcastToErrors('error:notified', {
      message: error.message,
      code: error.code,
      severity: error.severity,
      timestamp: error.timestamp,
      canAutoFix: error.canAutoFix,
      context: error.context
    });
  });
}
