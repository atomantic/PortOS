import { registerModelObservationSocket } from './modelObservation.js';
import { registerBrowserStatusSocket } from './browserStatus.js';
import { registerFleetHostSocket } from './fleetHostNotify.js';
import { spriteEvents } from './sprites/events.js';
import { modelLifecycleEvents } from './modelLifecycleEvents.js';
import { meatspaceEvents } from './meatspaceEvents.js';
import { dashboardEvents } from './dashboardEvents.js';
import { settingsEvents } from './settings.js';
import { recordEvents } from './sharing/recordEvents.js';
import { fableLoomRunEvents } from './fableLoom/runEvents.js';
import { cosEvents } from './cosEvents.js';
import { toAgentListItem } from '../lib/cosAgentListProjection.js';
import { appsEvents } from './apps.js';
import { errorEvents, sanitizeContext } from '../lib/errorHandler.js';
import { handleErrorRecovery } from './autoFixer.js';
import { notificationEvents } from './notifications.js';
import { agentPersonalityEvents } from './agentPersonalities.js';
import { platformAccountEvents } from './platformAccounts.js';
import { updateEvents } from './updateChecker.js';
import { scheduleEvents } from './automationScheduler.js';
import { activityEvents } from './agentActivity.js';
import { digitalTwinEvents } from './digital-twin-meta.js';
import { brainEvents, BRAIN_ENTITY_TYPES } from './brainStorage.js';
import { moltworldWsEvents } from './moltworldWs.js';
import { beeperSocketEvents } from './beeperSocketEvents.js';
import { queueEvents } from './moltworldQueue.js';
import { instanceEvents } from './instanceEvents.js';
import { sanitizePeerForClient } from './instances.js';
import { attachTailcatForwardsToPeers } from './tailcatPeer.js';
import { reviewEvents } from './review.js';
import { loopEvents } from './loops.js';
import { imageGenEvents } from './imageGenEvents.js';
import { trainingEvents } from './loraTraining/events.js';
import { mediaPromptHistoryEvents } from './mediaPromptHistory.js';
import { mediaJobEvents } from './mediaJobQueue/index.js';
import { importerEvents, getImporterProgressFrames } from './importerEvents.js';
import { catalogEvents } from './catalogEvents.js';
import { writersRoomEvents } from './writersRoomEvents.js';
import { musicVideoEvents } from './musicVideo/events.js';
import { videoGenEvents } from './videoGen/events.js';
import { audioGenEvents } from './audioGen/events.js';
import { aiStatusEvents } from './aiStatusEvents.js';
import { usageBackfillEvents } from './usageBackfillEvents.js';
import { eidoverseWorldEvents } from './eidoverseWorldEvents.js';
import { jevEvents } from './jevEvents.js';
import { layaMlxEvents } from './layaMlxEvents.js';
import { providerQuotaEvents } from './providerQuotaEvents.js';
import { wireProactiveTriggers } from './voice/proactiveTriggers.js';
import { callStateEvents } from './voice/callSession.js';
import {
  validateSocketData,
  errorRecoverSchema
} from '../lib/socketValidation.js';
import { registerEidoverseTravelHandlers } from '../sockets/eidoverseTravel.js';
import { registerVoiceHandlers } from '../sockets/voice.js';
import { registerProcessHandlers } from '../sockets/processes.js';
import { registerAgentProcessHandlers } from '../sockets/agentProcesses.js';
import { registerAppHandlers } from '../sockets/apps.js';
import { registerFableLoomHostedNamespace } from '../sockets/fableLoomHosted.js';
import { cleanupSocketStreams, registerLogHandlers } from '../sockets/logs.js';
import { detachShellSocket, registerShellHandlers } from '../sockets/shell.js';
import { detachItermSocket, registerItermHandlers } from '../sockets/iterm.js';
import { getBuildId } from '../lib/buildId.js';
import { authEvents, isAuthEnabled, verifyRequestSession } from './auth.js';
import { HOST_CONTROL_FORBIDDEN_MESSAGE, socketHasHostControl } from './authGate.js';
import { runEventLogEvents } from './agentRunEventLog.js';
import { armSystemActivityWatchers, bindSystemActivityIo } from './systemActivityNotify.js';
import { armReadinessWatchers, registerReadinessSocket } from './readinessNotify.js';

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
const codeAnimationSubscribers = new Set();
// Store Beeper realtime subscribers (#33). Invalidation frames and transport
// liveness ONLY — see setupBeeperEventForwarding for why this may never be a
// global emit.
const beeperSubscribers = new Set();
const fableLoomSubscribers = new Set();
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

