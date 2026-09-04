import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';

// server/sockets/apps.js owns three pieces of state no other layer can observe:
// the re-entrancy guard that stops two concurrent git/PM2 mutations of the same
// checkout, the resumable progress buffer a remounting client rehydrates from,
// and the ledger/broadcast/cleanup epilogue that has to run even when the
// underlying service throws. This suite drives the real socket handlers
// (registerAppHandlers) against a fake socket/io so those contracts are pinned
// at the event boundary rather than through the client's mocked socket.
// PortOS-app preflight refusals are deliberately NOT re-covered here — they
// have their own parity suite (services/updatePreflightParity.test.js).

vi.mock('../services/streamingDetect.js', () => ({ streamDetection: vi.fn() }));
vi.mock('../services/appDeployer.js', () => ({ runDeployFlow: vi.fn() }));
vi.mock('../services/updatePreflight.js', () => ({
  checkPortosUpdatePreflight: vi.fn(async () => {}),
}));
vi.mock('../services/appUpdater.js', () => ({ updateApp: vi.fn() }));
vi.mock('../services/history.js', () => ({ logAction: vi.fn() }));
vi.mock('../services/apps.js', () => ({
  getAppById: vi.fn(),
  notifyAppsChanged: vi.fn(),
  updateApp: vi.fn(async () => ({})),
}));
vi.mock('../services/pm2Standardizer.js', () => ({
  runStandardizeFlow: vi.fn(),
  standardizeRefusalFor: vi.fn(() => null),
  analyzeApp: vi.fn(),
  createGitBackup: vi.fn(async () => ({ success: false, reason: 'No git repository' })),
  applyStandardization: vi.fn(),
}));

import * as appsService from '../services/apps.js';
import * as appUpdater from '../services/appUpdater.js';
import * as pm2Standardizer from '../services/pm2Standardizer.js';
import { logAction } from '../services/history.js';
import { __resetAppOperations, registerAppHandlers } from '../sockets/apps.js';

// Two app records pointing at ONE checkout — the case app id alone can't catch.
const APPS = {
  'app-a': { id: 'app-a', name: 'Example App A', repoPath: '/repos/shared', type: 'node' },
  'app-b': { id: 'app-b', name: 'Example App B', repoPath: '/repos/shared', type: 'node' },
  'app-c': { id: 'app-c', name: 'Example App C', repoPath: '/repos/other', type: 'node' },
};

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

// Fake socket/io. `io.emit` is a real broadcast — every connected client sees
// it — so one bus fans out to each connection opened in a test, while
// `socket.emit` reaches only its own. Both land in that connection's ordered
// log, since the contract under test is which events carry which payloads.
const makeBus = () => {
  const sinks = [];
  return {
    io: { emit: (event, payload) => sinks.forEach((sink) => sink.push({ event, payload })) },
    connect: (sink) => sinks.push(sink),
  };
};

// A fresh connection on the shared bus, modelling a client (re)mounting.
const connect = (bus) => {
  const handlers = new Map();
  const emitted = [];
  bus.connect(emitted);
  const socket = { on: (event, fn) => handlers.set(event, fn), emit: (event, payload) => emitted.push({ event, payload }) };
  registerAppHandlers(socket, bus.io);
  return {
    emitted,
    fire: (event, payload) => handlers.get(event)(payload),
    events: (name) => emitted.filter((e) => e.event === name),
    last: (name) => emitted.filter((e) => e.event === name).at(-1),
  };
};

// Starts an app:update that parks inside appUpdater.updateApp until the caller
// releases it, so the operation is provably in-flight when the next event fires.
// activeAppOperations is module state that outlives the test, so the parked run
// is always released at teardown — otherwise one failing assertion here would
// leave the guard armed and cascade into every later test in the file.
const startParkedUpdate = async (bus, appId, { onEmit } = {}) => {
  const entered = deferred();
  const gate = deferred();
  appUpdater.updateApp.mockImplementation(async (app, emit) => {
    onEmit?.(emit);
    entered.resolve();
    return gate.promise;
  });
  const client = connect(bus);
  const settled = client.fire('app:update', { appId });
  const release = (result) => gate.resolve(result ?? { success: true, steps: [] });
  onTestFinished(async () => { release(); await settled; });
  await entered.promise;
  return { client, settled, release };
};

