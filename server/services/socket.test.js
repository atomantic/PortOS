import { jevEvents } from './jevEvents.js';
import { spriteEvents } from './sprites/events.js';
import { modelLifecycleEvents } from './modelLifecycleEvents.js';
import { meatspaceEvents, invalidateMeatspace } from './meatspace/meatspaceEvents.js';
import { dashboardEvents } from './dashboardEvents.js';
import { settingsEvents } from './settings.js';
import { emitRecordUpdated, emitRecordDeleted, emitRecordInvalidated } from './sharing/recordEvents.js';
import { writeOriginScope } from '../lib/writeOrigin.js';
import { fableLoomRunEvents } from './fableLoom/runEvents.js';
import { trainingEvents } from './loraTraining/events.js';
import { authEvents, isAuthEnabled, verifyRequestSession } from './auth.js';
import { verifyPeerToken } from './authGate.js';
import { usageBackfillEvents } from './usageBackfillEvents.js';
import { eidoverseWorldEvents } from './eidoverseWorldEvents.js';
import { layaMlxEvents } from './layaMlxEvents.js';
import { providerQuotaEvents } from './provider/providerQuotaEvents.js';
import { codeAnimationEvents, emitCodeAnimationFilm } from './codeAnimation/events.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Preserve installed once-only listeners across Vitest's per-test mock-call
// clearing, just as the process-wide event buses retain their subscriptions.
const queueListeners = vi.hoisted(() => ({ cos: [], review: [], brain: [], twin: [], errors: [] }));

/**
 * Tests for socket.js initSocket behavior.
 *
 * Strategy: mock all heavy imports at the system boundary (PM2, file I/O,
 * external services) so we can call the real initSocket and verify its
 * subscription / broadcast / disconnect behavior through observable socket events.
 */

vi.mock('./pm2.js', () => ({
  spawnPm2: vi.fn(() => ({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() })),
  buildEnv: vi.fn((pm2Home) => ({ PATH: '/usr/bin', ...(pm2Home ? { PM2_HOME: pm2Home } : {}) }))
}));
vi.mock('./streamingDetect.js', () => ({ streamDetection: vi.fn() }));
vi.mock('./cos/cosEvents.js', () => ({ cosEvents: { on: vi.fn((...args) => queueListeners.cos.push(args)) }, emitLog: vi.fn() }));
vi.mock('./apps.js', () => ({ appsEvents: { on: vi.fn() }, getAppById: vi.fn(), notifyAppsChanged: vi.fn(), updateApp: vi.fn() }));
vi.mock('./appProcessStatus.js', () => ({ resolvePm2HomeForProcess: vi.fn() }));
// logAction appends to the real history file — mock it or this suite writes to data/.
vi.mock('./history.js', () => ({ logAction: vi.fn(async () => {}) }));
vi.mock('../lib/errorHandler.js', () => ({ errorEvents: { on: vi.fn((...args) => queueListeners.errors.push(args)) } }));
vi.mock('./autoFixer.js', () => ({ handleErrorRecovery: vi.fn() }));
vi.mock('./pm2Standardizer.js', () => ({ analyzeApp: vi.fn(), createGitBackup: vi.fn(), applyStandardization: vi.fn(), runStandardizeFlow: vi.fn(), standardizeRefusalFor: vi.fn(() => null) }));
vi.mock('./notifications.js', () => ({ notificationEvents: { on: vi.fn() }, getNotifications: vi.fn(async () => []) }));
vi.mock('./updateChecker.js', () => ({ updateEvents: { on: vi.fn() } }));
// Pin the bundle hash so the assertion does not depend on whether a dist
// happens to exist in the checkout the suite runs from.
vi.mock('../lib/buildId.js', () => ({ getBuildId: vi.fn(() => 'test-build-id') }));
vi.mock('./digital-twin-meta.js', () => ({ digitalTwinEvents: { on: vi.fn((...args) => queueListeners.twin.push(args)) } }));
vi.mock('./brainStorage.js', () => ({ BRAIN_ENTITY_TYPES: ['links', 'inbox', 'memories'], brainEvents: { on: vi.fn((...args) => queueListeners.brain.push(args)) } }));
vi.mock('./moltworldWs.js', () => ({ moltworldWsEvents: { on: vi.fn() } }));
vi.mock('./moltworldQueue.js', () => ({ queueEvents: { on: vi.fn() } }));
// The Beeper realtime bus is a real EventEmitter here — the relay boundary test
// below drives it directly to prove where its frames land (and where they don't).
vi.mock('./beeper/beeperSocketEvents.js', async () => {
  const { EventEmitter } = await import('events');
  return { beeperSocketEvents: new EventEmitter() };
});
vi.mock('./instanceEvents.js', async () => ({ instanceEvents: new (await import('node:events')).EventEmitter() }));
import { instanceEvents } from './instanceEvents.js';
vi.mock('./auth.js', async (importActual) => ({
  ...(await importActual()),
  isAuthEnabled: vi.fn(async () => false),
  verifyRequestSession: vi.fn(async () => false),
}));
vi.mock('./authGate.js', async (importActual) => ({ ...(await importActual()), verifyPeerToken: vi.fn(async () => null) }));
vi.mock('./tailcatPeer.js', () => ({ attachTailcatForwardsToPeers: vi.fn(async (peers) => peers) }));
import { attachTailcatForwardsToPeers } from './tailcatPeer.js';
vi.mock('./review.js', () => ({ reviewEvents: { on: vi.fn((...args) => queueListeners.review.push(args)) } }));
vi.mock('./loops.js', () => ({ loopEvents: { on: vi.fn() } }));
vi.mock('./shell.js', () => ({
  createShellSession: vi.fn(),
  submitToSession: vi.fn(),
  attachSession: vi.fn(),
  subscribeSessionList: vi.fn(),
  listAllSessions: vi.fn(() => []),
  writeToSession: vi.fn(),
  changeSessionDirectory: vi.fn(() => true),
  getSession: vi.fn(() => null),
  resizeSession: vi.fn(),
  killSession: vi.fn(),
  unsubscribeSessionList: vi.fn(),
  detachSocketSessions: vi.fn(() => 0)
}));
// The shell:start provider-launch path resolves a stored provider. Mock the
// service (not lib/tuiShellLaunch.js) so the REAL command+env resolution runs.
vi.mock('./provider/providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../lib/socketValidation.js', () => ({
  validateSocketData: vi.fn((schema, data) => data),
  detectStartSchema: {},
  standardizeStartSchema: {},
  logsSubscribeSchema: {},
  logsUnsubscribeSchema: {},
  errorRecoverSchema: {},
  shellInputSchema: {},
  shellCdSchema: {},
  shellResizeSchema: {},
  shellAttachSchema: {},
  shellStopSchema: {},
  shellStartSchema: {},
  appUpdateSchema: {},
  appStandardizeSchema: {},
  appDeploySchema: {}
}));
vi.mock('./appUpdater.js', () => ({ updateApp: vi.fn() }));
vi.mock('./appDeployer.js', () => ({ hasDeployScript: vi.fn(), deployApp: vi.fn(), runDeployFlow: vi.fn() }));
vi.mock('../sockets/voice.js', () => ({ registerVoiceHandlers: vi.fn() }));

import { broadcastToCommandSubscribers, initSocket } from './socket.js';
import { spawnPm2 } from './pm2.js';
import { getAppById, notifyAppsChanged } from './apps.js';
import { resolvePm2HomeForProcess } from './appProcessStatus.js';
import { logAction } from './history.js';
import { beeperSocketEvents } from './beeper/beeperSocketEvents.js';
import { mediaJobEvents } from './mediaJobQueue/index.js';
import { audioGenEvents } from './audioGen/events.js';
import { imageGenEvents } from './imageGenEvents.js';
import { videoGenEvents } from './videoGen/events.js';
import { detachSocketSessions } from './shell.js';
import * as shellService from './shell.js';
import { getProviderById } from './provider/providers.js';
import { updateApp as runAppUpdate } from './appUpdater.js';
import { analyzeApp, standardizeRefusalFor } from './pm2Standardizer.js';
import { registerVoiceHandlers } from '../sockets/voice.js';

// Build a minimal fake socket with per-event handler capture
function makeSocket(id = 'sock-1') {
  const handlers = {};
  const emitted = [];
  return {
    id,
    connected: true,
    handlers,
    emitted,
    on(event, fn) { handlers[event] = fn; },
    emit(event, ...args) { emitted.push([event, ...args]); },
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    join(room) { this.rooms.push(room); },
    rooms: [],
    data: {},
    handshake: { headers: {} }
  };
}

// Build a minimal fake io that captures the connection handler
function makeIo() {
  let connectionHandler = null;
  const emitted = [];
  const excepted = [];
  return {
    connectionHandler: () => connectionHandler,
    emit(event, ...args) { emitted.push([event, ...args]); },
    except(room) { return { emit: (event, ...args) => { emitted.push([event, ...args]); excepted.push([event, room]); } }; },
    excepted,
    emitted,
    on(event, fn) {
      if (event === 'connection') connectionHandler = fn;
    },
    connect(socket) {
      if (connectionHandler) connectionHandler(socket);
    }
  };
}