const ALL_SUBSCRIBER_SETS = [cosSubscribers, errorSubscribers, notificationSubscribers, agentSubscribers, instanceSubscribers, loopSubscribers, codeAnimationSubscribers, beeperSubscribers, fableLoomSubscribers];

export function emitCodeAnimationChanged(id) {
  broadcastToSet(codeAnimationSubscribers, 'code-animation:changed', { id });
}

function broadcastToSet(set, event, data) {
  const disconnected = [];
  for (const s of set) {
    if (!s.connected) { disconnected.push(s); continue; }
    s.emit(event, data);
  }
  for (const s of disconnected) set.delete(s);
}

function registerSubscriber(socket, namespace, set) {
  socket.on(`${namespace}:subscribe`, (options) => {
    if (namespace === 'cos' && ['invalidate', 'full'].includes(options?.taskLists)) socket.cosTaskLists = options.taskLists;
    set.add(socket);
    socket.emit(`${namespace}:subscribed`);
  });
  socket.on(`${namespace}:unsubscribe`, () => {
    set.delete(socket);
    socket.emit(`${namespace}:unsubscribed`);
  });
}

// A peer relay (server/services/peerSocketRelay.js) authenticates the socket
// handshake with the paired peer token or the legacy Basic password (#8386) —
// never a session — so it can never satisfy the per-event re-check below on
// its own. This is the ONLY carve-out: a minimal, read-only allowlist of the
// subscribe/unsubscribe events the relay needs to receive `cos:agent:*`
// broadcasts. Every other event, including any `shell:*`/host-control event,
// still requires a real operator session and disconnects a peer-authenticated
// socket exactly as it did before. Keep this list minimal — do not add a
// mutating or host-affecting event here.
const PEER_RELAY_ALLOWED_EVENTS = new Set(['cos:subscribe', 'cos:unsubscribe']);

// Events that execute on the host — an interactive PTY, keystrokes into the
// user's live iTerm2 sessions, or git/npm/PM2/deploy runs in a managed app's
// directory. They need the same operator authority as the HTTP
// requireHostControl routes (#8226): on a password-free install a remote
// LAN/tailnet socket is refused (#8708). Every `shell:*` and `iterm:*` event
// is included by prefix; read-only subscriptions stay open to remote sockets.
// `error:recover` queues a recovery agent that runs shell commands (#8716).
// The HTTP twin of this set is HOST_CONTROL_ROUTES in lib/hostControlRoutes.js.
const HOST_CONTROL_SOCKET_EVENTS = new Set(['app:update', 'app:standardize', 'app:deploy', 'standardize:start', 'error:recover']);
const HOST_CONTROL_SOCKET_PREFIXES = ['shell:', 'iterm:'];
const isHostControlSocketEvent = (event) => typeof event === 'string'
  && (HOST_CONTROL_SOCKET_EVENTS.has(event) || HOST_CONTROL_SOCKET_PREFIXES.some((prefix) => event.startsWith(prefix)));

// A refusal goes out on the error event the event's own client already
// listens on, so the waiting UI settles instead of hanging.
const hostControlRefusal = (event, payload) => {
  const refusal = { code: 'HOST_CONTROL_FORBIDDEN', error: HOST_CONTROL_FORBIDDEN_MESSAGE, message: HOST_CONTROL_FORBIDDEN_MESSAGE };
  if (event.startsWith('shell:')) return ['shell:error', { ...refusal, sessionId: payload?.sessionId }];
  if (event.startsWith('iterm:')) return ['iterm:error', { ...refusal, id: payload?.id }];
  if (event === 'standardize:start') return ['standardize:complete', { success: false, ...refusal }];
  return [`${event}:error`, { ...refusal, appId: payload?.appId }];
};