describe('app socket handlers', () => {
  let bus;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = makeBus();
    appsService.getAppById.mockImplementation(async (id) => APPS[id] ?? null);
  });

  describe('in-flight collision guard', () => {
    it('refuses a second update for the same app while one is running', async () => {
      const { client, settled, release } = await startParkedUpdate(bus, 'app-a');

      const second = connect(bus);
      await second.fire('app:update', { appId: 'app-a' });

      expect(second.last('app:update:error').payload).toMatchObject({
        appId: 'app-a',
        duplicate: true,
        message: 'An update is already running for Example App A',
      });
      expect(appUpdater.updateApp).toHaveBeenCalledTimes(1);

      release();
      await settled;
      expect(client.last('app:operations:active').payload.operations).toEqual([]);
    });

    it('refuses an update for a different app record sharing the same repoPath', async () => {
      const { settled, release } = await startParkedUpdate(bus, 'app-a');

      const other = connect(bus);
      await other.fire('app:update', { appId: 'app-b' });

      // app-b has no operation of its own — only the shared checkout collides.
      expect(other.last('app:update:error').payload).toMatchObject({
        appId: 'app-b',
        duplicate: true,
        message: 'An update is already running for Example App A',
      });
      expect(appUpdater.updateApp).toHaveBeenCalledTimes(1);

      // An unrelated checkout is unaffected by the guard.
      const unrelated = connect(bus);
      appUpdater.updateApp.mockResolvedValueOnce({ success: true, steps: [] });
      await unrelated.fire('app:update', { appId: 'app-c' });
      expect(unrelated.events('app:update:error')).toHaveLength(0);

      release();
      await settled;
    });

    it('refuses a standardize while an update is running on the same checkout', async () => {
      const { settled, release } = await startParkedUpdate(bus, 'app-a');

      const other = connect(bus);
      await other.fire('app:standardize', { appId: 'app-b' });

      expect(other.last('app:standardize:error').payload).toMatchObject({
        appId: 'app-b',
        duplicate: true,
        message: 'An update is already running for Example App A',
      });
      expect(pm2Standardizer.analyzeApp).not.toHaveBeenCalled();

      release();
      await settled;
    });
  });

  describe('active-operations buffer', () => {
    it('replays the in-flight operation to a reconnecting client with repoPath stripped and steps deduped', async () => {
      const { settled, release } = await startParkedUpdate(bus, 'app-a', {
        onEmit: (emit) => {
          emit('pull', 'running', 'Pulling...');
          emit('pull', 'done', 'Pulled 3 commits');
          emit('install', 'running', 'Installing...');
        },
      });

      // A remount is a brand-new connection: the handler pushes the buffer at
      // registration time, and again on demand.
      const remount = connect(bus);
      remount.fire('app:operations:list');

      const [onConnect, onDemand] = remount.events('app:operations:active');
      expect(onDemand.payload).toEqual(onConnect.payload);

      const [operation, ...rest] = onConnect.payload.operations;
      expect(rest).toEqual([]);
      expect(operation).toMatchObject({ appId: 'app-a', appName: 'Example App A', type: 'update' });
      // repoPath is a server-side detail and must never reach a client payload.
      expect(operation).not.toHaveProperty('repoPath');
      // Last-write-wins per step id, not one frame appended per emit.
      expect(operation.steps.map((s) => [s.step, s.status])).toEqual([
        ['pull', 'done'],
        ['install', 'running'],
      ]);

      release();
      await settled;
      expect(remount.last('app:operations:active').payload.operations).toEqual([]);
    });
  });

  describe('PortOS self-update handoff', () => {
    it('keeps the operation live and reports no completion once update.sh owns the restart', async () => {
      // update.sh pm2-deletes THIS process partway through, so appUpdater
      // returns as soon as the detached script is launched. Reporting the
      // operation "complete" here would clear the Git tab's progress row while
      // the script is still running, and clearing the operation would drop the
      // remaining STEP: frames on the floor — which is the "Stopping PortOS
      // apps..." freeze this handoff exists to fix.
      appUpdater.updateApp.mockResolvedValue({
        success: true,
        selfUpdateStarted: true,
        steps: [{ step: 'git-pull', success: true }, { step: 'app-update', success: true }],
      });
      const client = connect(bus);

      await client.fire('app:update', { appId: 'app-a' });

      expect(client.events('app:update:complete')).toHaveLength(0);
      expect(client.events('app:update:error')).toHaveLength(0);
      // The launch itself succeeded, so the ledger records it rather than
      // waiting for a completion that will never arrive.
      expect(logAction).toHaveBeenCalledWith(
        'update', 'app-a', 'Example App A',
        { steps: [{ step: 'git-pull', success: true }, { step: 'app-update', success: true }] },
        true, null,
      );
      expect(client.last('app:operations:active').payload.operations).toMatchObject([
        { appId: 'app-a', type: 'update' },
      ]);

      // Nothing ends this operation in production either — the process is
      // replaced. Without a process boundary the module state would leak into
      // every later test in the file.
      __resetAppOperations();
    });

    it('threads the PortOS preflight acknowledgements into the updater', async () => {
      // The launcher re-checks the image guard after taking the lock, so an
      // acknowledgement the user opted into here has to reach it or the retry
      // refuses again on the very guard they just acknowledged.
      appUpdater.updateApp.mockResolvedValue({ success: true, steps: [] });
      const client = connect(bus);

      await client.fire('app:update', {
        appId: 'app-a',
        acknowledgeFork: true,
        acknowledgePersistentMindImageBackup: true,
      });

      expect(appUpdater.updateApp).toHaveBeenCalledWith(
        APPS['app-a'],
        expect.any(Function),
        { syncFork: false, acknowledgeFork: true, acknowledgePersistentMindImageBackup: true },
      );
    });
  });

  describe('failure recovery', () => {
    it('records a failed update in the ledger, broadcasts the change, and clears the operation', async () => {
      appUpdater.updateApp.mockRejectedValue(new Error('git pull failed'));
      const client = connect(bus);

      await client.fire('app:update', { appId: 'app-a' });

      // `code` is always on the envelope — null for a plain failure, set for a
      // refusal the panel can offer an acknowledgement for.
      expect(client.last('app:update:error').payload).toEqual({ appId: 'app-a', code: null, message: 'git pull failed' });
      // A thrown update still gets a history row rather than vanishing from it.
      expect(logAction).toHaveBeenCalledWith('update', 'app-a', 'Example App A', { steps: [] }, false, 'git pull failed');
      expect(appsService.notifyAppsChanged).toHaveBeenCalledWith('update', 'app-a');
      // No success/complete frame may follow the failure.
      expect(client.events('app:update:complete')).toHaveLength(0);
      expect(client.last('app:operations:active').payload.operations).toEqual([]);
    });

    it('surfaces a standardize analyze failure as an error step and never reaches apply', async () => {
      pm2Standardizer.analyzeApp.mockRejectedValue(new Error('LLM provider unavailable'));
      const client = connect(bus);

      await client.fire('app:standardize', { appId: 'app-a' });

      expect(client.events('app:standardize:step').map((e) => [e.payload.step, e.payload.status])).toEqual([
        ['analyze', 'running'],
        ['analyze', 'error'],
      ]);
      expect(client.last('app:standardize:error').payload).toEqual({
        appId: 'app-a',
        message: 'LLM provider unavailable',
      });
      expect(pm2Standardizer.applyStandardization).not.toHaveBeenCalled();
      expect(client.events('app:standardize:complete')).toHaveLength(0);
      expect(client.last('app:operations:active').payload.operations).toEqual([]);
    });

    it('leaves the app record untouched when standardize fails at the apply stage', async () => {
      pm2Standardizer.analyzeApp.mockResolvedValue({
        success: true,
        proposedChanges: { processes: [{ name: 'example-web' }] },
      });
      pm2Standardizer.applyStandardization.mockResolvedValue({ success: false, errors: ['ecosystem.config.cjs exists'] });
      const client = connect(bus);

      await client.fire('app:standardize', { appId: 'app-a' });

      expect(client.last('app:standardize:error').payload).toEqual({
        appId: 'app-a',
        message: 'ecosystem.config.cjs exists',
      });
      // pm2ProcessNames must not be persisted from a standardization that
      // never wrote the config those names describe.
      expect(appsService.updateApp).not.toHaveBeenCalled();
      expect(client.events('app:standardize:complete')).toHaveLength(0);
      expect(client.last('app:operations:active').payload.operations).toEqual([]);
    });
  });
});