describe('socket.js — initSocket', () => {
  let io;
  const createdSockets = [];

  afterEach(() => {
    for (const s of createdSockets) {
      if (s.handlers['disconnect']) s.handlers['disconnect']();
    }
    createdSockets.length = 0;
    authEvents.removeAllListeners('sessions:revoked-all');
  });

  it('coalesces environment changes into payload-free Mind visibility invalidations for subscribers', () => {
    vi.useFakeTimers();
    const subscriber = makeSocket('mind-subscriber');
    const outsider = makeSocket('mind-outsider');
    createdSockets.push(subscriber, outsider);
    io.connect(subscriber);
    io.connect(outsider);
    subscriber.handlers['cos:subscribe']();
    try {
      for (const name of ['config:changed', 'agent:spawned', 'agent:completed', 'health:check']) {
        queueListeners.cos.filter(([event]) => event === name).forEach(([, handler]) => handler({ privateContent: 'example private record' }));
      }
      vi.advanceTimersByTime(249);
      expect(subscriber.emitted.filter(([name]) => name === 'cos:mind:visibility')).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(subscriber.emitted.filter(([name]) => name === 'cos:mind:visibility')).toEqual([
        ['cos:mind:visibility', { invalidated: true }],
      ]);
      expect(outsider.emitted.filter(([name]) => name === 'cos:mind:visibility')).toEqual([]);
      subscriber.handlers['cos:unsubscribe']();
      queueListeners.cos.filter(([event]) => event === 'health:check').forEach(([, handler]) => handler({}));
      vi.advanceTimersByTime(60_000);
      expect(subscriber.emitted.filter(([name]) => name === 'cos:mind:visibility')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates peer sockets from operator cos events and global operator broadcasts', () => {
    const operator = makeSocket('operator');
    const peer = makeSocket('peer');
    peer.data.portosAuthMethod = 'peer';
    createdSockets.push(operator, peer);
    io.connect(operator);
    io.connect(peer);
    operator.handlers['cos:subscribe']();
    peer.handlers['cos:subscribe']();
    expect(peer.rooms).toContain('peer-sockets');
    expect(operator.rooms).not.toContain('peer-sockets');
    io.emitted.length = 0;
    const emitCos = (name, payload) =>
      queueListeners.cos.filter(([event]) => event === name).forEach(([, handler]) => handler(payload));
    emitCos('memory:created', { id: 'example-memory' });
    emitCos('agent:output', { agentId: 'example-agent', line: 'x' });
    expect(operator.emitted.map(([n]) => n)).toEqual(expect.arrayContaining(['cos:memory:created', 'cos:agent:output']));
    expect(peer.emitted.map(([n]) => n).filter((n) => n.startsWith('cos:') && !n.endsWith(':subscribed')))
      .toEqual(['cos:agent:output']);
    queueListeners.brain.filter(([event]) => event === 'classified').forEach(([, handler]) => handler({ entryId: 'example' }));
    expect(io.emitted).toContainEqual(['brain:classified', { entryId: 'example' }]);
    expect(io.excepted).toContainEqual(['brain:classified', 'peer-sockets']);
  });

  it('invalidates active memories after approval/rejection only for CoS subscribers', () => {
    const subscriber = makeSocket('memory-subscriber');
    const outsider = makeSocket('memory-outsider');
    createdSockets.push(subscriber, outsider);
    io.connect(subscriber);
    io.connect(outsider);
    subscriber.handlers['cos:subscribe']();
    for (const event of ['memory:approved', 'memory:rejected']) {
      queueListeners.cos.filter(([name]) => name === event).forEach(([, handler]) =>
        handler({ id: 'example-memory', memory: { content: 'Example record body' } }));
    }
    expect(subscriber.emitted.filter(([name]) => name === 'cos:memory:updated')).toEqual([
      ['cos:memory:updated', { id: 'example-memory' }],
      ['cos:memory:updated', { id: 'example-memory' }],
    ]);
    expect(outsider.emitted.filter(([name]) => name === 'cos:memory:updated')).toEqual([]);
  });

  it('forwards model identity invalidations through the existing socket transport', () => {
    io.emitted.length = 0;
    modelLifecycleEvents.emit('image-to-3d:changed', { id: 'example-image-model' });
    modelLifecycleEvents.emit('threejs-model:changed', { id: 'example-procedural-model' });
    expect(io.emitted).toEqual([
      ['image-to-3d:changed', { id: 'example-image-model' }],
      ['threejs-model:changed', { id: 'example-procedural-model' }],
    ]);
  });

  it('forwards Tailcat status invalidation without its serve capability', () => {
    io.emitted.length = 0;
    instanceEvents.emit('tailcat:serve:changed', { tcAddress: 'tcEXAMPLE-private', lastError: 'Example diagnostic' });
    expect(io.emitted).toEqual([['tailcat:serve:changed', {}]]);
  });

  it('forwards historical usage progress without worker details', () => {
    io.emitted.length = 0;
    usageBackfillEvents.emit('updated', { metadataPath: '/example/private-run.json' });
    expect(io.emitted).toEqual([['usage-backfill:updated', {}]]);
  });

  it('invalidates Jev policy and memory status after an unreadable settings restore without forwarding content', () => {
    io.emitted.length = 0;
    settingsEvents.emit('settings:invalidated', { privateContent: 'Example settings' });
    expect(io.emitted).toEqual([['memory:models:changed', {}], ['jev:policy', {}]]);
  });

  it('invalidates Eidoverse projection progress without world content', () => {
    io.emitted.length = 0;
    eidoverseWorldEvents.emit('updated', { world: 'Example private world' });
    expect(io.emitted).toEqual([['eidoverse:projection', {}]]);
  });

  it('forwards JEV resource invalidations without private scorer data', () => {
    io.emitted.length = 0;
    for (const resource of ['status', 'stats', 'heads']) {
      jevEvents.emit(resource, { premise: 'Example private input', corpus: ['Example row'] });
    }
    expect(io.emitted).toEqual([['jev:status', {}], ['jev:stats', {}], ['jev:heads', {}]]);
  });

  it('forwards Laya status without experiment content', () => {
    io.emitted.length = 0;
    layaMlxEvents.emit('updated', { premise: 'Example private experiment' });
    expect(io.emitted).toEqual([['laya:status', {}]]);
  });

  it('forwards quota completion without leaking source data', () => {
    io.emitted.length = 0;
    providerQuotaEvents.emit('updated', { privateContent: 'example account detail' });
    expect(io.emitted).toEqual([['provider-quota:updated', {}]]);
  });

  it('forwards fleet billing invalidation without billing or quota data', () => {
    io.emitted.length = 0;
    settingsEvents.emit('usage:fleet-billing-updated', { privateContent: 'synthetic account detail' });
    expect(io.emitted).toEqual([['usage:fleet-billing-updated', {}]]);
  });

  it('forwards death-clock invalidations without personal data', () => {
    io.emitted.length = 0;
    meatspaceEvents.emit('death-clock:changed', {});
    expect(io.emitted).toEqual([['meatspace:death-clock:changed', {}]]);
  });

  it('delivers operator command output only to command subscribers, never to every socket (#12019)', () => {
    const subscriber = makeSocket('command-subscriber');
    const cosOnly = makeSocket('cos-only-relay');
    const bystander = makeSocket('bystander');
    io.connect(subscriber);
    io.connect(cosOnly);
    io.connect(bystander);
    createdSockets.push(subscriber, cosOnly, bystander);
    subscriber.handlers['command:subscribe']();
    // A peer relay is limited to cos:subscribe by PEER_RELAY_ALLOWED_EVENTS.
    cosOnly.handlers['cos:subscribe']();
    io.emitted.length = 0;

    broadcastToCommandSubscribers('command:example-id:data', { data: 'TOKEN=[REDACTED]', stream: 'stdout' });
    broadcastToCommandSubscribers('command:example-id:complete', { success: true, exitCode: 0 });

    expect(subscriber.emitted).toContainEqual(['command:example-id:data', { data: 'TOKEN=[REDACTED]', stream: 'stdout' }]);
    expect(subscriber.emitted).toContainEqual(['command:example-id:complete', { success: true, exitCode: 0 }]);
    expect(cosOnly.emitted.some(([event]) => event.startsWith('command:'))).toBe(false);
    expect(bystander.emitted.some(([event]) => event.startsWith('command:'))).toBe(false);
    expect(io.emitted).toEqual([]);

    subscriber.handlers['command:unsubscribe']();
    subscriber.emitted.length = 0;
    broadcastToCommandSubscribers('command:example-id:data', { data: 'after', stream: 'stdout' });
    expect(subscriber.emitted.some(([event]) => event.startsWith('command:'))).toBe(false);
  });

  it('forwards dashboard invalidations without source records and gates CoS events on subscription', () => {
    const subscriber = makeSocket('dashboard-subscriber');
    const other = makeSocket('dashboard-other');
    io.connect(subscriber);
    io.connect(other);
    createdSockets.push(subscriber, other);
    subscriber.handlers['cos:subscribe']();
    for (const [source, target] of [
      ['scheduler:scheduled', 'cos:scheduler:changed'],
      ['scheduler:ran', 'cos:scheduler:changed'], ['scheduler:cancelled', 'cos:scheduler:changed'],
      ['agents:changed', 'cos:agents:changed'], ['learning:changed', 'cos:learning:changed'],
    ]) {
      queueListeners.cos.find(([event]) => event === source)[1]({ privateContent: 'Example private record' });
      expect(subscriber.emitted).toContainEqual([target, {}]);
      expect(other.emitted.some(([event]) => event === target)).toBe(false);
    }
    dashboardEvents.emit('cos:day:changed');
    expect(subscriber.emitted).toContainEqual(['cos:day:changed', {}]);
    expect(other.emitted.some(([event]) => event === 'cos:day:changed')).toBe(false);
    queueListeners.cos.find(([event]) => event === 'scheduler:ran')[1]({ id: 'cos-pending-merge-sweep', privateContent: 'Example private record' });
    expect(subscriber.emitted).toContainEqual(['cos:scheduler:changed', { id: 'cos-pending-merge-sweep' }]);
    dashboardEvents.emit('cos:decisions:changed');
    expect(subscriber.emitted).toContainEqual(['cos:decisions:changed', {}]);
    expect(other.emitted.some(([event]) => event === 'cos:decisions:changed')).toBe(false);
    dashboardEvents.emit('cos:schedule:changed');
    expect(subscriber.emitted).toContainEqual(['cos:schedule:changed', {}]);
    expect(other.emitted.some(([event]) => event === 'cos:schedule:changed')).toBe(false);
    io.emitted.length = 0;
    dashboardEvents.emit('goals:changed', { privateContent: 'Example goal' });
    dashboardEvents.emit('backup:changed', { destPath: '/private/example' });
    expect(io.emitted).toEqual([['goals:changed', {}], ['backup:changed', {}]]);
  });

  it('retains one CoS/dashboard/settings subscription and forwards through the latest IO after reinitialization', () => {
    const previousIo = io;
    const settingsCount = settingsEvents.listenerCount('settings:updated');
    const dashboardCounts = dashboardEvents.eventNames().map(event => [event, dashboardEvents.listenerCount(event)]);
    const cosCount = queueListeners.cos.length;
    // Every real emitter setupEventForwarding bridges, plus the mocked queues.
    const emitters = [meatspaceEvents, modelLifecycleEvents, eidoverseWorldEvents, layaMlxEvents, jevEvents, providerQuotaEvents, usageBackfillEvents, instanceEvents];
    const snapshot = () => [
      emitters.map(emitter => emitter.eventNames().map(event => [event, emitter.listenerCount(event)])),
      Object.entries(queueListeners).map(([name, list]) => [name, list.length]),
    ];
    const before = snapshot();
    io = makeIo();
    initSocket(io);
    initSocket(io);
    expect(snapshot()).toEqual(before);
    io.emitted.length = 0;
    jevEvents.emit('status');
    meatspaceEvents.emit('changed', { resources: ['body'] });
    expect(io.emitted).toEqual([['jev:status', {}], ['meatspace:changed', { resources: ['body'] }]]);
    io.emitted.length = 0;
    expect(settingsEvents.listenerCount('settings:updated')).toBe(settingsCount);
    expect(dashboardEvents.eventNames().map(event => [event, dashboardEvents.listenerCount(event)])).toEqual(dashboardCounts);
    expect(queueListeners.cos).toHaveLength(cosCount);

    const subscriber = makeSocket('reinitialized-cos');
    createdSockets.push(subscriber);
    io.connect(subscriber);
    subscriber.handlers['cos:subscribe']();
    subscriber.emitted.length = 0;
    previousIo.emitted.length = 0;
    io.emitted.length = 0;
    const memoryClassifier = { providerId: 'ollama', model: 'qwen3:8b' };
    settingsEvents.emit('settings:updated', { memoryClassifier, privateContent: 'Example settings' });
    expect(io.emitted).toEqual([['memory:models:changed', {}], ['backup:changed', {}], ['jev:policy', {}]]);
    expect(io.excepted).toContainEqual(['memory:models:changed', 'peer-sockets']);
    io.emitted.length = 0;
    settingsEvents.emit('settings:updated', { memoryClassifier, privateContent: 'Unrelated settings edit' });
    expect(io.emitted).toEqual([['backup:changed', {}], ['jev:policy', {}]]);
    dashboardEvents.emit('goals:changed', { privateContent: 'Example goal' });
    dashboardEvents.emit('cos:day:changed', { privateContent: 'Example day' });
    const taskChange = { action: 'updated', task: { id: 'example-task', status: 'pending' } };
    queueListeners.cos.filter(([event]) => event === 'tasks:changed').forEach(([, handler]) => handler(taskChange));
    expect(io.emitted).toEqual([['backup:changed', {}], ['jev:policy', {}], ['goals:changed', {}], ['review:queue:changed']]);
    expect(previousIo.emitted).toEqual([]);
    expect(subscriber.emitted).toEqual([
      ['cos:day:changed', {}],
      ['cos:tasks:changed', taskChange],
    ]);
  });

  it('forwards Digital Twin changes without leaking source records', () => {
    io.emitted.length = 0;
    for (const event of ['meta:changed', 'sync:completed', 'traits:updated', 'taste:profile-updated', 'interview:analyzed', 'feedback:submitted', 'feedback:weights-recalculated']) {
      const handler = queueListeners.twin.find(([name]) => name === event)?.[1];
      expect(handler).toBeTypeOf('function');
      handler({ privateContent: 'example private record' });
    }
    expect(io.emitted).toEqual(Array.from({ length: 7 }, () => ['digital-twin:changed', {}]));
  });

  it('forwards bounded MeatSpace invalidations once after repeated initialization', () => {
    initSocket(io);
    io.emitted.length = 0;
    invalidateMeatspace(['body', 'blood']);
    expect(io.emitted).toEqual([['meatspace:changed', { resources: ['body', 'blood'] }]]);
  });

  it('forwards persisted Brain changes as bounded invalidations', () => {
    const dispatch = (event, payload) => {
      const listener = queueListeners.brain.find(([name]) => name === event)?.[1];
      expect(listener).toBeTypeOf('function');
      listener(payload);
    };
    io.emitted.length = 0;
    dispatch('links:upserted', { id: 'example-link', record: { localPath: '/private/example', malwareScan: { status: 'completed' } } });
    expect(io.emitted).toEqual([
      ['brain:changed', { type: 'links', id: 'example-link' }],
      ['brain:links:changed', { id: 'example-link' }]
    ]);
    io.emitted.length = 0;
    dispatch('record:changed', { type: 'links', id: 'remote-link' });
    dispatch('meta:changed', { defaultProvider: 'example' });
    expect(io.emitted).toContainEqual(['brain:links:changed', { id: 'remote-link' }]);
    expect(io.emitted).toContainEqual(['brain:changed', { type: 'meta', id: undefined }]);
  });

  beforeEach(() => {
    vi.mocked(detachSocketSessions).mockClear();
    vi.mocked(registerVoiceHandlers).mockClear();
    io = makeIo();
    initSocket(io);
  });

  it.each(['success', 'failure'])('discards obsolete peer enrichment after a newer removal (%s)', async (outcome) => {
    const subscriber = makeSocket('peer-subscriber');
    createdSockets.push(subscriber);
    io.connect(subscriber);
    subscriber.handlers['instances:subscribe']();
    let resolveFirst;
    let rejectFirst;
    vi.mocked(attachTailcatForwardsToPeers).mockImplementationOnce(() => new Promise((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    }));
    const oldPeers = [{ id: 'example-removed-peer', transport: 'tailcat' }];
    instanceEvents.emit('peers:updated', oldPeers);
    instanceEvents.emit('peers:updated', []);
    await new Promise(setImmediate);
    expect(subscriber.emitted.filter(([name]) => name === 'instances:peers:updated')).toEqual([
      ['instances:peers:updated', []],
    ]);
    if (outcome === 'success') resolveFirst(oldPeers);
    else rejectFirst(new Error('Example forward metadata failure'));
    await new Promise(setImmediate);
    expect(subscriber.emitted.filter(([name]) => name === 'instances:peers:updated')).toEqual([
      ['instances:peers:updated', []],
    ]);
  });

  it('delivers ordinary enriched peer updates and sanitizes the newest enrichment failure', async () => {
    const subscriber = makeSocket('peer-subscriber');
    const outsider = makeSocket('peer-outsider');
    createdSockets.push(subscriber, outsider);
    io.connect(subscriber);
    io.connect(outsider);
    subscriber.handlers['instances:subscribe']();
    const peers = [{ id: 'example-peer', transport: 'tailcat', auth: { username: 'example', password: 'synthetic-secret' }, syncSecret: 'synthetic-sync-secret', tcAddress: 'tcEXAMPLE' }];
    vi.mocked(attachTailcatForwardsToPeers).mockImplementationOnce(async (sanitized) =>
      sanitized.map((peer) => ({ ...peer, tailcatForward: { id: 'example-forward' } })));
    instanceEvents.emit('peers:updated', peers);
    await new Promise(setImmediate);
    const [sanitized] = vi.mocked(attachTailcatForwardsToPeers).mock.calls.at(-1)[0];
    expect(sanitized.auth).toEqual({ username: 'example', hasPassword: true });
    expect(sanitized).not.toHaveProperty('syncSecret');
    expect(sanitized).not.toHaveProperty('tcAddress');
    expect(subscriber.emitted.filter(([name]) => name === 'instances:peers:updated')).toEqual([
      ['instances:peers:updated', [{ ...sanitized, tailcatForward: { id: 'example-forward' } }]],
    ]);
    vi.mocked(attachTailcatForwardsToPeers).mockRejectedValueOnce(new Error('Example forward metadata failure'));
    instanceEvents.emit('peers:updated', peers);
    await new Promise(setImmediate);
    expect(subscriber.emitted.filter(([name]) => name === 'instances:peers:updated').at(-1)).toEqual([
      'instances:peers:updated', [sanitized],
    ]);
    expect(outsider.emitted.some(([name]) => name === 'instances:peers:updated')).toBe(false);
    expect(peers[0].auth.password).toBe('synthetic-secret');
  });

  it('forwards bounded project, commission, storyboard and sidebar-record invalidations from structural and local-only writes', () => {
    emitRecordUpdated('creativeDirectorProject', 'cd-example');
    emitRecordDeleted('creativeDirectorProject', 'cd-example');
    emitRecordInvalidated('creativeDirectorProject', 'cd-example');
    emitRecordInvalidated('creativeCommission', 'cc-example');
    emitRecordUpdated('storyboard', 'sb-example');
    emitRecordDeleted('storyboard', 'sb-example');
    emitRecordInvalidated('storyboard', 'sb-example');
    emitRecordUpdated('series', 'series-example');
    emitRecordDeleted('universe', 'universe-example');
    emitRecordUpdated('musicVideoProject', 'mv-example');
    // A write made for a tab's request names that tab's socket, so it can skip refetching its own change.
    writeOriginScope({ get: () => 'socket-example' }, {}, () => emitRecordUpdated('musicVideoProject', 'mv-own'));
    writeOriginScope({ get: () => 'not a socket id!' }, {}, () => emitRecordUpdated('musicVideoProject', 'mv-unlabeled'));
    emitRecordUpdated('unrelated', 'example');
    expect(io.emitted.filter(([name]) => name === 'pipeline-series:changed')).toEqual([
      ['pipeline-series:changed', { id: 'series-example' }],
    ]);
    expect(io.emitted.filter(([name]) => name === 'universe:changed')).toEqual([
      ['universe:changed', { id: 'universe-example' }],
    ]);
    expect(io.emitted.filter(([name]) => name === 'music-video:project:changed')).toEqual([
      ['music-video:project:changed', { id: 'mv-example' }],
      ['music-video:project:changed', { id: 'mv-own', origin: 'socket-example' }],
      ['music-video:project:changed', { id: 'mv-unlabeled' }],
    ]);
    expect(io.emitted.filter(([name]) => name === 'creative-director:project:changed')).toEqual(
      Array.from({ length: 3 }, () => ['creative-director:project:changed', { id: 'cd-example' }]),
    );
    expect(io.emitted.filter(([name]) => name === 'commission:changed')).toEqual([
      ['commission:changed', { id: 'cc-example' }],
    ]);
    expect(io.emitted.filter(([name]) => name === 'storyboard:changed')).toEqual(
      Array.from({ length: 3 }, () => ['storyboard:changed', { id: 'sb-example' }]),
    );
  });

  it('delivers FableLoom snapshots only to subscribed operator views', () => {
    const viewer = makeSocket('loom-viewer');
    const peer = makeSocket('peer-relay');
    createdSockets.push(viewer, peer);
    io.connect(viewer); io.connect(peer);
    viewer.handlers['fableloom:subscribe']();
    const run = { id: 'run-example', loomId: 'loom-example', revision: 1 };
    fableLoomRunEvents.emit('editorial', run);
    fableLoomRunEvents.emit('production', run);
    fableLoomRunEvents.emit('shots', run);
    fableLoomRunEvents.emit('export', run);
    expect(viewer.emitted).toContainEqual(['fableloom:editorial:run', run]);
    expect(viewer.emitted).toContainEqual(['fableloom:production:run', run]);
    expect(viewer.emitted).toContainEqual(['fableloom:shots:run', run]);
    expect(viewer.emitted).toContainEqual(['fableloom:export:job', run]);
    expect(peer.emitted.some(([name]) => name.startsWith('fableloom:'))).toBe(false);
    expect(io.emitted.some(([name]) => name.startsWith('fableloom:'))).toBe(false);
    viewer.handlers['fableloom:unsubscribe']();
    const count = viewer.emitted.length;
    fableLoomRunEvents.emit('editorial', run);
    expect(viewer.emitted).toHaveLength(count);
  });

  it('sends compact task invalidations to opted-in pages while preserving legacy subscribers', () => {
    const compact = makeSocket('compact-cos');
    const legacy = makeSocket('legacy-cos');
    createdSockets.push(compact, legacy);
    io.connect(compact); io.connect(legacy);
    compact.handlers['cos:subscribe']({ taskLists: 'invalidate' });
    compact.handlers['cos:subscribe'](); // another shared consumer must not widen it
    legacy.handlers['cos:subscribe']();
    const payload = { task: { id: 'example', status: 'in_progress', metadata: { prompt: 'large private prompt' } } };
    const forwardChange = queueListeners.cos.find(([event]) => event === 'tasks:changed')[1];
    forwardChange(payload);
    expect(compact.emitted).toContainEqual(['cos:tasks:changed', { invalidated: true }]);
    expect(legacy.emitted).toContainEqual(['cos:tasks:changed', payload]);
    forwardChange({ task: { id: 'done', status: 'completed' } });
    expect(compact.emitted).toContainEqual(['cos:tasks:changed', { invalidated: true, completedChanged: true }]);
    forwardChange({ task: { id: 'live', status: 'in_progress' } });
    expect(compact.emitted.at(-1)).toEqual(['cos:tasks:changed', { invalidated: true }]);
    forwardChange({ activityOnly: 'preflight', task: { id: 'preflight-1', preflightActive: true, metadata: { prompt: 'private' } } });
    expect(compact.emitted.at(-1)).toEqual(['cos:tasks:changed', { invalidated: true, task: { id: 'preflight-1', preflightActive: true } }]);
  });

  it('composes every per-feature handler registrar for a connected socket', () => {
    const socket = makeSocket('registrars');
    createdSockets.push(socket);
    io.connect(socket);

    expect(registerVoiceHandlers).toHaveBeenCalledWith(socket, io);
    expect(Object.keys(socket.handlers)).toEqual(expect.arrayContaining([
      'importer:progress:replay',
      'detect:start',
      'standardize:start',
      'logs:subscribe',
      'logs:unsubscribe',
      'cos:subscribe',
      'cos:unsubscribe',
      'errors:subscribe',
      'errors:unsubscribe',
      'notifications:subscribe',
      'notifications:unsubscribe',
      'agents:subscribe',
      'agents:unsubscribe',
      'instances:subscribe',
      'instances:unsubscribe',
      'loops:subscribe',
      'loops:unsubscribe',
      'beeper:subscribe',
      'beeper:unsubscribe',
      'media-jobs:subscribe',
      'media-jobs:unsubscribe',
      'error:recover',
      'app:update',
      'app:standardize',
      'app:operations:list',
      'app:deploy',
      'shell:start',
      'shell:attach',
      'shell:list',
      'shell:input',
      'shell:cd',
      'shell:resize',
      'shell:stop',
      'shell:release-views',
      'disconnect'
    ]));
  });

  // ===========================================================================
  // cos:subscribe — socket joins cosSubscribers, receives cos:subscribed ack
  // ===========================================================================
  it('pushes only the bundle id at connection time, never the git identity (#4694)', async () => {
    // THE federation boundary for the socket half. `connection` fires for every
    // socket, and peerSocketRelay.js opens a Socket.IO CLIENT to every online
    // peer — so this handler runs for other installs' relays too, and anything
    // pushed here leaves the machine. The commit is served over the API instead
    // (GET /api/system/build), which peers do not call.
    const socket = makeSocket('build-push');
    createdSockets.push(socket);
    io.connect(socket);
    await Promise.resolve();

    const pushed = socket.emitted.filter(([ev]) => ev === 'build:id');
    expect(pushed).toHaveLength(1);
    expect(pushed[0][1]).toEqual({ buildId: 'test-build-id' });

    // No commit, branch, or dirty flag anywhere in what this socket received,
    // and no handler a peer could call to ask for one.
    expect(JSON.stringify(socket.emitted)).not.toContain('main');
    expect(JSON.stringify(socket.emitted)).not.toContain('abc1234');
    expect(Object.keys(socket.handlers)).not.toContain('build:identity');
  });

  // ===========================================================================
  // beeper:* — the Beeper relay boundary (#33, decided on #12)
  // ===========================================================================
  it('relays Beeper frames only to beeper subscribers, never through a global emit (#33)', () => {
    // Same federation boundary as the build:id test above, from the other
    // direction: `ioInstance.emit` reaches peerSocketRelay's client sockets, so
    // a global Beeper emit would push another install's frames onto this one's
    // wire. Message content is machine-local PII, so the relay is a subscriber
    // Set — and even the frames it carries are ids-only.
    const subscriber = makeSocket('beeper-sub');
    const bystander = makeSocket('beeper-bystander');
    createdSockets.push(subscriber, bystander);
    io.connect(subscriber);
    io.connect(bystander);
    subscriber.handlers['beeper:subscribe']();

    beeperSocketEvents.emit('invalidate', { kind: 'message.upserted', chatID: 'chat-1', ids: ['m1'], seq: 7, ts: null });
    beeperSocketEvents.emit('state', { state: 'connected', lastEventAt: null, lastPingAt: null });

    expect(subscriber.emitted.filter(([ev]) => ev === 'beeper:invalidate')).toHaveLength(1);
    expect(subscriber.emitted.filter(([ev]) => ev === 'beeper:realtime')).toHaveLength(1);
    // A connected socket that never subscribed sees nothing — that is what a
    // peer relay's socket looks like from here.
    expect(bystander.emitted.some(([ev]) => String(ev).startsWith('beeper:'))).toBe(false);
    // And nothing Beeper-shaped ever went through io.emit.
    expect(io.emitted.some(([ev]) => String(ev).startsWith('beeper:'))).toBe(false);
    expect(JSON.stringify(io.emitted)).not.toContain('chat-1');
  });

  it('forwards codeAnimationEvents changed to code-animation subscribers (#16905)', () => {
    const subscriber = makeSocket('code-anim-sub');
    const bystander = makeSocket('code-anim-bystander');
    createdSockets.push(subscriber, bystander);
    io.connect(subscriber);
    io.connect(bystander);
    subscriber.handlers['code-animation:subscribe']();

    codeAnimationEvents.emit('changed', { id: 'anim-1', kind: 'poster' });

    expect(subscriber.emitted).toContainEqual(['code-animation:changed', { id: 'anim-1', kind: 'poster' }]);
    expect(bystander.emitted.some(([ev]) => String(ev).startsWith('code-animation:'))).toBe(false);
  });

  it('forwards emitCodeAnimationFilm to code-animation subscribers only (#17619)', () => {
    const subscriber = makeSocket('code-anim-film-sub');
    const bystander = makeSocket('code-anim-film-bystander');
    createdSockets.push(subscriber, bystander);
    io.connect(subscriber);
    io.connect(bystander);
    subscriber.handlers['code-animation:subscribe']();

    emitCodeAnimationFilm('film-1', { kind: 'state', phase: 'sync' });

    expect(subscriber.emitted).toContainEqual(['code-animation:film', { projectId: 'film-1', kind: 'state', phase: 'sync' }]);
    expect(bystander.emitted.some(([ev]) => String(ev).startsWith('code-animation:'))).toBe(false);
    expect(io.emitted.some(([ev]) => String(ev).startsWith('code-animation:'))).toBe(false);
  });

  it('socket receives cos:subscribed ack after emitting cos:subscribe', () => {
    const socket = makeSocket('sub-1');
    io.connect(socket);

    // Trigger the cos:subscribe handler registered by registerSubscriber
    socket.handlers['cos:subscribe']();

    expect(socket.emitted.some(([ev]) => ev === 'cos:subscribed')).toBe(true);
  });

  it('socket receives cos:unsubscribed ack after emitting cos:unsubscribe', () => {
    const socket = makeSocket('sub-2');
    io.connect(socket);

    socket.handlers['cos:subscribe']();
    socket.handlers['cos:unsubscribe']();

    expect(socket.emitted.some(([ev]) => ev === 'cos:unsubscribed')).toBe(true);
  });

  it('forwards submitted feedback only to CoS subscribers', () => {
    const subscriber = makeSocket('feedback-subscriber');
    const other = makeSocket('feedback-other');
    createdSockets.push(subscriber, other);
    io.connect(subscriber);
    io.connect(other);
    subscriber.handlers['cos:subscribe']();
    const payload = { agentId: 'example-agent', feedback: { rating: 'positive', comment: null, submittedAt: '2026-07-13T12:00:00.000Z' } };
    const listener = queueListeners.cos.find(([event]) => event === 'agent:feedback')?.[1];
    listener(payload);
    expect(subscriber.emitted).toContainEqual(['cos:agent:feedback', payload]);
    expect(other.emitted.some(([event]) => event === 'cos:agent:feedback')).toBe(false);
    expect(io.emitted.some(([event]) => event === 'cos:agent:feedback')).toBe(false);
  });

  it('forwards task lifecycle changes with the task payload to CoS subscribers', () => {
    const socket = makeSocket('task-events');
    createdSockets.push(socket);
    io.connect(socket);
    socket.handlers['cos:subscribe']();

    const listener = queueListeners.cos.find(([event]) => event === 'tasks:changed')?.[1];
    const payload = {
      type: 'user',
      action: 'updated',
      previousStatus: 'pending',
      task: { id: 'task-1', status: 'in_progress' }
    };
    listener(payload);

    expect(socket.emitted).toContainEqual(['cos:tasks:changed', payload]);
  });

  it('forwards job incident changes to CoS subscribers with only the jobId', () => {
    const socket = makeSocket('incident-events');
    createdSockets.push(socket);
    io.connect(socket);
    socket.handlers['cos:subscribe']();
    const listener = queueListeners.cos.find(([event]) => event === 'jobs:incidents-changed')?.[1];
    listener({ jobId: 'job-1', extra: 'dropped' });
    expect(socket.emitted).toContainEqual(['cos:jobs:incidents-changed', { jobId: 'job-1' }]);
  });

  it('invalidates Actions globally without exposing domain payloads or requiring a CoS subscription', () => {
    for (const [event, listener] of queueListeners.cos) {
      if (event === 'tasks:changed') listener({ type: 'user', task: { id: 'example', description: 'Private source text' } });
    }
    expect(io.emitted).toContainEqual(['review:queue:changed']);
    io.emitted.length = 0;
    queueListeners.review.find(([event]) => event === 'queue:changed')[1]({ private: 'not forwarded' });
    expect(io.emitted).toEqual([['review:queue:changed']]);
  });

  // The three agent-record events leave through the same listing projection as
  // `GET /api/cos/agents`. Without it the socket refills the CoS agents list with
  // unprojected rows — transcript and whole pasted prompt — moments after the
  // HTTP listing shrank it, and relays that payload on to every peer.
  it.each(['agent:spawned', 'agent:updated', 'agent:completed'])(
    'projects the agent record before broadcasting %s',
    (event) => {
      const socket = makeSocket(`agent-projection-${event}`);
      createdSockets.push(socket);
      io.connect(socket);
      socket.handlers['cos:subscribe']();

      const long = 'Refactor the queue. '.repeat(5000);
      const listener = queueListeners.cos.find(([name]) => name === event)?.[1];
      listener({
        id: 'agent-001',
        taskId: 'task-1',
        status: 'running',
        output: [{ line: 'a transcript line' }],
        metadata: { taskDescription: long, model: 'opus' }
      });

      const [, broadcast] = socket.emitted.find(([name]) => name === `cos:${event}`);
      expect(broadcast).not.toHaveProperty('output');
      expect(broadcast.metadata.taskDescription.length).toBeLessThan(long.length);
      expect(broadcast.metadata.taskDescriptionTruncated).toBe(true);
      // The fields every consumer routes on survive the projection.
      expect(broadcast).toMatchObject({ id: 'agent-001', taskId: 'task-1', status: 'running' });
      expect(broadcast.metadata.model).toBe('opus');
    }
  );

  // ===========================================================================
  // broadcast: two subscribed sockets both receive the event
  // Tested via the subscription ack — the internal Set membership is observable
  // through the ack emission which only happens when registerSubscriber runs.
  // ===========================================================================
  // ===========================================================================
  // media-job cancellation bridge (#1791): mediaJobEvents 'canceled' → a
  // generationId-keyed *-gen:canceled broadcast so stuck render spinners clear.
  // ===========================================================================
  it('broadcasts record-scoped sprite persistence and queue invalidations without record content', () => {
    spriteEvents.emit('changed', { recordId: 'example-sprite', privateRecord: 'excluded' });
    expect(io.emitted).toContainEqual(['sprites:changed', { recordId: 'example-sprite' }]);
    for (const event of ['enqueued', 'started', 'completed', 'failed', 'canceled']) {
      mediaJobEvents.emit(event, {
        id: 'example-job', kind: 'image',
        params: { spriteRef: { recordId: 'example-sprite', target: 'main', prompt: 'excluded' } },
      });
    }
    expect(io.emitted.filter(([event]) => event === 'sprites:jobs-changed')).toEqual(
      Array.from({ length: 5 }, () => ['sprites:jobs-changed', {
        recordId: 'example-sprite', kind: 'image', tagKey: 'spriteRef',
      }]),
    );
  });

  it('broadcasts bounded queue and checkpoint invalidations', () => {
    mediaJobEvents.emit('changed', { privateRecord: 'must not be forwarded' });
    trainingEvents.emit('checkpoints:changed', { runId: 'example-run', privateRecord: 'must not be forwarded' });
    expect(io.emitted).toContainEqual(['media-jobs:changed', {}]);
    expect(io.emitted).toContainEqual(['training:checkpoints:changed', { runId: 'example-run' }]);
  });

  it('relays render progress only to active queue subscribers', () => {
    const subscriber = makeSocket('media-queue-sub');
    const bystander = makeSocket('media-queue-bystander');
    createdSockets.push(subscriber, bystander);
    io.connect(subscriber);
    io.connect(bystander);
    subscriber.handlers['media-jobs:subscribe']();

    const frame = { id: 'example-job', startedAt: '2026-01-01T00:00:00Z', progress: 0.4, statusMsg: 'Rendering', etaMs: 80_000 };
    mediaJobEvents.emit('progress', { ...frame, privateRecord: 'excluded' });
    expect(subscriber.emitted).toContainEqual(['media-jobs:progress', frame]);
    expect(bystander.emitted).not.toContainEqual(['media-jobs:progress', expect.anything()]);
    expect(io.emitted.filter(([event]) => event.startsWith('media-jobs:'))).toEqual([]);

    subscriber.handlers['media-jobs:unsubscribe']();
    mediaJobEvents.emit('progress', { ...frame, progress: 0.8 });
    expect(subscriber.emitted.filter(([event]) => event === 'media-jobs:progress')).toHaveLength(1);
  });

  it.each([
    ['image-gen', imageGenEvents],
    ['video-gen', videoGenEvents],
    ['audio-gen', audioGenEvents],
  ])('keeps %s progress available to existing clients', (channel, events) => {
    const frame = { generationId: 'example-job', progress: 0.4, message: 'Rendering', etaMs: 80_000 };
    events.emit('progress', frame);
    expect(io.emitted).toContainEqual([`${channel}:progress`, frame]);
  });

  it('bridges a canceled image job to image-gen:canceled keyed by generationId', () => {
    mediaJobEvents.emit('canceled', { id: 'job-xyz', kind: 'image' });
    expect(io.emitted).toContainEqual(['image-gen:canceled', { generationId: 'job-xyz' }]);
  });

  it('bridges a canceled video job to video-gen:canceled', () => {
    mediaJobEvents.emit('canceled', { id: 'vid-1', kind: 'video' });
    expect(io.emitted).toContainEqual(['video-gen:canceled', { generationId: 'vid-1' }]);
  });

  // ===========================================================================
  // media-job failure bridge (#1799): mediaJobEvents 'failed' → a
  // generationId-keyed *-gen:failed broadcast so spinners clear on a queue-level
  // (pre-gen) failure that never reached the gen module's own failed event.
  // ===========================================================================
  it('bridges a failed image job to image-gen:failed keyed by generationId with the error', () => {
    mediaJobEvents.emit('failed', { id: 'job-fail', kind: 'image', error: 'runtime not ready' });
    expect(io.emitted).toContainEqual(['image-gen:failed', { generationId: 'job-fail', error: 'runtime not ready' }]);
  });

  it('bridges a failed video job to video-gen:failed', () => {
    mediaJobEvents.emit('failed', { id: 'vid-fail', kind: 'video', error: 'BYOV runtime threw' });
    expect(io.emitted).toContainEqual(['video-gen:failed', { generationId: 'vid-fail', error: 'BYOV runtime threw' }]);
  });

  // A non-image/video kind (e.g. LoRA 'training') has no `*-gen:*` consumer, so
  // neither bridge may forward it onto the image channel (#1799 review).
  it('does NOT bridge a failed training job onto image-gen:failed', () => {
    mediaJobEvents.emit('failed', { id: 'train-1', kind: 'training', error: 'OOM' });
    expect(io.emitted.some(([ev]) => ev === 'image-gen:failed' || ev === 'video-gen:failed')).toBe(false);
  });

  it('does NOT bridge a canceled training job onto image-gen:canceled', () => {
    mediaJobEvents.emit('canceled', { id: 'train-2', kind: 'training' });
    expect(io.emitted.some(([ev]) => ev === 'image-gen:canceled' || ev === 'video-gen:canceled')).toBe(false);
  });

  // ===========================================================================
  // Audio (first-pass music-bed) gen bridge (#1933): audio jobs ride the same
  // gen-event contract as image/video, so both the mediaJobEvents queue-level
  // bridge AND the direct audioGenEvents forwarding must reach `audio-gen:*`.
  // ===========================================================================
  it('bridges a failed audio job to audio-gen:failed keyed by generationId with the error', () => {
    mediaJobEvents.emit('failed', { id: 'aud-fail', kind: 'audio', error: 'audio-gen sidecar crashed' });
    expect(io.emitted).toContainEqual(['audio-gen:failed', { generationId: 'aud-fail', error: 'audio-gen sidecar crashed' }]);
  });

  it('bridges a canceled audio job to audio-gen:canceled', () => {
    mediaJobEvents.emit('canceled', { id: 'aud-1', kind: 'audio' });
    expect(io.emitted).toContainEqual(['audio-gen:canceled', { generationId: 'aud-1' }]);
  });

  it('forwards audioGenEvents failed straight onto audio-gen:failed', () => {
    audioGenEvents.emit('failed', { generationId: 'aud-run-fail', error: 'OOM during render' });
    expect(io.emitted).toContainEqual(['audio-gen:failed', { generationId: 'aud-run-fail', error: 'OOM during render' }]);
  });

  it('forwards audioGenEvents completed onto audio-gen:completed', () => {
    audioGenEvents.emit('completed', { generationId: 'aud-ok', filename: 'bed.wav', durationSec: 12 });
    expect(io.emitted).toContainEqual(['audio-gen:completed', { generationId: 'aud-ok', filename: 'bed.wav', durationSec: 12 }]);
  });

  it('two independent sockets can both subscribe to cos independently', () => {
    const s1 = makeSocket('s1');
    const s2 = makeSocket('s2');
    io.connect(s1);
    io.connect(s2);

    s1.handlers['cos:subscribe']();
    s2.handlers['cos:subscribe']();

    // Both must have received the ack confirming they are in the Set
    expect(s1.emitted.some(([ev]) => ev === 'cos:subscribed')).toBe(true);
    expect(s2.emitted.some(([ev]) => ev === 'cos:subscribed')).toBe(true);
  });

  // ===========================================================================
  // disconnect: socket removed from ALL subscriber Sets
  // ===========================================================================
  it('disconnected socket no longer receives events (removed from all sets)', () => {
    const s1 = makeSocket('disc-1');
    const s2 = makeSocket('disc-2');
    createdSockets.push(s2); // s1 is disconnected in the test; only s2 needs afterEach cleanup
    io.connect(s1);
    io.connect(s2);

    // Both subscribe to cos and loops
    s1.handlers['cos:subscribe']();
    s1.handlers['loops:subscribe']();
    s2.handlers['cos:subscribe']();
    s2.handlers['loops:subscribe']();

    // Disconnect s1
    s1.handlers['disconnect']();

    // Shell cleanup was called for s1 (prevents sessionListSubscribers Set leak)
    expect(shellService.detachSocketSessions).toHaveBeenCalledWith(s1);

    // Verify broadcast no longer reaches s1 — emit a cos:status event via the captured listener
    const statusListener = queueListeners.cos.find(([ev]) => ev === 'status')?.[1];
    const s1EmitsBefore = s1.emitted.length;
    if (statusListener) statusListener({ running: true });

    // s1 must not receive any new event
    expect(s1.emitted.length).toBe(s1EmitsBefore);
    // s2 still subscribed — must receive the broadcast
    expect(s2.emitted.some(([ev]) => ev === 'cos:status')).toBe(true);
  });

  // ===========================================================================
  // Multiple namespaces: loops:subscribe / errors:subscribe
  // ===========================================================================
  it('socket receives loops:subscribed ack after loops:subscribe', () => {
    const socket = makeSocket('loop-sub');
    io.connect(socket);

    socket.handlers['loops:subscribe']();

    expect(socket.emitted.some(([ev]) => ev === 'loops:subscribed')).toBe(true);
  });

  it('socket receives errors:subscribed ack after errors:subscribe', () => {
    const socket = makeSocket('err-sub');
    io.connect(socket);

    socket.handlers['errors:subscribe']();

    expect(socket.emitted.some(([ev]) => ev === 'errors:subscribed')).toBe(true);
  });

  it('notifies error subscribers of server faults but not of 4xx refusals answered to their caller', () => {
    const socket = makeSocket('err-notify');
    createdSockets.push(socket);
    io.connect(socket);
    socket.handlers['errors:subscribe']();
    const [, onError] = queueListeners.errors.find(([event]) => event === 'error');
    const notified = () => socket.emitted.filter(([ev]) => ev === 'error:notified').map(([, payload]) => payload.code);

    onError({ status: 409, code: 'CHECKOUT_REVIEW_REFUSED', message: 'Checkout review refused' }, {});
    onError({ status: 400, code: 'VALIDATION_ERROR', message: 'Validation failed' }, {});
    onError({ status: 404, code: 'NOT_FOUND', message: 'App not found', severity: 'critical' }, {});
    onError({ status: 500, code: 'INTERNAL_ERROR', message: 'timeout exceeded when trying to connect' }, {});
    onError({ code: 'AI_PROVIDER_EXECUTION_FAILED', message: 'Provider failed' }, {});

    expect(notified()).toEqual(['NOT_FOUND', 'INTERNAL_ERROR', 'AI_PROVIDER_EXECUTION_FAILED']);
  });

  // ===========================================================================
  // agents + instances namespaces
  // ===========================================================================
  it('socket receives agents:subscribed and instances:subscribed acks', () => {
    const socket = makeSocket('multi-sub');
    io.connect(socket);

    socket.handlers['agents:subscribe']();
    socket.handlers['instances:subscribe']();

    expect(socket.emitted.some(([ev]) => ev === 'agents:subscribed')).toBe(true);
    expect(socket.emitted.some(([ev]) => ev === 'instances:subscribed')).toBe(true);
  });

  // ===========================================================================
  // notifications namespace
  // ===========================================================================
  it('socket receives notifications:subscribed ack after notifications:subscribe', () => {
    const socket = makeSocket('notif-sub');
    io.connect(socket);

    socket.handlers['notifications:subscribe']();

    expect(socket.emitted.some(([ev]) => ev === 'notifications:subscribed')).toBe(true);
  });

  // ===========================================================================
  // unsubscribe removes from set — second socket keeps receiving
  // ===========================================================================
  it('after cos:unsubscribe, socket is removed but other subscribers remain intact', () => {
    const s1 = makeSocket('unsub-1');
    const s2 = makeSocket('unsub-2');
    io.connect(s1);
    io.connect(s2);

    s1.handlers['cos:subscribe']();
    s2.handlers['cos:subscribe']();

    // s1 unsubscribes
    s1.handlers['cos:unsubscribe']();

    // s2's subscription state is unaffected — it received cos:subscribed
    expect(s2.emitted.some(([ev]) => ev === 'cos:subscribed')).toBe(true);
    expect(s1.emitted.some(([ev]) => ev === 'cos:unsubscribed')).toBe(true);
  });

  // ===========================================================================
  // shell:list event sends back session list
  // ===========================================================================
  it('shell:list emits shell:sessions with the session list', () => {
    const socket = makeSocket('shell-list');
    io.connect(socket);

    socket.handlers['shell:list']();

    expect(socket.emitted.some(([ev]) => ev === 'shell:sessions')).toBe(true);
  });

  // listAllSessions must receive the requesting socket so the recipient-relative
  // `attached` flag works (sessions bound to this socket should report attached:false).
  it('shell:list forwards the requesting socket to listAllSessions', () => {
    const socket = makeSocket('shell-list-socket');
    io.connect(socket);
    shellService.listAllSessions.mockClear();

    socket.handlers['shell:list']();

    expect(shellService.listAllSessions).toHaveBeenCalledWith(socket);
  });

  // ===========================================================================
  // shell:cd — the client sends a folder, the SERVER renders the cd command, so
  // the quoting matches the shell that session actually runs (Windows cmd.exe
  // rejects the POSIX form the client used to send).
  // ===========================================================================
  it('shell:cd hands the path to changeSessionDirectory', () => {
    const socket = makeSocket('shell-cd');
    io.connect(socket);
    shellService.changeSessionDirectory.mockClear();

    socket.handlers['shell:cd']({ sessionId: 'abc', path: 'I:\\code\\example-app' });

    expect(shellService.changeSessionDirectory).toHaveBeenCalledWith('abc', 'I:\\code\\example-app');
  });

  it('shell:cd emits shell:error when the session is gone', () => {
    const socket = makeSocket('shell-cd-missing');
    io.connect(socket);
    shellService.changeSessionDirectory.mockReturnValueOnce(false);

    socket.handlers['shell:cd']({ sessionId: 'gone', path: '/tmp/app' });

    const err = socket.emitted.find(([ev]) => ev === 'shell:error');
    expect(err[1].sessionId).toBe('gone');
  });

  it('shell:cd says WHY when the target is a live agent run, not a dead session', () => {
    const socket = makeSocket('shell-cd-run');
    io.connect(socket);
    shellService.changeSessionDirectory.mockReturnValueOnce(false);
    shellService.getSession.mockReturnValueOnce({ external: true });

    socket.handlers['shell:cd']({ sessionId: 'run-1', path: '/home/user/example-app' });

    const err = socket.emitted.find(([ev]) => ev === 'shell:error');
    expect(err[1].sessionId).toBe('run-1');
    expect(err[1].error).toMatch(/live agent run/i);
  });

  // ===========================================================================
  // shell:attach claim semantics — auto-pick paths must not displace another tab
  // ===========================================================================
  it('shell:attach forwards claim flag to attachSession', () => {
    const socket = makeSocket('shell-attach-claim');
    io.connect(socket);
    shellService.attachSession.mockClear();
    shellService.attachSession.mockReturnValueOnce({ sessionId: 'abc', bufferedOutput: '' });

    socket.handlers['shell:attach']({ sessionId: 'abc', claim: true });

    expect(shellService.attachSession).toHaveBeenCalledWith('abc', socket, { claim: true });
  });

  it('shell:attach claim rejection emits shell:error with sessionId', () => {
    const socket = makeSocket('shell-attach-rejected');
    io.connect(socket);
    shellService.attachSession.mockClear();
    shellService.attachSession.mockReturnValueOnce({ claimRejected: true });

    socket.handlers['shell:attach']({ sessionId: 'taken', claim: true });

    const err = socket.emitted.find(([ev]) => ev === 'shell:error');
    expect(err).toBeTruthy();
    expect(err[1].sessionId).toBe('taken');
    expect(socket.emitted.some(([ev]) => ev === 'shell:attached')).toBe(false);
  });

  it('shell:attach session-not-found error includes sessionId for client correlation', () => {
    const socket = makeSocket('shell-attach-notfound');
    io.connect(socket);
    shellService.attachSession.mockClear();
    shellService.attachSession.mockReturnValueOnce(null);

    socket.handlers['shell:attach']({ sessionId: 'gone' });

    const err = socket.emitted.find(([ev]) => ev === 'shell:error');
    expect(err).toBeTruthy();
    expect(err[1].sessionId).toBe('gone');
  });

  // ===========================================================================
  // logs:subscribe — PM2_HOME resolution (issue #2991)
  //
  // An app running in its OWN PM2 instance keeps its logs in a separate home.
  // Spawning `pm2 logs` against the default home would tail nothing at all, so
  // the desktop launch-progress panel would sit empty while the game builds —
  // exactly the "reads as hung" failure the panel exists to prevent.
  // ===========================================================================
  describe('logs:subscribe PM2_HOME resolution', () => {
    beforeEach(() => {
      vi.mocked(spawnPm2).mockClear();
      vi.mocked(getAppById).mockReset();
      vi.mocked(resolvePm2HomeForProcess).mockReset();
      vi.mocked(resolvePm2HomeForProcess).mockResolvedValue(null);
    });

    it('streams from the default home when the process resolver finds no custom home', async () => {
      const socket = makeSocket('logs-default');
      io.connect(socket);
      vi.mocked(resolvePm2HomeForProcess).mockResolvedValue(null);

      await socket.handlers['logs:subscribe']({ processName: 'portos-server', lines: 100 });

      expect(getAppById).not.toHaveBeenCalled();
      expect(resolvePm2HomeForProcess).toHaveBeenCalledWith('portos-server');
      // buildEnv(null) is the default-home env — no PM2_HOME override.
      const [, opts] = vi.mocked(spawnPm2).mock.calls[0];
      expect(opts.env.PM2_HOME).toBeUndefined();
    });

    it('uses the process resolver for a custom home when no appId is supplied', async () => {
      const socket = makeSocket('logs-resolved-home');
      io.connect(socket);
      vi.mocked(resolvePm2HomeForProcess).mockResolvedValue('/tmp/example-pm2');

      await socket.handlers['logs:subscribe']({ processName: 'game', lines: 200 });

      expect(getAppById).not.toHaveBeenCalled();
      expect(resolvePm2HomeForProcess).toHaveBeenCalledWith('game');
      const [, opts] = vi.mocked(spawnPm2).mock.calls[0];
      expect(opts.env.PM2_HOME).toBe('/tmp/example-pm2');
    });

    it("streams from the app's custom PM2_HOME when it has one", async () => {
      const socket = makeSocket('logs-custom-home');
      io.connect(socket);
      vi.mocked(getAppById).mockResolvedValue({ id: 'app-1', pm2Home: '/opt/example/.pm2' });

      await socket.handlers['logs:subscribe']({ processName: 'game', lines: 200, appId: 'app-1' });

      expect(getAppById).toHaveBeenCalledWith('app-1');
      expect(resolvePm2HomeForProcess).not.toHaveBeenCalled();
      const [args, opts] = vi.mocked(spawnPm2).mock.calls[0];
      expect(args).toEqual(['logs', 'game', '--raw', '--lines', '200']);
      expect(opts.env.PM2_HOME).toBe('/opt/example/.pm2');
    });

    // The handler's try/catch exists so a synchronous throw can't become a
    // process-killing unhandled rejection. But the client's logs:error
    // listener (client/src/hooks/useProcessLogs.js) drops any event whose
    // processName doesn't match the panel's, so an error emitted without it
    // is invisible and the panel just hangs — the failure the catch was
    // added to prevent, in a quieter form.
    it('reports the failing process name when the log stream throws', async () => {
      const socket = makeSocket('logs-spawn-throws');
      io.connect(socket);
      vi.mocked(spawnPm2).mockImplementationOnce(() => { throw new Error('pm2 missing'); });

      await socket.handlers['logs:subscribe']({ processName: 'game', lines: 100 });

      const err = socket.emitted.find(([event]) => event === 'logs:error');
      expect(err).toBeDefined();
      expect(err[1]).toEqual({ error: 'pm2 missing', processName: 'game' });
    });

    it('falls back to the default home for an app with no custom home', async () => {
      const socket = makeSocket('logs-no-custom-home');
      io.connect(socket);
      vi.mocked(getAppById).mockResolvedValue({ id: 'app-1', pm2Home: null });

      await socket.handlers['logs:subscribe']({ processName: 'game', lines: 200, appId: 'app-1' });

      const [, opts] = vi.mocked(spawnPm2).mock.calls[0];
      expect(opts.env.PM2_HOME).toBeUndefined();
    });

    it('rejects the subscription when the app lookup fails rather than guessing a home', async () => {
      const socket = makeSocket('logs-lookup-fails');
      io.connect(socket);
      vi.mocked(getAppById).mockRejectedValue(new Error('registry unreadable'));

      // Runs outside the Express lifecycle — an unhandled rejection here would
      // take the process down, so the handler reports a correlated error.
      await expect(
        socket.handlers['logs:subscribe']({ processName: 'game', lines: 200, appId: 'app-1' })
      ).resolves.toBeUndefined();

      expect(socket.emitted).toContainEqual([
        'logs:error',
        { error: 'Unable to resolve PM2 home for game', processName: 'game' },
      ]);
      expect(vi.mocked(spawnPm2)).not.toHaveBeenCalled();
    });

    it('does not spawn an orphan stream when the socket disconnected mid-lookup', async () => {
      const socket = makeSocket('logs-disconnected');
      io.connect(socket);
      vi.mocked(getAppById).mockImplementation(async () => {
        // The socket drops while the registry read is in flight.
        socket.disconnected = true;
        return { id: 'app-1', pm2Home: '/opt/example/.pm2' };
      });

      await socket.handlers['logs:subscribe']({ processName: 'game', lines: 200, appId: 'app-1' });

      expect(vi.mocked(spawnPm2)).not.toHaveBeenCalled();
    });

    it('does not spawn an orphan stream when unsubscribe lands mid-lookup', async () => {
      // The cancellation case an `activeStreams.has()` check gets exactly wrong:
      // the unsubscribe's cleanupStream leaves the slot EMPTY, so an occupancy
      // check reads "free" and the stale handler spawns a `pm2 logs` that no
      // later cleanup will ever find to kill.
      const socket = makeSocket('logs-unsub-midlookup');
      io.connect(socket);
      vi.mocked(getAppById).mockImplementation(async () => {
        socket.handlers['logs:unsubscribe']({ processName: 'game' });
        return { id: 'app-1', pm2Home: '/opt/example/.pm2' };
      });

      await socket.handlers['logs:subscribe']({ processName: 'game', lines: 200, appId: 'app-1' });

      expect(vi.mocked(spawnPm2)).not.toHaveBeenCalled();
    });

    it('lets the NEWER of two overlapping subscribes for the same process win', async () => {
      // The opposite failure of the same check: with two subscribes in flight the
      // older one can fill the slot first, so an occupancy check makes the NEWER
      // one bail — and its client never gets `logs:subscribed`, leaving the panel
      // stuck on "Connecting to log stream…" forever.
      const socket = makeSocket('logs-overlapping');
      io.connect(socket);
      const gates = [];
      vi.mocked(getAppById).mockImplementation(
        () => new Promise(resolve => gates.push(() => resolve({ id: 'app-1', pm2Home: null })))
      );

      const first = socket.handlers['logs:subscribe']({ processName: 'game', lines: 100, appId: 'app-1' });
      const second = socket.handlers['logs:subscribe']({ processName: 'game', lines: 100, appId: 'app-1' });
      // Resolve them out of order: the older lookup finishes last.
      gates[1]();
      gates[0]();
      await Promise.all([first, second]);

      expect(vi.mocked(spawnPm2)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(spawnPm2).mock.calls[0][0]).toEqual(['logs', 'game', '--raw', '--lines', '100']);
      const subscribed = socket.emitted.filter(([ev]) => ev === 'logs:subscribed');
      expect(subscribed).toHaveLength(1);
      expect(subscribed[0][1].processName).toBe('game');
    });

    it('keeps different process streams active and unsubscribes only the named process', async () => {
      const socket = makeSocket('logs-multiplexed');
      io.connect(socket);

      await socket.handlers['logs:subscribe']({ processName: 'game', lines: 100 });
      await socket.handlers['logs:subscribe']({ processName: 'portos-server', lines: 100 });

      const gameStream = vi.mocked(spawnPm2).mock.results[0].value;
      const serverStream = vi.mocked(spawnPm2).mock.results[1].value;
      expect(vi.mocked(spawnPm2)).toHaveBeenCalledTimes(2);
      expect(gameStream.kill).not.toHaveBeenCalled();

      socket.handlers['logs:unsubscribe']({ processName: 'game' });

      expect(gameStream.kill).toHaveBeenCalledWith('SIGTERM');
      expect(serverStream.kill).not.toHaveBeenCalled();
      expect(socket.emitted).toContainEqual(['logs:unsubscribed', { processName: 'game' }]);
    });

    it('keeps a replacement registered when its predecessor closes asynchronously', async () => {
      const socket = makeSocket('logs-stale-close');
      io.connect(socket);

      await socket.handlers['logs:subscribe']({ processName: 'game', lines: 100 });
      const predecessor = vi.mocked(spawnPm2).mock.results[0].value;
      await socket.handlers['logs:subscribe']({ processName: 'game', lines: 100 });
      const replacement = vi.mocked(spawnPm2).mock.results[1].value;
      const onClose = predecessor.on.mock.calls.find(([event]) => event === 'close')[1];

      onClose(0);
      socket.handlers['logs:unsubscribe']({ processName: 'game' });

      expect(predecessor.kill).toHaveBeenCalledWith('SIGTERM');
      expect(replacement.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('reaps every process stream when its socket disconnects', async () => {
      const socket = makeSocket('logs-disconnect-sweep');
      io.connect(socket);

      await socket.handlers['logs:subscribe']({ processName: 'game', lines: 100 });
      await socket.handlers['logs:subscribe']({ processName: 'portos-server', lines: 100 });
      const gameStream = vi.mocked(spawnPm2).mock.results[0].value;
      const serverStream = vi.mocked(spawnPm2).mock.results[1].value;

      socket.handlers.disconnect();

      expect(gameStream.kill).toHaveBeenCalledWith('SIGTERM');
      expect(serverStream.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  // ===========================================================================
  // app:update — server-held in-flight set (#3435)
  // ===========================================================================
  describe('app operations in-flight set', () => {
    const APP = { id: 'app-1', name: 'Example App', repoPath: '/srv/example-app' };
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));

    beforeEach(() => {
      vi.mocked(getAppById).mockResolvedValue(APP);
    });

    it('rejects a second app:update for an app already updating, then frees the slot when it finishes', async () => {
      const socket = makeSocket('app-op-guard');
      io.connect(socket);

      let finishUpdate;
      vi.mocked(runAppUpdate).mockReturnValueOnce(new Promise(resolve => { finishUpdate = resolve; }));

      const running = socket.handlers['app:update']({ appId: APP.id });
      await flush();
      expect(vi.mocked(runAppUpdate)).toHaveBeenCalledTimes(1);

      // Second dispatch for the same app while the first is still running.
      await socket.handlers['app:update']({ appId: APP.id });
      const rejections = socket.emitted.filter(([ev, payload]) => ev === 'app:update:error' && /already running/.test(payload.message));
      expect(rejections).toHaveLength(1);
      expect(rejections[0][1].appId).toBe(APP.id);
      // Flagged as a refused dispatch, not a failure of the run in flight.
      expect(rejections[0][1].duplicate).toBe(true);
      // The first run is untouched — no second updateApp call.
      expect(vi.mocked(runAppUpdate)).toHaveBeenCalledTimes(1);

      finishUpdate({ success: true, steps: [] });
      await running;
      await flush();

      // Slot released: the completion broadcast is followed by an empty set.
      expect(io.emitted.some(([ev, payload]) => ev === 'app:update:complete' && payload.appId === APP.id)).toBe(true);
      const activeBroadcasts = io.emitted.filter(([ev]) => ev === 'app:operations:active');
      expect(activeBroadcasts.at(-1)[1].operations).toEqual([]);

      // …and a fresh dispatch is accepted again.
      vi.mocked(runAppUpdate).mockResolvedValueOnce({ success: true, steps: [] });
      await socket.handlers['app:update']({ appId: APP.id, syncFork: true });
      await flush();
      expect(vi.mocked(runAppUpdate)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(runAppUpdate).mock.calls.at(-1)[2]).toEqual({
        syncFork: true, acknowledgeFork: false, acknowledgePersistentMindImageBackup: false,
      });
    });

    // The HTTP route that used to own these two calls is gone; the socket is the
    // only update path, so it has to write the ledger row and fan out the
    // apps-changed broadcast itself.
    it('records a successful update in the action ledger and notifies apps-changed', async () => {
      const socket = makeSocket('app-op-ledger');
      io.connect(socket);

      vi.mocked(runAppUpdate).mockResolvedValueOnce({ success: true, steps: [{ step: 'pull' }] });
      await socket.handlers['app:update']({ appId: APP.id });
      await flush();

      expect(vi.mocked(logAction)).toHaveBeenCalledWith(
        'update', APP.id, APP.name, { steps: [{ step: 'pull' }] }, true, null,
      );
      expect(vi.mocked(notifyAppsChanged)).toHaveBeenCalledWith('update', APP.id);
    });

    it('still writes a ledger row when the update throws, flagged unsuccessful', async () => {
      const socket = makeSocket('app-op-ledger-fail');
      io.connect(socket);

      vi.mocked(runAppUpdate).mockRejectedValueOnce(new Error('pull failed'));
      await socket.handlers['app:update']({ appId: APP.id });
      await flush();

      expect(vi.mocked(logAction)).toHaveBeenCalledWith(
        'update', APP.id, APP.name, { steps: [] }, false, 'pull failed',
      );
    });

    it('blocks a second app record that points at the same checkout', async () => {
      const socket = makeSocket('app-op-alias');
      io.connect(socket);

      let finishUpdate;
      vi.mocked(runAppUpdate).mockReturnValueOnce(new Promise(resolve => { finishUpdate = resolve; }));
      const running = socket.handlers['app:update']({ appId: APP.id });
      await flush();

      // A different app id, same repoPath — the resource being rebuilt is shared.
      vi.mocked(getAppById).mockResolvedValueOnce({ id: 'app-2', name: 'Alias App', repoPath: APP.repoPath });
      await socket.handlers['app:standardize']({ appId: 'app-2' });

      expect(socket.emitted.some(([ev, payload]) => (
        ev === 'app:standardize:error' && payload.duplicate === true && payload.message.includes(APP.name)
      ))).toBe(true);

      finishUpdate({ success: true, steps: [] });
      await running;
      await flush();
    });

    it('refuses to standardize an app the standardizer rejects, before any analysis runs', async () => {
      // Standardizing rewrites the target repo (writes ecosystem.config.cjs), so
      // the precondition is enforced here — not left to the button being hidden.
      const socket = makeSocket('app-op-refusal');
      io.connect(socket);

      vi.mocked(getAppById).mockResolvedValueOnce({ id: 'app-ios', name: 'iOS App', type: 'ios-native', repoPath: '/srv/ios-app' });
      vi.mocked(standardizeRefusalFor).mockReturnValueOnce('ios-native apps are not run under PM2');

      await socket.handlers['app:standardize']({ appId: 'app-ios' });
      await flush();

      expect(socket.emitted.some(([ev, payload]) => (
        ev === 'app:standardize:error' && payload.message.includes('not run under PM2')
      ))).toBe(true);
      expect(vi.mocked(analyzeApp)).not.toHaveBeenCalled();
    });

    it('buffers steps so a client that connects mid-operation rehydrates the log', async () => {
      const socket = makeSocket('app-op-buffer');
      io.connect(socket);

      let finishUpdate;
      vi.mocked(runAppUpdate).mockImplementationOnce((_app, emit) => new Promise(resolve => {
        emit('pull', 'running', 'Pulling latest…');
        finishUpdate = resolve;
      }));

      const running = socket.handlers['app:update']({ appId: APP.id });
      await flush();

      const latecomer = makeSocket('app-op-latecomer');
      io.connect(latecomer);
      const pushed = latecomer.emitted.filter(([ev]) => ev === 'app:operations:active').at(-1)[1];
      expect(pushed.operations).toHaveLength(1);
      expect(pushed.operations[0]).toMatchObject({ appId: APP.id, appName: APP.name, type: 'update' });
      // The wire payload names the run; the checkout path stays server-side.
      expect(pushed.operations[0].repoPath).toBeUndefined();
      expect(pushed.operations[0].steps).toEqual([
        expect.objectContaining({ appId: APP.id, step: 'pull', status: 'running' })
      ]);

      // The same set is available on demand for a page that mounts later.
      latecomer.emitted.length = 0;
      latecomer.handlers['app:operations:list']();
      expect(latecomer.emitted.at(-1)[1].operations).toHaveLength(1);

      finishUpdate({ success: true, steps: [] });
      await running;
      await flush();
    });
  });
  // ===========================================================================
  // shell:start — the AI Providers "Launch in Shell" path
  //
  // The client sends only a provider ID. The server resolves the command AND
  // the provider's env, because a TUI provider's backend lives in `envVars`:
  // a session started from a bare command line runs the right binary against
  // the vendor cloud instead of the local daemon the user configured. Those
  // values are secret besides, so they can never round-trip through the client.
  // ===========================================================================
  describe('shell:start provider launch', () => {
    const OLLAMA_TUI = {
      id: 'claude-ollama-tui',
      name: 'Claude Ollama TUI',
      type: 'tui',
      command: 'claude',
      args: [],
      ollamaBacked: true,
      defaultModel: 'qwen3:32b',
      envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' },
    };

    const start = async (payload) => {
      const socket = makeSocket('shell-launch');
      createdSockets.push(socket);
      io.connect(socket);
      await socket.handlers['shell:start'](payload);
      return socket;
    };

    beforeEach(() => {
      vi.mocked(shellService.createShellSession).mockClear().mockReturnValue('sess-1');
      vi.mocked(getProviderById).mockReset();
    });

    it('spawns the PTY with the provider env and types the resolved command', async () => {
      vi.mocked(getProviderById).mockResolvedValue(OLLAMA_TUI);

      const socket = await start({ providerId: 'claude-ollama-tui' });

      expect(socket.emitted).toContainEqual(['shell:started', { sessionId: 'sess-1' }]);
      const [, opts] = vi.mocked(shellService.createShellSession).mock.calls.at(-1);
      expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
      expect(opts.initialCommand).toMatch(/^claude\b/);
      expect(opts.waitForPromptReady).toBe(true);
    });

    it('ignores a client-supplied command for a provider launch — the server owns it', async () => {
      vi.mocked(getProviderById).mockResolvedValue(OLLAMA_TUI);

      await start({ providerId: 'claude-ollama-tui', initialCommand: 'rm -rf /' });

      const [, opts] = vi.mocked(shellService.createShellSession).mock.calls.at(-1);
      expect(opts.initialCommand).not.toContain('rm -rf');
      expect(opts.initialCommand).toMatch(/^claude\b/);
      expect(opts.waitForPromptReady).toBe(true);
      expect(opts).not.toHaveProperty('exitWithCommand');
    });

    it('refuses a provider that is not a launchable TUI rather than opening a bare shell', async () => {
      vi.mocked(getProviderById).mockResolvedValue({ ...OLLAMA_TUI, type: 'api' });

      const socket = await start({ providerId: 'claude-ollama-tui' });

      expect(socket.emitted.some(([ev]) => ev === 'shell:error')).toBe(true);
      expect(shellService.createShellSession).not.toHaveBeenCalled();
    });

    it('refuses an unknown provider id', async () => {
      vi.mocked(getProviderById).mockResolvedValue(null);

      const socket = await start({ providerId: 'nope' });

      expect(socket.emitted.some(([ev]) => ev === 'shell:error')).toBe(true);
      expect(shellService.createShellSession).not.toHaveBeenCalled();
    });

    it('still supports a plain cwd/command start with no provider', async () => {
      await start({ cwd: '/tmp/app', initialCommand: 'claude' });

      expect(getProviderById).not.toHaveBeenCalled();
      const [, opts] = vi.mocked(shellService.createShellSession).mock.calls.at(-1);
      expect(opts.cwd).toBe('/tmp/app');
      expect(opts.env).toBeUndefined();
      expect(opts.initialCommand).toBe('claude');
      expect(opts.waitForPromptReady).toBe(true);
    });
  });
});

describe('socket.js — inbound peer socket revocation (#17905)', () => {
  const peerSocket = (id, peerId, instanceId) => {
    const socket = makeSocket(id);
    socket.data = { portosAuthMethod: 'peer', portosPeerId: peerId, portosPeerInstanceId: instanceId };
    socket.disconnect = vi.fn();
    const middlewares = [];
    socket.use = (fn) => middlewares.push(fn);
    socket.runEvent = async (event) => {
      const next = vi.fn();
      await middlewares[0]([event, {}], next);
      return next;
    };
    return socket;
  };
  let io;
  let sockets;

  beforeEach(() => {
    sockets = [];
    io = { ...makeIo(), fetchSockets: async () => sockets };
    initSocket(io);
    vi.mocked(isAuthEnabled).mockResolvedValue(true);
    vi.mocked(verifyRequestSession).mockResolvedValue(false);
  });

  afterEach(() => {
    authEvents.removeAllListeners('sessions:revoked-all');
    vi.mocked(isAuthEnabled).mockResolvedValue(false);
    vi.mocked(verifyPeerToken).mockResolvedValue(null);
  });

  it('disconnects only the revoked peer\'s inbound sockets', async () => {
    const revoked = peerSocket('a', 'peer-a', 'inst-a');
    const other = peerSocket('b', 'peer-b', 'inst-b');
    sockets = [revoked, other];
    instanceEvents.emit('peer:auth-revoked', { peerId: 'peer-a', instanceId: 'inst-a' });
    await vi.waitFor(() => expect(revoked.disconnect).toHaveBeenCalledWith(true));
    expect(other.disconnect).not.toHaveBeenCalled();
  });

  it('drops a peer socket whose token no longer verifies instead of subscribing it', async () => {
    const stale = peerSocket('stale', 'peer-a', 'inst-a');
    io.connect(stale);
    vi.mocked(verifyPeerToken).mockResolvedValue(null);
    const next = await stale.runEvent('peer:sync:subscribe');
    expect(next).not.toHaveBeenCalled();
    expect(stale.disconnect).toHaveBeenCalledWith(true);
  });

  it('keeps serving a peer socket whose token still verifies', async () => {
    const live = peerSocket('live', 'peer-a', 'inst-a');
    io.connect(live);
    vi.mocked(verifyPeerToken).mockResolvedValue({ id: 'peer-a' });
    const next = await live.runEvent('peer:sync:subscribe');
    expect(next).toHaveBeenCalled();
    expect(live.disconnect).not.toHaveBeenCalled();
  });
});

describe('logs:subscribe host-control boundary (#19168)', () => {
  let io;
  const guardedSocket = (id, remote = true) => {
    const socket = makeSocket(id);
    socket.handshake.headers = remote ? { 'x-forwarded-for': '192.0.2.10' } : {};
    socket.use = (fn) => { socket.middleware = fn; };
    socket.runEvent = async (event, payload) => {
      const next = vi.fn();
      await socket.middleware([event, payload], next);
      if (next.mock.calls.length) await socket.handlers[event](payload);
      return next;
    };
    return socket;
  };
  beforeEach(() => {
    io = makeIo();
    initSocket(io);
    vi.mocked(isAuthEnabled).mockResolvedValue(false);
    vi.mocked(spawnPm2).mockClear();
  });
  it('refuses remote password-free log subscriptions and leaves unsubscribe available', async () => {
    const socket = guardedSocket('remote');
    io.connect(socket);
    const payload = { processName: 'portos-server', lines: 20 };
    const next = await socket.runEvent('logs:subscribe', payload);
    expect(next).not.toHaveBeenCalled();
    expect(socket.emitted).toContainEqual(['logs:error', expect.objectContaining({ code: 'HOST_CONTROL_FORBIDDEN', processName: payload.processName })]);
    expect(spawnPm2).not.toHaveBeenCalled();
    expect(await socket.runEvent('logs:unsubscribe', payload)).toHaveBeenCalled();
  });
  it('allows local password-free and authenticated operator subscriptions', async () => {
    const local = guardedSocket('local', false);
    local.data.portosLocalConnection = true;
    io.connect(local);
    expect(await local.runEvent('logs:subscribe', { processName: 'portos-server', lines: 20 })).toHaveBeenCalled();
    vi.mocked(isAuthEnabled).mockResolvedValue(true);
    vi.mocked(verifyRequestSession).mockResolvedValue(true);
    const operator = guardedSocket('operator');
    io.connect(operator);
    expect(await operator.runEvent('logs:subscribe', { processName: 'portos-server', lines: 20 })).toHaveBeenCalled();
    expect(spawnPm2).toHaveBeenCalledTimes(2);
    expect(local.emitted).toContainEqual(['logs:subscribed', expect.objectContaining({ processName: 'portos-server' })]);
    expect(operator.emitted).toContainEqual(['logs:subscribed', expect.objectContaining({ processName: 'portos-server' })]);
  });
});

describe('agent-processes:subscribe host-control boundary (#19170)', () => {
  let io;
  const connectedSocket = ({ local = false, headers = {} } = {}) => {
    const socket = makeSocket();
    socket.data.portosLocalConnection = local;
    socket.handshake.headers = headers;
    socket.use = (fn) => { socket.middleware = fn; };
    socket.runEvent = async (event, payload) => {
      const next = vi.fn();
      await socket.middleware([event, payload], next);
      if (next.mock.calls.length) await socket.handlers[event](payload);
      return next;
    };
    io.connect(socket);
    return socket;
  };

  beforeEach(() => {
    io = makeIo();
    initSocket(io);
    vi.mocked(isAuthEnabled).mockResolvedValue(false);
    vi.mocked(verifyRequestSession).mockResolvedValue(false);
  });

  it('refuses remote password-free subscriptions before dispatch and permits unsubscribe', async () => {
    const socket = connectedSocket();
    const next = await socket.runEvent('agent-processes:subscribe');
    expect(next).not.toHaveBeenCalled();
    expect(socket.emitted).toContainEqual(['agent-processes:error', expect.objectContaining({ code: 'HOST_CONTROL_FORBIDDEN' })]);
    expect(await socket.runEvent('agent-processes:unsubscribe')).toHaveBeenCalled();
  });

  it('dispatches local password-free and authenticated agent sessions', async () => {
    const local = connectedSocket({ local: true });
    expect(await local.runEvent('agent-processes:subscribe')).toHaveBeenCalled();

    vi.mocked(isAuthEnabled).mockResolvedValue(true);
    const headers = { authorization: 'Bearer example-agent-session' };
    vi.mocked(verifyRequestSession).mockImplementation(async (request) => request.headers === headers);
    const agent = connectedSocket({ headers });
    expect(await agent.runEvent('agent-processes:subscribe')).toHaveBeenCalled();
  });
});


describe('voice socket host-control boundary (#19169)', () => {
  const hostEvents = [
    ['voice:call:attach', 'call'],
    ['voice:call:audio', 'call'],
    ['voice:call:hangup', 'call'],
    ['voice:capture:start', 'capture'],
    ['voice:dictation:set', 'voice'],
    ['voice:output:available', 'voice'],
    ['voice:output:claim', 'voice'],
  ];
  let io;
  const connectedSocket = ({ local = false, headers = {} } = {}) => {
    const socket = makeSocket();
    socket.data.portosLocalConnection = local;
    socket.handshake.headers = headers;
    socket.use = (middleware) => { socket.middleware = middleware; };
    io.connect(socket);
    return socket;
  };

  beforeEach(() => {
    io = makeIo();
    initSocket(io);
    vi.mocked(isAuthEnabled).mockResolvedValue(false);
    vi.mocked(verifyRequestSession).mockResolvedValue(false);
  });

  afterEach(() => {
    authEvents.removeAllListeners('sessions:revoked-all');
    vi.mocked(isAuthEnabled).mockResolvedValue(false);
    vi.mocked(verifyRequestSession).mockResolvedValue(false);
  });

  it.each(hostEvents)('stops %s before dispatch for a remote password-free socket', async (event, stage) => {
    const socket = connectedSocket();
    const next = vi.fn();
    await socket.middleware([event], next);
    expect(next).not.toHaveBeenCalled();
    expect(socket.emitted).toContainEqual(['voice:error', expect.objectContaining({ stage, code: 'HOST_CONTROL_FORBIDDEN' })]);
  });

  it.each([['local password-free', false], ['delegated operator session', true]])('dispatches host events for a %s socket', async (_kind, authEnabled) => {
    const headers = authEnabled ? { authorization: 'Bearer example-session' } : {};
    vi.mocked(isAuthEnabled).mockResolvedValue(authEnabled);
    vi.mocked(verifyRequestSession).mockImplementation(async (request) => request.headers === headers);
    const socket = connectedSocket({ local: !authEnabled, headers });
    for (const [event] of hostEvents) {
      const next = vi.fn();
      await socket.middleware([event], next);
      expect(next).toHaveBeenCalledExactlyOnceWith();
    }
    expect(socket.emitted.some(([event]) => event === 'voice:error')).toBe(false);
  });

  it('allows owner-scoped cleanup and conversational input through for password-free sockets', async () => {
    const socket = connectedSocket();
    for (const event of ['voice:call:detach', 'voice:capture:stop', 'voice:text']) {
      const next = vi.fn();
      await socket.middleware([event], next);
      expect(next).toHaveBeenCalledExactlyOnceWith();
    }
  });
});
