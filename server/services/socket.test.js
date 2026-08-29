import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('./cosEvents.js', () => ({ cosEvents: { on: vi.fn() }, emitLog: vi.fn() }));
vi.mock('./apps.js', () => ({ appsEvents: { on: vi.fn() }, getAppById: vi.fn(), resolvePm2HomeForProcess: vi.fn(), updateApp: vi.fn() }));
vi.mock('../lib/errorHandler.js', () => ({ errorEvents: { on: vi.fn() } }));
vi.mock('./autoFixer.js', () => ({ handleErrorRecovery: vi.fn() }));
vi.mock('./pm2Standardizer.js', () => ({ analyzeApp: vi.fn(), createGitBackup: vi.fn(), applyStandardization: vi.fn(), runStandardizeFlow: vi.fn(), standardizeRefusalFor: vi.fn(() => null) }));
vi.mock('./notifications.js', () => ({ notificationEvents: { on: vi.fn() }, getNotifications: vi.fn(async () => []) }));
vi.mock('./agentPersonalities.js', () => ({ agentPersonalityEvents: { on: vi.fn() } }));
vi.mock('./platformAccounts.js', () => ({ platformAccountEvents: { on: vi.fn() } }));
vi.mock('./updateChecker.js', () => ({ updateEvents: { on: vi.fn() } }));
// Pin the bundle hash so the assertion does not depend on whether a dist
// happens to exist in the checkout the suite runs from.
vi.mock('../lib/buildId.js', () => ({ getBuildId: vi.fn(() => 'test-build-id') }));
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
vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));
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
  appUpdateSchema: {},
  appStandardizeSchema: {},
  appDeploySchema: {}
}));
vi.mock('./appUpdater.js', () => ({ updateApp: vi.fn() }));
vi.mock('./appDeployer.js', () => ({ hasDeployScript: vi.fn(), deployApp: vi.fn(), runDeployFlow: vi.fn() }));
vi.mock('../sockets/voice.js', () => ({ registerVoiceHandlers: vi.fn() }));

import { initSocket } from './socket.js';
import { spawnPm2 } from './pm2.js';
import { getAppById, resolvePm2HomeForProcess } from './apps.js';
import { cosEvents } from './cosEvents.js';
import { mediaJobEvents } from './mediaJobQueue/index.js';
import { audioGenEvents } from './audioGen/events.js';
import { detachSocketSessions } from './shell.js';
import * as shellService from './shell.js';
import { getProviderById } from './providers.js';
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
    vi.mocked(registerVoiceHandlers).mockClear();
    io = makeIo();
    initSocket(io);
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

  it('forwards task lifecycle changes with the task payload to CoS subscribers', () => {
    const socket = makeSocket('task-events');
    createdSockets.push(socket);
    io.connect(socket);
    socket.handlers['cos:subscribe']();

    const listener = cosEvents.on.mock.calls.find(([event]) => event === 'tasks:changed')?.[1];
    const payload = {
      type: 'user',
      action: 'updated',
      previousStatus: 'pending',
      task: { id: 'task-1', status: 'in_progress' }
    };
    listener(payload);

    expect(socket.emitted).toContainEqual(['cos:tasks:changed', payload]);
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

    it('still streams when the app lookup fails rather than throwing', async () => {
      const socket = makeSocket('logs-lookup-fails');
      io.connect(socket);
      vi.mocked(getAppById).mockRejectedValue(new Error('registry unreadable'));

      // Runs outside the Express lifecycle — an unhandled rejection here would
      // take the process down, so the lookup degrades to the default home.
      await expect(
        socket.handlers['logs:subscribe']({ processName: 'game', lines: 200, appId: 'app-1' })
      ).resolves.toBeUndefined();

      expect(vi.mocked(spawnPm2)).toHaveBeenCalledTimes(1);
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
      await socket.handlers['app:update']({ appId: APP.id });
      await flush();
      expect(vi.mocked(runAppUpdate)).toHaveBeenCalledTimes(2);
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
      vi.mocked(shellService.submitToSession).mockClear();
      vi.mocked(getProviderById).mockReset();
    });

    it('spawns the PTY with the provider env and types the resolved command', async () => {
      vi.mocked(getProviderById).mockResolvedValue(OLLAMA_TUI);

      const socket = await start({ providerId: 'claude-ollama-tui' });

      expect(socket.emitted).toContainEqual(['shell:started', { sessionId: 'sess-1' }]);
      const [, opts] = vi.mocked(shellService.createShellSession).mock.calls.at(-1);
      expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
    });

    it('ignores a client-supplied command for a provider launch — the server owns it', async () => {
      vi.mocked(getProviderById).mockResolvedValue(OLLAMA_TUI);

      await start({ providerId: 'claude-ollama-tui', initialCommand: 'rm -rf /' });

      // The submit is deferred behind a timer; drain it before asserting.
      await vi.waitFor(() => expect(shellService.submitToSession).toHaveBeenCalled());
      const [, typed] = vi.mocked(shellService.submitToSession).mock.calls.at(-1);
      expect(typed).not.toContain('rm -rf');
      expect(typed).toContain('claude');
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
    });
  });
});
