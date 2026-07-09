import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('./pm2Standardizer.js', () => ({ analyzeApp: vi.fn(), createGitBackup: vi.fn(), applyStandardization: vi.fn(), runStandardizeFlow: vi.fn() }));
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
  shellAttachSchema: {},
  shellStopSchema: {},
  appUpdateSchema: {},
  appStandardizeSchema: {},
  appDeploySchema: {}
}));
vi.mock('./appUpdater.js', () => ({ updateApp: vi.fn() }));
vi.mock('./appDeployer.js', () => ({ hasDeployScript: vi.fn(), deployApp: vi.fn(), runDeployFlow: vi.fn() }));
vi.mock('../sockets/voice.js', () => ({ registerVoiceHandlers: vi.fn() }));

import { initSocket } from './socket.js';
import { cosEvents } from './cosEvents.js';
import { mediaJobEvents } from './mediaJobQueue/index.js';
import { audioGenEvents } from './audioGen/events.js';
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
  const createdSockets = [];

  afterEach(() => {
    for (const s of createdSockets) {
      if (s.handlers['disconnect']) s.handlers['disconnect']();
    }
    createdSockets.length = 0;
  });

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
  // ===========================================================================
  // media-job cancellation bridge (#1791): mediaJobEvents 'canceled' → a
  // generationId-keyed *-gen:canceled broadcast so stuck render spinners clear.
  // ===========================================================================
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
    const statusListener = cosEvents.on.mock.calls.find(([ev]) => ev === 'status')?.[1];
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
});
