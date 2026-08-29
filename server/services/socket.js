import { cosEvents } from './cosEvents.js';
import { appsEvents } from './apps.js';
import { errorEvents, sanitizeContext } from '../lib/errorHandler.js';
import { handleErrorRecovery } from './autoFixer.js';
import { notificationEvents } from './notifications.js';
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
import { audioGenEvents } from './audioGen/events.js';
import { aiStatusEvents } from './aiStatusEvents.js';
import { wireProactiveTriggers } from './voice/proactiveTriggers.js';
import { callStateEvents } from './voice/callSession.js';
import {
  validateSocketData,
  errorRecoverSchema
} from '../lib/socketValidation.js';
import { registerVoiceHandlers } from '../sockets/voice.js';
import { registerAppHandlers } from '../sockets/apps.js';
import { registerFableLoomHostedNamespace } from '../sockets/fableLoomHosted.js';
import { cleanupSocketStreams, registerLogHandlers } from '../sockets/logs.js';
import { detachShellSocket, registerShellHandlers } from '../sockets/shell.js';
import { getBuildId } from '../lib/buildId.js';
import { authEvents, extractToken, isAuthEnabled, verifySession } from './auth.js';
import { runEventLogEvents } from './agentRunEventLog.js';

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

function registerAuthHandlers(socket, _io) {
  // Per-event auth re-check: the handshake gate only runs once at connection
  // time, so every inbound event re-verifies an enabled session.
  if (typeof socket.use === 'function') {
    socket.use(async ([_event, ..._args], next) => {
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
}

function registerBuildHandlers(socket, _io) {
  // The bundle hash is safe to push across federated socket relays. Git
  // identity remains on the machine-local system-build API (#4694).
  socket.emit('build:id', { buildId: getBuildId() });
}

function registerImporterHandlers(socket, _io) {
  // Replay on demand because the importer UI mounts after the shared socket.
  socket.on('importer:progress:replay', () => {
    for (const frame of getImporterProgressFrames()) {
      socket.emit('importer:progress', frame);
    }
  });
}

function registerSubscriptionHandlers(socket, _io) {
  registerSubscriber(socket, 'cos', cosSubscribers);
  registerSubscriber(socket, 'errors', errorSubscribers);
  registerSubscriber(socket, 'notifications', notificationSubscribers);
  registerSubscriber(socket, 'agents', agentSubscribers);
  registerSubscriber(socket, 'instances', instanceSubscribers);
  registerSubscriber(socket, 'loops', loopSubscribers);
}

function registerErrorHandlers(socket, io) {
  socket.on('error:recover', async (rawData) => {
    try {
      const data = validateSocketData(errorRecoverSchema, rawData, socket, 'error:recover');
      if (!data) return;
      const { code, context } = data;
      console.log(`🔧 Error recovery requested: ${code}`);

      const task = await handleErrorRecovery(code, context);
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
}

function registerLifecycleHandlers(socket, _io) {
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    cleanupSocketStreams(socket.id);
    for (const set of ALL_SUBSCRIBER_SETS) set.delete(socket);
    const detached = detachShellSocket(socket);
    if (detached > 0) {
      console.log(`🐚 Detached ${detached} shell session(s) (still running)`);
    }
    socket.removeAllListeners();
  });
}

const SOCKET_HANDLER_REGISTRARS = [
  registerAuthHandlers,
  registerVoiceHandlers,
  registerBuildHandlers,
  registerImporterHandlers,
  registerAppHandlers,
  registerLogHandlers,
  registerSubscriptionHandlers,
  registerErrorHandlers,
  registerShellHandlers,
  registerLifecycleHandlers
];

function registerAuthRevocationHandler(io) {
  // Auth-state changes (first-time enable, rotation, disable) all funnel
  // through revokeAllSessions in services/auth.js. Disconnect every current
  // socket so its next event cannot use a stale handshake-time grant.
  authEvents.on('sessions:revoked-all', () => {
    console.log(`🔐 Auth state changed — disconnecting all sockets`);
    if (typeof io.disconnectSockets === 'function') io.disconnectSockets(true);
  });
}

function setupEventForwarding() {
  setupCosEventForwarding();
  setupErrorEventForwarding();
  setupAppsEventForwarding();
  setupNotificationEventForwarding();
  setupAgentEventForwarding();
  setupBrainEventForwarding();
  setupMoltworldWsEventForwarding();
  setupMoltworldQueueEventForwarding();
  setupInstanceEventForwarding();
  setupReviewEventForwarding();
  setupPeerAgentEventForwarding();
  setupUpdateEventForwarding();
  setupLoopEventForwarding();
  setupMediaGenEventForwarding();
  setupAIStatusEventForwarding();
  setupImporterEventForwarding();
  setupCatalogEventForwarding();
  setupWritersRoomEventForwarding();
  setupMusicVideoEventForwarding();
  setupProactiveSpeechForwarding();
  setupPersistentMindEventForwarding();
  setupCallStateEventForwarding();
}

let persistentMindEventForwardingSetup = false;
function setupPersistentMindEventForwarding() {
  if (persistentMindEventForwardingSetup) return;
  persistentMindEventForwardingSetup = true;
  runEventLogEvents.on('mind:event', (event) => broadcastToCos('cos:mind:event', event));
}

// The call-host tab already gets `voice:call:state` directly from its own
// socket handler (server/sockets/voice.js — it drives that socket's opening-
// line delivery too). This is the read-only fan-out to every OTHER tab, so a
// view like the Mind tab's active-call chip can show/hide without being the
// tab carrying the audio.
let callStateForwardingSetup = false;
function setupCallStateEventForwarding() {
  if (callStateForwardingSetup) return;
  callStateForwardingSetup = true;
  callStateEvents.on('state', (snapshot) => {
    if (ioInstance) ioInstance.emit('voice:call:state', snapshot);
  });
}

export function initSocket(io) {
  registerAuthRevocationHandler(io);
  registerFableLoomHostedNamespace(io);

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    for (const registerHandlers of SOCKET_HANDLER_REGISTRARS) {
      registerHandlers(socket, io);
    }
  });

  ioInstance = io;
  setupEventForwarding();
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
  // `cosTaskStore` emits this immediately for every persisted lifecycle
  // transition. Forward the task itself so focused views can update one row
  // without waiting for the file watcher to rebuild the entire task list.
  cosEvents.on('tasks:changed', (data) => broadcastToCos('cos:tasks:changed', data));
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
  cosEvents.on('persistent-mind:status', (data) => broadcastToCos('cos:mind:status', data));

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

  // Audio (first-pass music-bed, #1928/#1933) rides the same gen-event contract
  // as image/video. Forward it onto `audio-gen:*` so a user-triggered music-bed
  // render surfaces progress/failure like any other media job, rather than only
  // populating `project.musicBed` silently (or silently failing) with the user
  // left to poll the Render Queue to notice a crash/OOM/sidecar error.
  audioGenEvents.on('started', (data) => {
    if (ioInstance) ioInstance.emit('audio-gen:started', data);
  });
  audioGenEvents.on('progress', (data) => {
    if (ioInstance) ioInstance.emit('audio-gen:progress', data);
  });
  audioGenEvents.on('completed', (data) => {
    if (ioInstance) ioInstance.emit('audio-gen:completed', data);
  });
  audioGenEvents.on('failed', (data) => {
    if (ioInstance) ioInstance.emit('audio-gen:failed', data);
  });

  // Map a media-job kind to its gen-event namespace prefix. image/video/audio
  // jobs drive per-job spinners/toasts and have `*-gen:*` consumers; the shared
  // media queue also runs `training` (LoRA) jobs, which have their own UI and NO
  // `*-gen:*` listener — so they must NOT be forwarded onto the image channel
  // (returning null skips them) rather than falling through to `image-gen:*`.
  const genEvtPrefix = (kind) =>
    kind === 'video' ? 'video-gen'
      : kind === 'image' ? 'image-gen'
        : kind === 'audio' ? 'audio-gen'
          : null;

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
