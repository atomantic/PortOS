import { spawnPm2 } from './pm2.js';
import { streamDetection } from './streamingDetect.js';
import { cosEvents } from './cosEvents.js';
import { appsEvents } from './apps.js';
import { errorEvents, sanitizeContext } from '../lib/errorHandler.js';
import { handleErrorRecovery } from './autoFixer.js';
import * as pm2Standardizer from './pm2Standardizer.js';
import { notificationEvents } from './notifications.js';
import { providerStatusEvents } from './providerStatus.js';
import { agentPersonalityEvents } from './agentPersonalities.js';
import { platformAccountEvents } from './platformAccounts.js';
import { updateEvents } from './updateChecker.js';
import { scheduleEvents } from './automationScheduler.js';
import { activityEvents } from './agentActivity.js';
import { brainEvents } from './brainStorage.js';
import { moltworldWsEvents } from './moltworldWs.js';
import { queueEvents } from './moltworldQueue.js';
import { instanceEvents } from './instanceEvents.js';
import { sanitizePeerForClient } from './instances.js';
import { reviewEvents } from './review.js';
import { loopEvents } from './loops.js';
import { imageGenEvents } from './imageGenEvents.js';
import { mediaJobEvents } from './mediaJobQueue/index.js';
import { importerEvents, getImporterProgressFrames } from './importerEvents.js';
import { catalogEvents } from './catalogEvents.js';
import { writersRoomEvents } from './writersRoomEvents.js';
import { musicVideoEvents } from './musicVideo/events.js';
import { videoGenEvents } from './videoGen/events.js';
import { aiStatusEvents } from './aiStatusEvents.js';
import { wireProactiveTriggers } from './voice/proactiveTriggers.js';
import * as shellService from './shell.js';
import {
  validateSocketData,
  detectStartSchema,
  standardizeStartSchema,
  logsSubscribeSchema,
  errorRecoverSchema,
  shellInputSchema,
  shellResizeSchema,
  shellAttachSchema,
  shellStopSchema,
  appUpdateSchema,
  appStandardizeSchema,
  appDeploySchema
} from '../lib/socketValidation.js';
import * as appsService from './apps.js';
import * as appUpdater from './appUpdater.js';
import * as appDeployer from './appDeployer.js';
import { registerVoiceHandlers } from '../sockets/voice.js';
import { getBuildId } from '../lib/buildId.js';
import { authEvents, extractToken, isAuthEnabled, verifySession } from './auth.js';

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
// Store loop subscribers
const loopSubscribers = new Set();
// Store io instance for broadcasting
let ioInstance = null;

/**
 * Return the module-level Socket.IO instance (null before initSocket runs).
 * Lets services emit to clients from unattended paths (cron handlers) that
 * don't receive an `io` argument.
 */
export function getIo() {
  return ioInstance;
}

const ALL_SUBSCRIBER_SETS = [cosSubscribers, errorSubscribers, notificationSubscribers, agentSubscribers, instanceSubscribers, loopSubscribers];

function broadcastToSet(set, event, data) {
  const disconnected = [];
  for (const s of set) {
    if (!s.connected) { disconnected.push(s); continue; }
    s.emit(event, data);
  }
  for (const s of disconnected) set.delete(s);
}

function registerSubscriber(socket, namespace, set) {
  socket.on(`${namespace}:subscribe`, () => {
    set.add(socket);
    socket.emit(`${namespace}:subscribed`);
  });
  socket.on(`${namespace}:unsubscribe`, () => {
    set.delete(socket);
    socket.emit(`${namespace}:unsubscribed`);
  });
}