function registerAuthHandlers(socket, _io) {
  // Per-event auth re-check: the handshake gate only runs once at connection
  // time, so every inbound event re-verifies an enabled session. With auth
  // off, host-control events still need a local connection.
  if (typeof socket.use === 'function') {
    socket.use(async ([event, payload], next) => {
      try {
        if (!(await isAuthEnabled())) {
          if (!isHostControlSocketEvent(event) || socketHasHostControl(socket)) return next();
          console.warn(`⛔ Refused host-control socket event ${event} from a non-local connection`);
          socket.emit(...hostControlRefusal(event, payload));
          return;
        }
        if (await verifyRequestSession({ headers: socket.handshake?.headers || {} })) return next();
        const peerAuthMethod = socket.data?.portosAuthMethod;
        if ((peerAuthMethod === 'peer' || peerAuthMethod === 'basic') && PEER_RELAY_ALLOWED_EVENTS.has(event)) {
          return next();
        }
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
  registerSubscriber(socket, 'code-animation', codeAnimationSubscribers);
  registerSubscriber(socket, 'beeper', beeperSubscribers);
  registerSubscriber(socket, 'fableloom', fableLoomSubscribers);
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
    detachItermSocket(socket);
    socket.removeAllListeners();
  });
}

const SOCKET_HANDLER_REGISTRARS = [
  registerAuthHandlers,
  registerReadinessSocket,
  registerModelObservationSocket,
  registerBrowserStatusSocket,
  registerFleetHostSocket,
  registerVoiceHandlers,
  registerBuildHandlers,
  registerImporterHandlers,
  registerAppHandlers,
  registerProcessHandlers,
  registerAgentProcessHandlers,
  registerLogHandlers,
  registerSubscriptionHandlers,
  registerEidoverseTravelHandlers,
  registerErrorHandlers,
  registerShellHandlers,
  registerItermHandlers,
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

const noPayload = () => ({});

// 1:1 emitter → Socket.IO bridges. `payload` maps the event args to the frame;
// omitted means forward the first argument unchanged.
const SIMPLE_BRIDGES = [
  { emitter: modelLifecycleEvents, event: 'image-to-3d:changed', channel: 'image-to-3d:changed' },
  { emitter: modelLifecycleEvents, event: 'threejs-model:changed', channel: 'threejs-model:changed' },
  { emitter: meatspaceEvents, event: 'death-clock:changed', channel: 'meatspace:death-clock:changed' },
  { emitter: meatspaceEvents, event: 'changed', channel: 'meatspace:changed' },
  { emitter: usageBackfillEvents, event: 'updated', channel: 'usage-backfill:updated', payload: noPayload },
  { emitter: eidoverseWorldEvents, event: 'updated', channel: 'eidoverse:projection', payload: noPayload },
  { emitter: jevEvents, event: 'status', channel: 'jev:status', payload: noPayload },
  { emitter: jevEvents, event: 'stats', channel: 'jev:stats', payload: noPayload },
  { emitter: jevEvents, event: 'heads', channel: 'jev:heads', payload: noPayload },
  { emitter: layaMlxEvents, event: 'updated', channel: 'laya:status', payload: noPayload },
  { emitter: providerQuotaEvents, event: 'updated', channel: 'provider-quota:updated', payload: noPayload },
  // Importer analyze-phase stage progress; each frame carries a `runId` so the
  // client ignores stragglers from a prior run.
  { emitter: importerEvents, event: 'progress', channel: 'importer:progress' },
  { emitter: catalogEvents, event: 'progress', channel: 'catalog:extract:progress' },
  { emitter: aiStatusEvents, event: 'status', channel: 'ai:status' },
  // The call-host tab already gets `voice:call:state` from its own socket
  // handler (server/sockets/voice.js); this fans it out to every OTHER tab.
  { emitter: callStateEvents, event: 'state', channel: 'voice:call:state' },
  // A storyboard render filed durably by writersRoomSceneImageHook (#1363).
  { emitter: writersRoomEvents, event: 'scene-image', channel: 'writers-room:scene-image' },
  // Scene reference frame / i2v clip filed durably by the music-video hooks
  // (#1760), an opt-in auto-review run advancing (#8988), and a server-owned
  // production run advancing (#9066) — all without a client refetch.
  { emitter: musicVideoEvents, event: 'scene-image', channel: 'music-video:scene-image' },
  { emitter: musicVideoEvents, event: 'scene-video', channel: 'music-video:scene-video' },
  { emitter: musicVideoEvents, event: 'auto-review', channel: 'music-video:auto-review' },
  { emitter: musicVideoEvents, event: 'production', channel: 'music-video:production' },
  // A fully-autonomous run (prompt → lyrics → Suno song → video) advancing.
  { emitter: musicVideoEvents, event: 'autonomous', channel: 'music-video:autonomous' },
  { emitter: musicVideoEvents, event: 'song-revision', channel: 'music-video:song-revision' },
  // The Cast & Sets check-in advancing, and a development artifact changing.
  { emitter: musicVideoEvents, event: 'cast-and-sets', channel: 'music-video:cast-and-sets' },
  { emitter: musicVideoEvents, event: 'dev-artifact', channel: 'music-video:dev-artifact' },
];

let forwardingRegistered = false;

// Registers every process-wide emitter → Socket.IO bridge exactly once, however
// many times initSocket runs. Forwarders read the module-level `ioInstance` at
// emit time (never capture `io`), so a re-init forwards through the latest io.
// A bridge only goes live by being listed here or in SIMPLE_BRIDGES.
function setupEventForwarding() {
  if (forwardingRegistered) return;
  forwardingRegistered = true;
  for (const { emitter, event, channel, payload } of SIMPLE_BRIDGES) {
    emitter.on(event, (...args) => ioInstance?.emit(channel, payload ? payload(...args) : args[0]));
  }
  runEventLogEvents.on('mind:event', (event) => broadcastToCos('cos:mind:event', event));
  setupCosEventForwarding();
  setupErrorEventForwarding();
  setupAppsEventForwarding();
  setupNotificationEventForwarding();
  setupAgentEventForwarding();
  setupBrainEventForwarding();
  setupDigitalTwinEventForwarding();
  setupMoltworldWsEventForwarding();
  setupMoltworldQueueEventForwarding();
  setupInstanceEventForwarding();
  setupReviewEventForwarding();
  setupPeerAgentEventForwarding();
  setupUpdateEventForwarding();
  setupLoopEventForwarding();
  setupMediaGenEventForwarding();
  setupProactiveSpeechForwarding();
  setupBeeperEventForwarding();
  setupRecordEventForwarding();
  setupFableLoomRunForwarding();
}

// Bounded invalidations only: records remain behind their existing HTTP gates.
function setupRecordEventForwarding() {
  const forward = ({ recordKind, recordId }) => {
    if (recordKind === 'creativeDirectorProject') {
      ioInstance?.emit('creative-director:project:changed', { id: recordId });
    } else if (recordKind === 'creativeCommission') {
      ioInstance?.emit('commission:changed', { id: recordId });
    }
  };
  recordEvents.on('updated', forward);
  recordEvents.on('deleted', forward);
  recordEvents.on('invalidated', forward);
}

export function initSocket(io) {
  registerAuthRevocationHandler(io);
  registerFableLoomHostedNamespace(io);

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    // Each registrar hangs its own per-socket cleanup on 'disconnect' (13+
    // today), past Node's default cap of 10 — which warned on every connect.
    socket.setMaxListeners(50);
    for (const registerHandlers of SOCKET_HANDLER_REGISTRARS) {
      registerHandlers(socket, io);
    }
  });

  ioInstance = io;
  setupEventForwarding();
  // Invalidation only. Clients coalesce the frame into one bounded activity
  // read; a missed frame is repaired by the reconnect read, not by polling.
  bindSystemActivityIo(io);
  armReadinessWatchers().catch((err) => {
    console.error(`❌ Readiness watchers failed: ${err.message}`);
  });
  armSystemActivityWatchers().catch((err) => {
    console.error(`❌ system activity watchers failed: ${err.message}`);
  });
}

function setupProactiveSpeechForwarding() {
  wireProactiveTriggers({ io: ioInstance });
}

// Broadcast to all connected clients
export function broadcast(io, event, data) {
  io.emit(event, data);
}

// Test-only seam (mirrors the `__testing` convention in authGate.js): lets an
// integration test wire the real per-event auth re-check onto a live
// Socket.IO server without pulling in every other registrar's dependencies.
export const __testing = { registerAuthHandlers, PEER_RELAY_ALLOWED_EVENTS, registerSubscriptionHandlers };

// Broadcast to CoS subscribers only
function broadcastToCos(event, data) {
  if (!['cos:tasks:user:changed', 'cos:tasks:cos:changed', 'cos:tasks:changed'].includes(event)) {
    broadcastToSet(cosSubscribers, event, data);
    return;
  }
  for (const socket of cosSubscribers) {
    if (!socket.connected) { cosSubscribers.delete(socket); continue; }
    const completedChanged = event === 'cos:tasks:changed' && (data?.task?.status === 'completed'
      || data?.previousStatus === 'completed' || ['deleted', 'peer-merged'].includes(data?.action));
    socket.emit(event, socket.cosTaskLists === 'invalidate'
      ? { invalidated: true, ...(completedChanged ? { completedChanged: true } : {}) } : data);
  }
}

// Broadcast to error subscribers only
function broadcastToErrors(event, data) { broadcastToSet(errorSubscribers, event, data); }

// Environment changes need no Mind turn. Coalesce bursts into one bounded,
// payload-free invalidation and send it only to existing CoS subscribers.
let mindVisibilityTimer = null;
function invalidateMindVisibility() {
  if (!cosSubscribers.size || mindVisibilityTimer) return;
  mindVisibilityTimer = setTimeout(() => {
    mindVisibilityTimer = null;
    broadcastToCos('cos:mind:visibility', { invalidated: true });
  }, 250);
  mindVisibilityTimer.unref?.();
}

// Process-wide listeners forward through the current IO and subscriber sets.
function setupCosEventForwarding() {
  // Dashboard invalidations deliberately omit decisions, prompts and settings.
  for (const event of ['goals:changed', 'backup:changed']) {
    dashboardEvents.on(event, () => ioInstance?.emit(event, {}));
  }
  for (const event of ['cos:schedule:changed', 'cos:decisions:changed', 'cos:day:changed']) {
    dashboardEvents.on(event, () => broadcastToCos(event, {}));
  }
  settingsEvents.on('settings:updated', () => {
    ioInstance?.emit('backup:changed', {});
    ioInstance?.emit('jev:policy', {});
  });
  // A failed restore also invalidates policy: clients must show the strict
  // read failure instead of continuing to offer stale safety settings.
  settingsEvents.on('settings:invalidated', () => ioInstance?.emit('jev:policy', {}));
  for (const [source, target] of [
    ['scheduler:scheduled', 'cos:scheduler:changed'],
    ['scheduler:ran', 'cos:scheduler:changed'],
    ['scheduler:cancelled', 'cos:scheduler:changed'],
    ['agents:changed', 'cos:agents:changed'],
    ['storage:changed', 'cos:storage:changed'],
    ['learning:changed', 'cos:learning:changed'],
  ]) {
    cosEvents.on(source, data => {
      broadcastToCos(target, {});
      if (target === 'cos:scheduler:changed' && data?.id === 'backup-daily') {
        ioInstance?.emit('backup:changed', {});
      }
    });
  }
  // Status events
  cosEvents.on('goals:changed', data => broadcastToCos('cos:goals:changed', data));
  cosEvents.on('status', (data) => broadcastToCos('cos:status', data));
  for (const event of ['config:changed', 'status:paused', 'status:resumed']) {
    cosEvents.on(event, data => broadcastToCos(`cos:${event}`, data));
  }

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

  cosEvents.on('maintenance:updated', (data) => broadcastToCos('cos:maintenance:updated', data));

  // Agent events. These three carry a whole agent RECORD, and every consumer —
  // the CoS agents list, the task-update hook, the peer relay — treats it as a
  // list row. So they leave through the same projection as `GET /api/cos/agents`:
  // no transcript (that is the separate `agent:output` stream) and a bounded task
  // description. Without it the socket refills the very list the listing
  // projection just shrank, and ships a 50 KB pasted prompt to every subscriber —
  // including, through the relay, a peer. Projected HERE rather than at the emit
  // because the server-side `cosEvents` listeners need the whole record.
  cosEvents.on('agent:spawned', (data) => broadcastToCos('cos:agent:spawned', toAgentListItem(data)));
  cosEvents.on('agent:updated', (data) => broadcastToCos('cos:agent:updated', toAgentListItem(data)));
  cosEvents.on('agent:completed', (data) => broadcastToCos('cos:agent:completed', toAgentListItem(data)));
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
  // Programmatic scheduled handlers report what they actually did — no agent
  // task is created, so there is nothing else for the user to watch.
  cosEvents.on('schedule:on-demand-handled', (data) => broadcastToCos('cos:schedule:on-demand-handled', data));
  for (const event of ['config:changed', 'status', 'status:paused', 'status:resumed',
    'agent:spawned', 'agent:updated', 'agent:completed', 'health:check', 'health:critical']) {
    cosEvents.on(event, invalidateMindVisibility);
  }
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
    invalidateMindVisibility();
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

// Forward only invalidations, never private traits, interview text or settings.
// All status/settings writers save meta; sync also signals after document I/O.
function setupDigitalTwinEventForwarding() {
  for (const event of ['meta:changed', 'sync:completed', 'traits:updated', 'taste:profile-updated', 'interview:analyzed']) {
    digitalTwinEvents.on(event, () => ioInstance?.emit('digital-twin:changed', {}));
  }
}

// Set up brain event forwarding - broadcast to all clients
function setupBrainEventForwarding() {
  // Invalidation only: record bodies, local paths and settings stay behind HTTP.
  const changed = (type, id) => {
    ioInstance?.emit('brain:changed', { type, id });
    if (type === 'links') ioInstance?.emit('brain:links:changed', { id });
  };
  for (const type of BRAIN_ENTITY_TYPES) {
    brainEvents.on(`${type}:upserted`, ({ id }) => changed(type, id));
    brainEvents.on(`${type}:deleted`, ({ id }) => changed(type, id));
  }
  brainEvents.on('record:changed', ({ type, id }) => changed(type, id));
  brainEvents.on('meta:changed', () => changed('meta'));

  brainEvents.on('classified', (data) => {
    if (ioInstance) {
      ioInstance.emit('brain:classified', data);
    }
  });
  brainEvents.on('threads:upserted', (data) => {
    if (ioInstance) ioInstance.emit('brain:threads:changed', data);
  });
  brainEvents.on('threads:deleted', (data) => {
    if (ioInstance) ioInstance.emit('brain:threads:changed', data);
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
  // Invalidation only: the copyable serve capability stays behind the status API.
  instanceEvents.on('tailcat:serve:changed', () => ioInstance?.emit('tailcat:serve:changed', {}));
  // Redact each peer's stored proxy password before it reaches the browser
  // (keep username + hasPassword) — same secret-stripping the GET /instances
  // route applies. `data` is the full peers array.
  instanceEvents.on('peers:updated', (data) => {
    const sanitized = Array.isArray(data) ? data.map(sanitizePeerForClient) : data;
    // Best-effort attach; never block the broadcast if forward metadata is busy.
    Promise.resolve(Array.isArray(sanitized) ? attachTailcatForwardsToPeers(sanitized) : sanitized)
      .then((enriched) => broadcastToInstances('instances:peers:updated', enriched))
      .catch(() => broadcastToInstances('instances:peers:updated', sanitized));
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

// Set up review event forwarding
function setupReviewEventForwarding() {
  // Global invalidations reach the bell/dashboard even without a CoS room
  // subscription. They carry no record payload and are never peer-forwarded.
  for (const event of ['tasks:changed', 'tasks:user:changed', 'tasks:cos:changed', 'agent:completed', 'agent:feedback', 'memory:approved', 'memory:rejected']) {
    cosEvents.on(event, () => {
      if (ioInstance) ioInstance.emit('review:queue:changed');
    });
  }
  reviewEvents.on('queue:changed', () => {
    if (ioInstance) ioInstance.emit('review:queue:changed');
  });
  reviewEvents.on('item:created', (data) => {
    if (ioInstance) ioInstance.emit('review:item:created', data?.metadata?.privateSecurity ? { id: data.id, metadata: { privateSecurity: true } } : data);
  });
  reviewEvents.on('item:updated', (data) => {
    if (ioInstance) ioInstance.emit('review:item:updated', data?.metadata?.privateSecurity ? { id: data.id, metadata: { privateSecurity: true } } : data);
  });
  reviewEvents.on('item:deleted', (data) => {
    if (ioInstance) ioInstance.emit('review:item:deleted', data?.metadata?.privateSecurity ? { id: data.id, metadata: { privateSecurity: true } } : data);
  });
  // Bulk status changes ("Mark all read" / "Complete all") carry only ids, a
  // status and a timestamp — nothing to redact.
  reviewEvents.on('items:bulk-updated', (data) => {
    if (ioInstance) ioInstance.emit('review:items:bulk-updated', data);
  });
}

// Set up update event forwarding
function setupUpdateEventForwarding() {
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

// Broadcast to Beeper subscribers only
function broadcastToBeeper(event, data) { broadcastToSet(beeperSubscribers, event, data); }

// Bridge the server's Beeper WebSocket onto Socket.IO (#33, decided on #12).
//
// THIS MUST NEVER BE `ioInstance.emit`. `peerSocketRelay.js` opens a Socket.IO
// CLIENT to every online peer, so a global emit crosses the wire to other
// installs — the boundary pinned at socket.test.js (#4694). Beeper message
// content is PII and machine-local (#7's ADR), so the frames here carry
// invalidation only: ids, kinds and transport liveness, never bodies, display
// names or handles. The browser refetches from the PortOS mirror.
function setupBeeperEventForwarding() {
  beeperSocketEvents.on('invalidate', (data) => broadcastToBeeper('beeper:invalidate', data));
  beeperSocketEvents.on('state', (data) => broadcastToBeeper('beeper:realtime', data));
}

// Set up loop event forwarding
function setupLoopEventForwarding() {
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
function setupMediaGenEventForwarding() {
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

  spriteEvents.on('changed', ({ recordId }) => {
    ioInstance?.emit('sprites:changed', { recordId });
  });
  // Queue lifecycle events carry the persisted job's routing tags. Generation
  // transport events can precede the queue's terminal state, so do not use them.
  for (const event of ['enqueued', 'started', 'completed', 'failed', 'canceled']) {
    mediaJobEvents.on(event, (job) => {
      for (const tagKey of ['spriteRef', 'spriteWalk', 'spriteAnimation']) {
        const recordId = job.params?.[tagKey]?.recordId;
        if (recordId) ioInstance?.emit('sprites:jobs-changed', { recordId, kind: job.kind, tagKey });
      }
    });
  }

  mediaJobEvents.on('reference-sheet:changed', ({ universeId, entryId, jobId, variant, status }) => {
    ioInstance?.emit('reference-sheet:changed', { universeId, entryId, jobId, variant, status });
  });
  mediaJobEvents.on('changed', () => {
    ioInstance?.emit('media-jobs:changed', {});
  });
  trainingEvents.on('dataset:changed', ({ datasetId }) => {
    ioInstance?.emit('training:dataset:changed', { datasetId });
  });
  trainingEvents.on('checkpoints:changed', ({ runId }) => {
    ioInstance?.emit('training:checkpoints:changed', { runId });
  });

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
  mediaPromptHistoryEvents.on('changed', () => { ioInstance?.emit('media-prompt-history:changed', {}); });

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

function setupFableLoomRunForwarding() {
  fableLoomRunEvents.on('editorial', run => {
    broadcastToSet(fableLoomSubscribers, 'fableloom:editorial:run', run);
  });
  fableLoomRunEvents.on('production', run => {
    broadcastToSet(fableLoomSubscribers, 'fableloom:production:run', run);
  });
}
