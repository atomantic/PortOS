import { spawn } from 'child_process';
import { streamDetection } from './streamingDetect.js';
import { cosEvents } from './cosEvents.js';
import { appsEvents } from './apps.js';
import { errorEvents } from '../lib/errorHandler.js';
import { handleErrorRecovery } from './autoFixer.js';
import * as pm2Standardizer from './pm2Standardizer.js';
import { notificationEvents } from './notifications.js';
import { providerStatusEvents } from './providerStatus.js';
import { agentPersonalityEvents } from './agentPersonalities.js';
import { platformAccountEvents } from './platformAccounts.js';
import { scheduleEvents } from './automationScheduler.js';
import { activityEvents } from './agentActivity.js';
import { brainEvents } from './brainStorage.js';
import { moltworldWsEvents } from './moltworldWs.js';
import { queueEvents } from './moltworldQueue.js';
import { instanceEvents } from './instanceEvents.js';
import * as shellService from './shell.js';
import {
  validateSocketData,
  detectStartSchema,
  standardizeStartSchema,
  logsSubscribeSchema,
  errorRecoverSchema,
  shellInputSchema,
  shellResizeSchema,
  shellStopSchema
} from '../lib/socketValidation.js';

// Store active log streams per socket
const activeStreams = new Map();
// Store CoS subscribers
const cosSubscribers = new Set();
// Store error subscribers for auto-fix notifications
const errorSubscribers = new Set();
// Store notification subscribers
const notificationSubscribers = new Set();
// Store agent subscribers
const agentSubscribers = new Set();
// Store instance subscribers
const instanceSubscribers = new Set();
// Store io instance for broadcasting
let ioInstance = null;