export function initSocket(io) {
  // Auth-state changes (first-time enable, rotation, disable) all funnel
  // through revokeAllSessions in services/auth.js, which fires this event.
  // Disconnect every currently-connected socket so clients re-handshake
  // against the fresh session store — sockets accepted before the change
  // would otherwise keep emitting privileged events on their stale
  // handshake-time auth grant.
  authEvents.on('sessions:revoked-all', () => {
    console.log(`🔐 Auth state changed — disconnecting all sockets`);
    if (typeof io.disconnectSockets === 'function') io.disconnectSockets(true);
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    // Per-event auth re-check: the handshake gate (lib/authGate.js
    // socketAuthGate) only runs once at connection time. If a session
    // expires or is revoked while the socket is open, the next inbound
    // event re-verifies and kicks the socket. Cheap (hashed-Map lookup),
    // and no-op when auth is off. Guarded for tests that pass a mock
    // socket without the `use` middleware hook.
    if (typeof socket.use === 'function') {
      socket.use(async ([_event, ..._args], next) => {
        // Fail closed: if isAuthEnabled / verifySession throw (e.g. a
        // transient settings.json read error) we MUST disconnect rather
        // than skip the check by neither calling next nor disconnecting,
        // which would silently stall the event and leave the socket
        // attached on stale credentials.
        try {
          if (!(await isAuthEnabled())) return next();
          const token = extractToken({ headers: socket.handshake?.headers || {} });
          if (await verifySession(token)) return next();
          socket.disconnect(true);
        } catch (err) {
          console.error(`❌ Socket auth middleware error: ${err?.message ?? err}`);
          socket.disconnect(true);
        }
      });
    }
    registerVoiceHandlers(socket);

    // Tell the client what build the server is on. The client compares this
    // to its own embedded <meta name="portos-build-id"> value; a mismatch
    // means the tab is running stale code against a freshly-rebuilt server
    // and the user is offered a reload.
    socket.emit('build:id', { buildId: getBuildId() });

    // Replay the in-flight importer analyze snapshot ON DEMAND so a tab that
    // (re)connects mid-analyze rebuilds its stage checklist instead of staying
    // stuck on "Starting…" — the original gate dropped every `stage` frame
    // whose run the client never saw a `start` for. Replay is request-driven
    // (not fired at `connection` time) because the socket auto-connects at app
    // load, before the lazily-mounted Importer page registers its
    // `importer:progress` listener — a connection-time replay would land
    // before any listener exists and be lost. The client requests this right
    // after registering its listener and again on every reconnect (see
    // useImporterProgress). No-op when no analyze is running (empty list).
    // `setupImporterEventForwarding` (below) keeps the snapshot fed; it's armed
    // at server start.
    socket.on('importer:progress:replay', () => {
      for (const frame of getImporterProgressFrames()) {
        socket.emit('importer:progress', frame);
      }
    });

    // Handle streaming app detection
    socket.on('detect:start', async (rawData) => {
      try {
        const data = validateSocketData(detectStartSchema, rawData, socket, 'detect:start');
        if (!data) return;
        console.log(`🔍 Starting detection: ${data.path}`);
        await streamDetection(socket, data.path);
      } catch (err) {
        const message = err?.message ?? String(err);
        console.error(`❌ Socket handler error [detect:start]: ${message}`);
        socket.emit('error:server', { message });
        socket.emit('detect:complete', { success: false, error: message });
      }
    });

    // Handle PM2 standardization — the multi-step analyze→backup→apply flow
    // lives in pm2Standardizer.runStandardizeFlow (testable + HTTP-callable);
    // the socket handler only wires progress callbacks to socket events.
    socket.on('standardize:start', async (rawData) => {
      try {
        const data = validateSocketData(standardizeStartSchema, rawData, socket, 'standardize:start');
        if (!data) return;
        const { repoPath, providerId, overwriteEcosystem = false } = data;
        console.log(`🔧 Starting PM2 standardization: ${repoPath}`);

        const outcome = await pm2Standardizer.runStandardizeFlow(repoPath, providerId, {
          overwriteEcosystem,
          onStep: ({ step, status, data }) => {
            socket.emit('standardize:step', { step, status, data, timestamp: Date.now() });
          },
          onAnalyzed: (payload) => socket.emit('standardize:analyzed', payload)
        });

        socket.emit('standardize:complete', outcome);
      } catch (err) {
        const message = err?.message ?? String(err);
        console.error(`❌ Socket handler error [standardize:start]: ${message}`);
        socket.emit('error:server', { message });
        socket.emit('standardize:complete', { success: false, error: message });
      }
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
      const logProcess = spawnPm2(['logs', processName, '--raw', '--lines', String(lines)]);

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
    registerSubscriber(socket, 'cos', cosSubscribers);

    // Error event subscriptions
    registerSubscriber(socket, 'errors', errorSubscribers);

    // Notification subscriptions
    registerSubscriber(socket, 'notifications', notificationSubscribers);

    // Agent subscriptions
    registerSubscriber(socket, 'agents', agentSubscribers);

    // Instance subscriptions
    registerSubscriber(socket, 'instances', instanceSubscribers);

    // Loop subscriptions
    registerSubscriber(socket, 'loops', loopSubscribers);

    // Handle error recovery requests (can trigger auto-fix agents)
    socket.on('error:recover', async (rawData) => {
      try {
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
      } catch (err) {
        const message = err?.message ?? String(err);
        console.error(`❌ Socket handler error [error:recover]: ${message}`);
        socket.emit('error:recover:error', { message });
      }
    });

    // App update handler — streams progress via socket
    socket.on('app:update', async (rawData) => {
      try {
        const data = validateSocketData(appUpdateSchema, rawData, socket, 'app:update');
        if (!data) return;

        const app = await appsService.getAppById(data.appId);
        if (!app) {
          socket.emit('app:update:error', { message: 'App not found' });
          return;
        }

        console.log(`⬇️ Socket update started for ${app.name}`);
        const emit = (step, status, message) => {
          socket.emit('app:update:step', { step, status, message, timestamp: Date.now() });
        };

        const result = await appUpdater.updateApp(app, emit).catch(err => {
          socket.emit('app:update:error', { message: err.message });
          return null;
        });

        if (result) {
          socket.emit('app:update:complete', { success: result.success, steps: result.steps });
          console.log(`✅ Socket update complete for ${app.name}`);
        }
      } catch (err) {
        const message = err?.message ?? String(err);
        console.error(`❌ Socket handler error [app:update]: ${message}`);
        socket.emit('app:update:error', { message });
        socket.emit('app:update:complete', { success: false, steps: [] });
      }
    });

    // App standardize handler — streams progress via socket
    socket.on('app:standardize', async (rawData) => {
      try {
        const data = validateSocketData(appStandardizeSchema, rawData, socket, 'app:standardize');
        if (!data) return;

        const app = await appsService.getAppById(data.appId);
        if (!app) {
          socket.emit('app:standardize:error', { message: 'App not found' });
          return;
        }

        console.log(`🔧 Socket standardize started for ${app.name}`);
        const emit = (step, status, message) => {
          socket.emit('app:standardize:step', { step, status, message, timestamp: Date.now() });
        };

        // Step 1: Analyze
        emit('analyze', 'running', 'Analyzing project configuration...');
        const analysis = await pm2Standardizer.analyzeApp(app.repoPath)
          .catch(err => ({ success: false, error: err.message }));

        if (!analysis.success) {
          emit('analyze', 'error', analysis.error);
          socket.emit('app:standardize:error', { message: analysis.error });
          return;
        }
        emit('analyze', 'done', `Found ${analysis.proposedChanges.processes?.length || 0} processes`);

        // Step 2: Backup
        emit('backup', 'running', 'Creating git backup...');
        const backup = await pm2Standardizer.createGitBackup(app.repoPath)
          .catch(err => ({ success: false, reason: err.message }));

        if (backup.success) {
          emit('backup', 'done', `Backup branch: ${backup.branch}`);
        } else {
          emit('backup', 'skipped', backup.reason || 'No git repository');
        }

        // Step 3: Apply
        emit('apply', 'running', 'Writing ecosystem.config.cjs...');
        const result = await pm2Standardizer.applyStandardization(app.repoPath, analysis, {
          overwriteEcosystem: data.overwriteEcosystem ?? false
        }).catch(err => ({ success: false, errors: [err.message] }));

        if (result.errors?.length > 0) {
          emit('apply', 'error', result.errors.join(', '));
          socket.emit('app:standardize:error', { message: result.errors.join(', ') });
          return;
        }
        const preserved = result.filesPreserved || [];
        emit('apply', 'done', preserved.length
          ? `Modified ${result.filesModified.length} files, preserved ${preserved.length}`
          : `Modified ${result.filesModified.length} files`);

        // Update app with new PM2 process names
        if (analysis.proposedChanges?.processes) {
          const pm2ProcessNames = analysis.proposedChanges.processes.map(p => p.name);
          await appsService.updateApp(data.appId, { pm2ProcessNames });
        }

        socket.emit('app:standardize:complete', {
          success: true,
          result: {
            backupBranch: result.backupBranch,
            filesModified: result.filesModified,
            filesPreserved: preserved,
            processes: analysis.proposedChanges.processes
          }
        });
        console.log(`✅ Socket standardize complete for ${app.name}`);
      } catch (err) {
        const message = err?.message ?? String(err);
        console.error(`❌ Socket handler error [app:standardize]: ${message}`);
        socket.emit('app:standardize:error', { message });
      }
    });

    // App deploy handler — streams real-time output from deploy.sh. The
    // app-lookup → deploy-script check → run orchestration lives in
    // appDeployer.runDeployFlow (testable + HTTP-callable); the handler only
    // forwards streamed frames and maps the terminal outcome to socket events.
    socket.on('app:deploy', async (rawData) => {
      try {
        const data = validateSocketData(appDeploySchema, rawData, socket, 'app:deploy');
        if (!data) return;

        const onOutput = (type, payload) => {
          socket.emit(`app:deploy:${type}`, { ...payload, timestamp: Date.now() });
        };

        const outcome = await appDeployer.runDeployFlow(data.appId, data.flags, { onOutput });
        if (!outcome.ok) {
          socket.emit('app:deploy:error', { message: outcome.error });
          return;
        }
        socket.emit('app:deploy:complete', { success: outcome.success, code: outcome.code });
      } catch (err) {
        const message = err?.message ?? String(err);
        console.error(`❌ Socket handler error [app:deploy]: ${message}`);
        socket.emit('app:deploy:error', { message });
      }
    });

    // Shell session handlers
    socket.on('shell:start', (options) => {
      const cwd = options?.cwd || undefined;
      const initialCommand = options?.initialCommand || undefined;
      const sessionId = shellService.createShellSession(socket, { cwd });
      if (sessionId) {
        socket.emit('shell:started', { sessionId });
        if (initialCommand) {
          setTimeout(() => shellService.writeToSession(sessionId, initialCommand + '\n'), 200);
        }
      } else {
        socket.emit('shell:error', { error: 'Failed to create shell session' });
      }
    });

    socket.on('shell:attach', (rawData) => {
      const validated = validateSocketData(shellAttachSchema, rawData, socket, 'shell:attach');
      if (!validated) return;
      const result = shellService.attachSession(validated.sessionId, socket, { claim: validated.claim });
      if (result?.claimRejected) {
        // sessionId in payload lets the client correlate this error to its pending
        // request and ignore stale errors from earlier rapid clicks.
        socket.emit('shell:error', { error: 'Session attached to another client', sessionId: validated.sessionId });
      } else if (result) {
        socket.emit('shell:attached', result);
      } else {
        socket.emit('shell:error', { error: 'Session not found', sessionId: validated.sessionId });
      }
    });

    socket.on('shell:list', () => {
      shellService.subscribeSessionList(socket);
      socket.emit('shell:sessions', shellService.listAllSessions(socket));
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

    // Client left the Shell page — release any watched TUI-run views so those
    // runs resume normal completion instead of staying paused (the persistent
    // SocketProvider socket means a navigation doesn't fire `disconnect`).
    socket.on('shell:release-views', () => {
      shellService.releaseExternalViewsForSocket(socket);
    });

    // Cleanup on disconnect — detach sessions, don't kill them
    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
      cleanupStream(socket.id);
      for (const set of ALL_SUBSCRIBER_SETS) set.delete(socket);
      const detached = shellService.detachSocketSessions(socket);
      if (detached > 0) {
        console.log(`🐚 Detached ${detached} shell session(s) (still running)`);
      }
      // Remove all event handlers registered on this socket to prevent leaks
      socket.removeAllListeners();
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

  // Set up review hub event forwarding
  setupReviewEventForwarding();

  // Set up peer agent event forwarding
  setupPeerAgentEventForwarding();

  // Set up update event forwarding
  setupUpdateEventForwarding();

  // Set up loop event forwarding
  setupLoopEventForwarding();

  // Set up image generation event forwarding
  setupMediaGenEventForwarding();

  // Set up AI status event forwarding (broadcast to all clients)
  setupAIStatusEventForwarding();

  // Set up importer stage-progress forwarding (broadcast to all clients)
  setupImporterEventForwarding();

  // Set up catalog extraction-progress forwarding (broadcast to all clients)
  setupCatalogEventForwarding();

  // Set up Writers-Room scene-image forwarding (broadcast to all clients)
  setupWritersRoomEventForwarding();

  // Set up Music Video scene reference-frame forwarding (broadcast to all clients)
  setupMusicVideoEventForwarding();

  // Wire proactive voice (CoS speaks first on high-severity errors, new tasks,
  // and high-priority notifications — rate-limited per source).
  setupProactiveSpeechForwarding();
}

// Bridge importer analyze-phase stage progress onto Socket.IO so the Importer
// page can render a live checklist while a (multi-minute, multi-pass) analyze
// runs. Single-user trust model: broadcast to all clients; each frame carries
// a `runId` so the client ignores stragglers from a prior run.
let importerForwardingSetup = false;
function setupImporterEventForwarding() {
  if (importerForwardingSetup) return;
  importerForwardingSetup = true;
  importerEvents.on('progress', (data) => {
    if (ioInstance) ioInstance.emit('importer:progress', data);
  });
}

let catalogForwardingSetup = false;
function setupCatalogEventForwarding() {
  if (catalogForwardingSetup) return;
  catalogForwardingSetup = true;
  catalogEvents.on('progress', (data) => {
    if (ioInstance) ioInstance.emit('catalog:extract:progress', data);
  });
}

let writersRoomForwardingSetup = false;
function setupWritersRoomEventForwarding() {
  if (writersRoomForwardingSetup) return;
  writersRoomForwardingSetup = true;
  // A storyboard render filed durably by writersRoomSceneImageHook — bridge it
  // so the boards update reactively without a refetch (#1363).
  writersRoomEvents.on('scene-image', (data) => {
    if (ioInstance) ioInstance.emit('writers-room:scene-image', data);
  });
}

let musicVideoForwardingSetup = false;
function setupMusicVideoEventForwarding() {
  if (musicVideoForwardingSetup) return;
  musicVideoForwardingSetup = true;
  // A scene reference-frame render filed durably by musicVideoSceneImageHook —
  // bridge it so the director board updates reactively without a refetch
  // (#1760 Phase 1b).
  musicVideoEvents.on('scene-image', (data) => {
    if (ioInstance) ioInstance.emit('music-video:scene-image', data);
  });
  // A scene i2v clip filed durably by musicVideoSceneVideoHook — bridge it so
  // the board picks up the resulting `videoHistoryId` without a refetch
  // (#1760 Phase 1).
  musicVideoEvents.on('scene-video', (data) => {
    if (ioInstance) ioInstance.emit('music-video:scene-video', data);
  });
}

let aiStatusForwardingSetup = false;
function setupAIStatusEventForwarding() {
  if (aiStatusForwardingSetup) return;
  aiStatusForwardingSetup = true;
  aiStatusEvents.on('status', (data) => {
    if (ioInstance) ioInstance.emit('ai:status', data);
  });
}

let proactiveSpeechForwardingSetup = false;
function setupProactiveSpeechForwarding() {
  if (proactiveSpeechForwardingSetup) return;
  proactiveSpeechForwardingSetup = true;
  wireProactiveTriggers({ io: ioInstance });
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
function broadcastToCos(event, data) { broadcastToSet(cosSubscribers, event, data); }

// Broadcast to error subscribers only
function broadcastToErrors(event, data) { broadcastToSet(errorSubscribers, event, data); }

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
  cosEvents.on('agent:btw', (data) => broadcastToCos('cos:agent:btw', data));

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

  // Feature agent events
  cosEvents.on('feature-agent:status', (data) => broadcastToCos('cos:feature-agent:status', data));
  cosEvents.on('feature-agent:output', (data) => broadcastToCos('cos:feature-agent:output', data));
  cosEvents.on('feature-agent:run-complete', (data) => broadcastToCos('cos:feature-agent:run-complete', data));

  // Watcher events
  cosEvents.on('watcher:started', (data) => broadcastToCos('cos:watcher:started', data));
  cosEvents.on('watcher:stopped', (data) => broadcastToCos('cos:watcher:stopped', data));

  // A user-initiated on-demand "Run" that produced no task — the client toasts
  // this so an explicit trigger that finds no actionable work (parked) isn't a
  // silent no-op.
  cosEvents.on('schedule:on-demand-empty', (data) => broadcastToCos('cos:schedule:on-demand-empty', data));
}

// Set up error event forwarding
function setupErrorEventForwarding() {
  // Forward error events to error subscribers. Use `safeContext` (second arg
  // from emitErrorEvent) — `error.context` may contain sensitive fields like
  // apiKey/token that must not be broadcast to clients. When the caller emits
  // directly (bypassing `emitErrorEvent`), `safeContext` is undefined; in that
  // case sanitize the raw context defensively rather than passing it through.
  errorEvents.on('error', (error, safeContext) => {
    const context = safeContext !== undefined
      ? safeContext
      : sanitizeContext(error.context);
    broadcastToErrors('error:notified', {
      message: error.message,
      code: error.code,
      severity: error.severity,
      timestamp: error.timestamp,
      canAutoFix: error.canAutoFix,
      context
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
function broadcastToNotifications(event, data) { broadcastToSet(notificationSubscribers, event, data); }

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
function broadcastToAgents(event, data) { broadcastToSet(agentSubscribers, event, data); }

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
function broadcastToInstances(event, data) { broadcastToSet(instanceSubscribers, event, data); }

// Set up instance event forwarding
function setupInstanceEventForwarding() {
  // Redact each peer's stored proxy password before it reaches the browser
  // (keep username + hasPassword) — same secret-stripping the GET /instances
  // route applies. `data` is the full peers array.
  instanceEvents.on('peers:updated', (data) => {
    const sanitized = Array.isArray(data) ? data.map(sanitizePeerForClient) : data;
    broadcastToInstances('instances:peers:updated', sanitized);
  });
  // Realtime sync lifecycle for the Instances cards: { phase, peerId, ... }.
  // No secrets — just a peer instanceId + counts — so forward as-is.
  instanceEvents.on('sync:progress', (data) => {
    broadcastToInstances('sync:progress', data);
  });
}

// Set up peer agent event forwarding (remote agent streaming)
function setupPeerAgentEventForwarding() {
  instanceEvents.on('peer:agents:updated', (data) => broadcastToInstances('instances:peer:agents:updated', data));
  instanceEvents.on('peer:agent:spawned', (data) => broadcastToInstances('instances:peer:agent:spawned', data));
  instanceEvents.on('peer:agent:updated', (data) => broadcastToInstances('instances:peer:agent:updated', data));
  instanceEvents.on('peer:agent:output', (data) => broadcastToInstances('instances:peer:agent:output', data));
  instanceEvents.on('peer:agent:completed', (data) => broadcastToInstances('instances:peer:agent:completed', data));
}

// Set up review event forwarding (idempotent — safe if called more than once)
let reviewForwardingSetup = false;
function setupReviewEventForwarding() {
  if (reviewForwardingSetup) return;
  reviewForwardingSetup = true;
  reviewEvents.on('item:created', (data) => {
    if (ioInstance) ioInstance.emit('review:item:created', data);
  });
  reviewEvents.on('item:updated', (data) => {
    if (ioInstance) ioInstance.emit('review:item:updated', data);
  });
  reviewEvents.on('item:deleted', (data) => {
    if (ioInstance) ioInstance.emit('review:item:deleted', data);
  });
}

// Set up update event forwarding (idempotent — safe if called more than once)
let updateForwardingSetup = false;
function setupUpdateEventForwarding() {
  if (updateForwardingSetup) return;
  updateForwardingSetup = true;
  updateEvents.on('update:available', (data) => {
    if (ioInstance) {
      ioInstance.emit('portos:update:available', data);
    }
  });
  updateEvents.on('update:checked', (data) => {
    if (ioInstance) {
      ioInstance.emit('portos:update:checked', data);
    }
  });
}

// Broadcast to loop subscribers only
function broadcastToLoops(event, data) { broadcastToSet(loopSubscribers, event, data); }

// Set up loop event forwarding (idempotent)
let loopForwardingSetup = false;
function setupLoopEventForwarding() {
  if (loopForwardingSetup) return;
  loopForwardingSetup = true;
  loopEvents.on('created', (data) => broadcastToLoops('loop:created', data));
  loopEvents.on('stopped', (data) => broadcastToLoops('loop:stopped', data));
  loopEvents.on('resumed', (data) => broadcastToLoops('loop:resumed', data));
  loopEvents.on('deleted', (data) => broadcastToLoops('loop:deleted', data));
  loopEvents.on('updated', (data) => broadcastToLoops('loop:updated', data));
  loopEvents.on('iteration:start', (data) => broadcastToLoops('loop:iteration:start', data));
  loopEvents.on('iteration:complete', (data) => broadcastToLoops('loop:iteration:complete', data));
  loopEvents.on('iteration:error', (data) => broadcastToLoops('loop:iteration:error', data));
  loopEvents.on('output', (data) => broadcastToLoops('loop:output', data));
}

// Bridge both image-gen AND video-gen events from their internal EventEmitters
// onto Socket.IO so client UIs can subscribe via `image-gen:*` / `video-gen:*`.
let mediaGenForwardingSetup = false;
function setupMediaGenEventForwarding() {
  if (mediaGenForwardingSetup) return;
  mediaGenForwardingSetup = true;
  imageGenEvents.on('started', (data) => {
    if (ioInstance) ioInstance.emit('image-gen:started', data);
  });
  imageGenEvents.on('progress', (data) => {
    if (ioInstance) ioInstance.emit('image-gen:progress', data);
  });
  imageGenEvents.on('completed', (data) => {
    if (ioInstance) ioInstance.emit('image-gen:completed', data);
  });
  imageGenEvents.on('failed', (data) => {
    if (ioInstance) ioInstance.emit('image-gen:failed', data);
  });

  videoGenEvents.on('started', (data) => {
    if (ioInstance) ioInstance.emit('video-gen:started', data);
  });
  videoGenEvents.on('progress', (data) => {
    if (ioInstance) ioInstance.emit('video-gen:progress', data);
  });
  videoGenEvents.on('completed', (data) => {
    if (ioInstance) ioInstance.emit('video-gen:completed', data);
  });
  videoGenEvents.on('failed', (data) => {
    if (ioInstance) ioInstance.emit('video-gen:failed', data);
  });

  // Map a media-job kind to its gen-event namespace prefix. Only image/video
  // jobs drive scene spinners and have `*-gen:*` consumers; the shared media
  // queue also runs `training` (LoRA) jobs, which have their own UI and NO
  // `*-gen:*` listener — so they must NOT be forwarded onto the image channel
  // (returning null skips them) rather than falling through to `image-gen:*`.
  const genEvtPrefix = (kind) =>
    kind === 'video' ? 'video-gen' : kind === 'image' ? 'image-gen' : null;

  // Bridge media-job cancellation onto a `*-gen:canceled` socket event keyed by
  // `generationId` (#1791). The internal gen modules emit started/progress/
  // completed/failed but have NO 'canceled' — a job canceled *while queued*
  // never starts a gen run, so it produces only `mediaJobEvents 'canceled'` and
  // no socket frame at all, leaving per-scene render spinners stuck until the
  // component remounts. Every client spinner already correlates by media-job id
  // (`data.generationId === jobId`), so a single id-keyed event clears the right
  // spinner across writers-room, music-video, and `useMediaJobProgress`
  // consumers (catalog et al.) uniformly — no per-domain event needed. For a
  // job canceled *while running* this fires alongside the gen module's `failed`;
  // both clear the spinner and the handlers are idempotent.
  mediaJobEvents.on('canceled', (job) => {
    if (!ioInstance || !job?.id) return;
    const prefix = genEvtPrefix(job.kind);
    if (!prefix) return;
    ioInstance.emit(`${prefix}:canceled`, { generationId: job.id });
  });

  // Bridge media-job FAILURE onto a `*-gen:failed` socket event keyed by
  // `generationId` (#1799) — the failure-side analog of the canceled bridge
  // above. A job that fails *before* the gen run starts (e.g. an unready BYOV
  // runtime throws synchronously in the queue worker, or the watchdog times the
  // job out) emits only `mediaJobEvents 'failed'` and never a `*-gen:failed`
  // frame, so the scene button stays stuck on "Rendering…". Forward it with the
  // same `{ generationId, error }` shape the gen modules use so the client's
  // `onFailed` clears the spinner and can toast the reason. For a job that fails
  // *while running* this fires alongside the gen module's own `failed`; both
  // settle the spinner to 'failed' and the handler is idempotent.
  mediaJobEvents.on('failed', (job) => {
    if (!ioInstance || !job?.id) return;
    const prefix = genEvtPrefix(job.kind);
    if (!prefix) return;
    ioInstance.emit(`${prefix}:failed`, { generationId: job.id, error: job.error });
  });
}
