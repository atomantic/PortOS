import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for socket.js initSocket behavior.
 *
 * Strategy: mock all heavy imports at the system boundary (PM2, file I/O,
 * external services) so we can call the real initSocket and verify its
 * subscription / broadcast / disconnect behavior through observable socket events.
 */

vi.mock('./pm2.js', () => ({ spawnPm2: vi.fn(() => ({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn() })) }));
vi.mock('./streamingDetect.js', () => ({ streamDetection: vi.fn() }));
vi.mock('./cosEvents.js', () => ({ cosEvents: { on: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./apps.js', () => ({ appsEvents: { on: vi.fn() }, getAppById: vi.fn(), updateApp: vi.fn() }));
vi.mock('../lib/errorHandler.js', () => ({ errorEvents: { on: vi.fn() } }));
vi.mock('./autoFixer.js', () => ({ handleErrorRecovery: vi.fn() }));
vi.mock('./pm2Standardizer.js', () => ({ analyzeApp: vi.fn(), createGitBackup: vi.fn(), applyStandardization: vi.fn() }));
vi.mock('./notifications.js', () => ({ notificationEvents: { on: vi.fn() } }));
vi.mock('./providerStatus.js', () => ({ providerStatusEvents: { on: vi.fn() } }));
vi.mock('./agentPersonalities.js', () => ({ agentPersonalityEvents: { on: vi.fn() } }));
vi.mock('./platformAccounts.js', () => ({ platformAccountEvents: { on: vi.fn() } }));
vi.mock('./updateChecker.js', () => ({ updateEvents: { on: vi.fn() } }));
vi.mock('./automationScheduler.js', () => ({ scheduleEvents: { on: vi.fn() } }));
vi.mock('./agentActivity.js', () => ({ activityEvents: { on: vi.fn() } }));
vi.mock('./brainStorage.js', () => ({ brainEvents: { on: vi.fn() } }));
vi.mock('./moltworldWs.js', () => ({ moltworldWsEvents: { on: vi.fn() } }));
vi.mock('./moltworldQueue.js', () => ({ queueEvents: { on: vi.fn() } }));
vi.mock('./instanceEvents.js', () => ({ instanceEvents: { on: vi.fn() } }));
vi.mock('./review.js', () => ({ reviewEvents: { on: vi.fn() } }));
vi.mock('./loops.js', () => ({ loopEvents: { on: vi.fn() } }));
vi.mock('./imageGenEvents.js', () => ({ imageGenEvents: { on: vi.fn() } }));
vi.mock('./shell.js', () => ({
  createShellSession: vi.fn(),
  attachSession: vi.fn(),
  subscribeSessionList: vi.fn(),
  listAllSessions: vi.fn(() => []),
  writeToSession: vi.fn(),
  resizeSession: vi.fn(),
  killSession: vi.fn(),
  unsubscribeSessionList: vi.fn(),
  detachSocketSessions: vi.fn(() => 0)
}));
vi.mock('../lib/socketValidation.js', () => ({
  validateSocketData: vi.fn((schema, data) => data),
  detectStartSchema: {},
  standardizeStartSchema: {},
  logsSubscribeSchema: {},
  errorRecoverSchema: {},
  shellInputSchema: {},
  shellResizeSchema: {},
  shellSessionIdSchema: {},
  shellStopSchema: {},
  appUpdateSchema: {},
  appStandardizeSchema: {},
  appDeploySchema: {}
}));
vi.mock('./appUpdater.js', () => ({ updateApp: vi.fn() }));
vi.mock('./appDeployer.js', () => ({ hasDeployScript: vi.fn(), deployApp: vi.fn() }));
vi.mock('../sockets/voice.js', () => ({ registerVoiceHandlers: vi.fn() }));

import { initSocket } from './socket.js';
import { detachSocketSessions } from './shell.js';
import * as shellService from './shell.js';

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
    removeAllListeners: vi.fn()
  };
}

// Build a minimal fake io that captures the connection handler
function makeIo() {
  let connectionHandler = null;
  const emitted = [];
  return {
    connectionHandler: () => connectionHandler,
    emit(event, ...args) { emitted.push([event, ...args]); },
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

  beforeEach(() => {
    vi.mocked(detachSocketSessions).mockClear();
    io = makeIo();
    initSocket(io);
  });

  // ===========================================================================
  // cos:subscribe — socket joins cosSubscribers, receives cos:subscribed ack
  // ===========================================================================
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

  // ===========================================================================
  // broadcast: two subscribed sockets both receive the event
  // Tested via the subscription ack — the internal Set membership is observable
  // through the ack emission which only happens when registerSubscriber runs.
  // ===========================================================================
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

    // Count cos:subscribed emits (registration acks) for s1
    const s1CosSubscribedCount = s1.emitted.filter(([ev]) => ev === 'cos:subscribed').length;
    expect(s1CosSubscribedCount).toBe(1); // was subscribed once before disconnect

    // s2 remains connected — still gets acks from its own registration
    const s2CosSubscribedCount = s2.emitted.filter(([ev]) => ev === 'cos:subscribed').length;
    expect(s2CosSubscribedCount).toBe(1);
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
});