export function initSocket(io) {
  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Handle streaming app detection
    socket.on('detect:start', async (rawData) => {
      const data = validateSocketData(detectStartSchema, rawData, socket, 'detect:start');
      if (!data) return;
      console.log(`🔍 Starting detection: ${data.path}`);
      await streamDetection(socket, data.path);
    });

    // Handle PM2 standardization
    socket.on('standardize:start', async (rawData) => {
      const data = validateSocketData(standardizeStartSchema, rawData, socket, 'standardize:start');
      if (!data) return;
      const { repoPath, providerId } = data;
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
    socket.on('logs:subscribe', (rawData) => {
      const data = validateSocketData(logsSubscribeSchema, rawData, socket, 'logs:subscribe');
      if (!data) return;
      const { processName, lines } = data;

      // Clean up any existing stream for this socket
      cleanupStream(socket.id);

      console.log(`📜 Log stream started: ${processName} (${lines} lines)`);

      // Spawn pm2 logs with --raw flag
      const logProcess = spawn('pm2', ['logs', processName, '--raw', '--lines', String(lines)], {
        shell: process.platform === 'win32'
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

    // Notification subscriptions
    socket.on('notifications:subscribe', () => {
      notificationSubscribers.add(socket);
      socket.emit('notifications:subscribed');
    });

    socket.on('notifications:unsubscribe', () => {
      notificationSubscribers.delete(socket);
      socket.emit('notifications:unsubscribed');
    });

    // Agent subscriptions
    socket.on('agents:subscribe', () => {
      agentSubscribers.add(socket);
      socket.emit('agents:subscribed');
    });

    socket.on('agents:unsubscribe', () => {
      agentSubscribers.delete(socket);
      socket.emit('agents:unsubscribed');
    });

    // Instance subscriptions
    socket.on('instances:subscribe', () => {
      instanceSubscribers.add(socket);
      socket.emit('instances:subscribed');
    });

    socket.on('instances:unsubscribe', () => {
      instanceSubscribers.delete(socket);
      socket.emit('instances:unsubscribed');
    });

    // Handle error recovery requests (can trigger auto-fix agents)
    socket.on('error:recover', async (rawData) => {
      const data = validateSocketData(errorRecoverSchema, rawData, socket, 'error:recover');
      if (!data) return;
      const { code, context } = data;
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

    // Shell session handlers
    socket.on('shell:start', () => {
      const sessionId = shellService.createShellSession(socket);
      if (sessionId) {
        socket.emit('shell:started', { sessionId });
      } else {
        socket.emit('shell:error', { error: 'Failed to create shell session' });
      }
    });

    socket.on('shell:input', (rawData) => {
      const validated = validateSocketData(shellInputSchema, rawData, socket, 'shell:input');
      if (!validated) return;
      if (!shellService.writeToSession(validated.sessionId, validated.data)) {
        socket.emit('shell:error', { sessionId: validated.sessionId, error: 'Session not found' });
      }
    });

    socket.on('shell:resize', (rawData) => {
      const validated = validateSocketData(shellResizeSchema, rawData, socket, 'shell:resize');
      if (!validated) return;
      shellService.resizeSession(validated.sessionId, validated.cols, validated.rows);
    });

    socket.on('shell:stop', (rawData) => {
      const validated = validateSocketData(shellStopSchema, rawData, socket, 'shell:stop');
      if (!validated) return;
      shellService.killSession(validated.sessionId);
    });

    // Cleanup on disconnect
    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
      cleanupStream(socket.id);
      cosSubscribers.delete(socket);
      errorSubscribers.delete(socket);
      notificationSubscribers.delete(socket);
      agentSubscribers.delete(socket);
      instanceSubscribers.delete(socket);
      // Clean up any shell sessions for this socket
      const shellsClosed = shellService.cleanupSocketSessions(socket);
      if (shellsClosed > 0) {
        console.log(`🐚 Cleaned up ${shellsClosed} shell session(s)`);
      }
    });
  });

  // Store io instance for apps broadcasting
  ioInstance = io;

  // Set up CoS event forwarding to subscribers
  setupCosEventForwarding();

  // Set up error event forwarding to subscribers
  setupErrorEventForwarding();

  // Set up apps event forwarding to all clients
  setupAppsEventForwarding();

  // Set up notification event forwarding
  setupNotificationEventForwarding();

  // Set up provider status event forwarding
  setupProviderStatusEventForwarding();

  // Set up agent event forwarding
  setupAgentEventForwarding();

  // Set up brain event forwarding
  setupBrainEventForwarding();

  // Set up Moltworld WebSocket event forwarding
  setupMoltworldWsEventForwarding();

  // Set up Moltworld queue event forwarding
  setupMoltworldQueueEventForwarding();

  // Set up instance event forwarding
  setupInstanceEventForwarding();

  // Set up peer agent event forwarding
  setupPeerAgentEventForwarding();
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

// Set up apps event forwarding - broadcasts to ALL clients
function setupAppsEventForwarding() {
  appsEvents.on('changed', (data) => {
    if (ioInstance) {
      ioInstance.emit('apps:changed', data);
    }
  });
}

// Broadcast to notification subscribers only
function broadcastToNotifications(event, data) {
  for (const socket of notificationSubscribers) {
    socket.emit(event, data);
  }
}

// Set up notification event forwarding
function setupNotificationEventForwarding() {
  notificationEvents.on('added', (data) => broadcastToNotifications('notifications:added', data));
  notificationEvents.on('removed', (data) => broadcastToNotifications('notifications:removed', data));
  notificationEvents.on('updated', (data) => broadcastToNotifications('notifications:updated', data));
  notificationEvents.on('count-changed', (count) => broadcastToNotifications('notifications:count', count));
  notificationEvents.on('cleared', () => broadcastToNotifications('notifications:cleared', {}));
}

// Set up provider status event forwarding - broadcast to all clients
function setupProviderStatusEventForwarding() {
  providerStatusEvents.on('status:changed', (data) => {
    if (ioInstance) {
      ioInstance.emit('provider:status:changed', data);
    }
  });
}

// Broadcast to agent subscribers only
function broadcastToAgents(event, data) {
  for (const socket of agentSubscribers) {
    socket.emit(event, data);
  }
}

// Set up agent event forwarding
function setupAgentEventForwarding() {
  // Personality events
  agentPersonalityEvents.on('changed', (data) => broadcastToAgents('agents:personality:changed', data));

  // Account events
  platformAccountEvents.on('changed', (data) => broadcastToAgents('agents:account:changed', data));

  // Schedule events
  scheduleEvents.on('changed', (data) => broadcastToAgents('agents:schedule:changed', data));
  scheduleEvents.on('execute', (data) => broadcastToAgents('agents:schedule:execute', data));

  // Activity events
  activityEvents.on('activity', (data) => broadcastToAgents('agents:activity', data));
  activityEvents.on('activity:updated', (data) => broadcastToAgents('agents:activity:updated', data));
}

// Set up brain event forwarding - broadcast to all clients
function setupBrainEventForwarding() {
  brainEvents.on('classified', (data) => {
    if (ioInstance) {
      ioInstance.emit('brain:classified', data);
    }
  });
}

// Set up Moltworld WebSocket event forwarding to agent subscribers
function setupMoltworldWsEventForwarding() {
  moltworldWsEvents.on('status', (data) => broadcastToAgents('moltworld:status', data));
  moltworldWsEvents.on('event', (data) => broadcastToAgents('moltworld:event', data));
  moltworldWsEvents.on('presence', (data) => broadcastToAgents('moltworld:presence', data));
  moltworldWsEvents.on('thinking', (data) => broadcastToAgents('moltworld:thinking', data));
  moltworldWsEvents.on('action', (data) => broadcastToAgents('moltworld:action', data));
  moltworldWsEvents.on('interaction', (data) => broadcastToAgents('moltworld:interaction', data));
  moltworldWsEvents.on('nearby', (data) => broadcastToAgents('moltworld:nearby', data));
}

// Set up Moltworld queue event forwarding to agent subscribers
function setupMoltworldQueueEventForwarding() {
  queueEvents.on('added', (data) => broadcastToAgents('moltworld:queue:added', data));
  queueEvents.on('updated', (data) => broadcastToAgents('moltworld:queue:updated', data));
  queueEvents.on('removed', (data) => broadcastToAgents('moltworld:queue:removed', data));
}

// Broadcast to instance subscribers only
function broadcastToInstances(event, data) {
  for (const socket of instanceSubscribers) {
    socket.emit(event, data);
  }
}

// Set up instance event forwarding
function setupInstanceEventForwarding() {
  instanceEvents.on('peers:updated', (data) => broadcastToInstances('instances:peers:updated', data));
}

// Set up peer agent event forwarding (remote agent streaming)
function setupPeerAgentEventForwarding() {
  instanceEvents.on('peer:agents:updated', (data) => broadcastToInstances('instances:peer:agents:updated', data));
  instanceEvents.on('peer:agent:spawned', (data) => broadcastToInstances('instances:peer:agent:spawned', data));
  instanceEvents.on('peer:agent:updated', (data) => broadcastToInstances('instances:peer:agent:updated', data));
  instanceEvents.on('peer:agent:output', (data) => broadcastToInstances('instances:peer:agent:output', data));
  instanceEvents.on('peer:agent:completed', (data) => broadcastToInstances('instances:peer:agent:completed', data));
}
