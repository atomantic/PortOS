/**
 * The install half of this loop is covered end-to-end through the real
 * `/api/providers/runtimes/install` route (`routes/providers.runtimeInstall.test.js`).
 * These cases cover what the extraction ADDED: the update and remove lanes, and
 * the guards that keep them from doing an install's thing.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const RUNTIMES = {
  opencode: { id: 'opencode', label: 'OpenCode CLI', command: 'opencode', install: { kind: 'npm', package: 'opencode-ai@latest' }, selfUpdate: ['upgrade'] },
  agy: { id: 'agy', label: 'Antigravity CLI', command: 'agy', install: { kind: 'script', url: 'https://example.invalid/i.sh' }, selfUpdate: ['update'] },
};

const statusOf = (id, overrides) => ({
  ...RUNTIMES[id], installed: true, version: '1.18.27', method: 'npm', installable: true, blockedReason: null, ...overrides,
});

const installer = vi.hoisted(() => ({
  getProviderRuntime: vi.fn(),
  getProviderRuntimeStatus: vi.fn(),
  spawnRuntimeInstaller: vi.fn(),
  stopRuntimeInstaller: vi.fn(),
  describeRuntimeInstall: vi.fn(),
  buildRuntimeActionCommand: vi.fn(),
  RUNTIME_ACTIONS: ['install', 'update', 'uninstall'],
}));
vi.mock('./providerRuntimeInstaller.js', () => installer);
const activity = vi.hoisted(() => ({ countActiveCosAgents: vi.fn() }));
vi.mock('./updatePreflight.js', () => activity);
const records = vi.hoisted(() => ({ readAgentsStateForSafetyCheck: vi.fn() }));
vi.mock('./cosState.js', () => records);
vi.mock('./cosAgentLifecycle.js', () => ({ isLiveAgentRecord: agent => Boolean(agent) && agent.status !== 'completed' }));
const gate = vi.hoisted(() => ({ status: vi.fn(), active: null, harnessActions: { reserve: vi.fn(), finish: vi.fn(), operation: vi.fn() } }));
vi.mock('../lib/maintenanceAdmission.js', () => ({ maintenance: gate }));
const settlement = vi.hoisted(() => ({ processAbsent: vi.fn() }));
vi.mock('../lib/maintenanceDeferredUpdate.js', () => settlement);
const supervisor = vi.hoisted(() => ({ spawnHarnessActionSupervisor: vi.fn() }));
vi.mock('./harnessActionSupervisor.js', () => supervisor);
const group = vi.hoisted(() => ({ isSupervisorOnly: vi.fn() }));
vi.mock('./harnessProcessGroup.js', () => group);
const runner = vi.hoisted(() => ({ getActiveAgentsFromRunner: vi.fn() }));
vi.mock('./cosRunnerClient.js', () => runner);
const recovery = vi.hoisted(() => ({ checkHarnessActionRecovery: vi.fn() }));
vi.mock('./harnessActionRecovery.js', () => recovery);
const reference = vi.hoisted(() => ({ matchesHarnessUpdateTicket: vi.fn() }));
vi.mock('./harnessUpdateReference.js', () => reference);
const review = vi.hoisted(() => ({ getRuntimeUpdateReviewSnapshot: vi.fn() }));
vi.mock('./runtimeUpdateReview.js', () => review);

import { streamHarnessAction, __resetHarnessActionGuard } from './harnessActionStream.js';
import { runtimeUpdateEvents } from './runtimeUpdateEvents.js';
const supervised = ['darwin', 'linux'].includes(process.platform);
const launch = supervised ? supervisor.spawnHarnessActionSupervisor : installer.spawnRuntimeInstaller;
const expectLaunch = (id, action) => supervised
  ? expect(launch).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'fixture-owner', runtime: id, action }))
  : expect(launch).toHaveBeenCalledWith(id, { action });

const makeChild = () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.killed = false;
  child.connected = true;
  child.send = vi.fn((_message, callback) => callback?.());
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
};

const app = () => {
  const server = express();
  server.post('/action', (req, res, next) => {
    streamHarnessAction(req, res, { runtime: req.query.runtime, action: req.query.action,
      ...(req.query.requireIdle === '1' ? { requireIdle: true, reviewed: { candidate: '1.19.0', identity: { path: '/fixture/opencode' } } } : {}),
      ...(req.query.expectedVersion ? { expectedVersion: req.query.expectedVersion } : {}) }).catch(next);
  });
  server.use(errorMiddleware);
  return server;
};

/** Drive one action to completion with a fake child that exits `code`. */
const runAction = async (query, { code = 0, stdout = '' } = {}) => {
  const child = makeChild();
  launch.mockReturnValueOnce(child);
  const responsePromise = request(app()).post(`/action?${query}`).then((r) => r);
  await vi.waitFor(() => expect(launch).toHaveBeenCalled());
  child.stdout.end(stdout);
  child.stderr.end();
  child.emit('close', code);
  return responsePromise;
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetHarnessActionGuard();
  installer.getProviderRuntime.mockImplementation((id) => RUNTIMES[id] || null);
  installer.describeRuntimeInstall.mockImplementation((id, action) => `${id} ${action}`);
  installer.buildRuntimeActionCommand.mockImplementation((id) => (RUNTIMES[id] ? { command: id, args: [] } : null));
  activity.countActiveCosAgents.mockResolvedValue(0);
  records.readAgentsStateForSafetyCheck.mockResolvedValue({ trusted: true, agents: {} });
  gate.active = null;
  gate.harnessActions.reserve.mockImplementation(({ exclusive }) => {
    gate.active = { id: 'fixture-owner', holdId: exclusive ? 'fixture-hold' : null, holdRevision: exclusive ? 1 : null };
    return gate.active;
  });
  gate.harnessActions.finish.mockImplementation(() => {
    const held = Boolean(gate.active?.holdId);
    const overlap = gate.active?.overlap === true;
    gate.active = null;
    return { held, overlap };
  });
  gate.harnessActions.operation.mockImplementation(() => gate.active);
  gate.status.mockImplementation(() => gate.active?.holdId
    ? { state: 'draining', hold: { id: gate.active.holdId, revision: gate.active.holdRevision }, blockers: [{ kind: 'harness-action' }] }
    : { state: 'normal', blockers: [] });
  settlement.processAbsent.mockReturnValue(true);
  group.isSupervisorOnly.mockResolvedValue(true);
  runner.getActiveAgentsFromRunner.mockResolvedValue([]);
  recovery.checkHarnessActionRecovery.mockResolvedValue(undefined);
  reference.matchesHarnessUpdateTicket.mockResolvedValue(true);
  review.getRuntimeUpdateReviewSnapshot.mockReturnValue({ items: [{ id: 'harness:opencode', harnessUpdate: {
    installedVersion: '1.18.27', candidateVersion: '1.19.0', updatable: true,
  } }] });
});

describe('streamHarnessAction — update', () => {
  it('reports the version transition the update actually produced', async () => {
    const changed = vi.fn();
    runtimeUpdateEvents.once('changed', changed);
    installer.getProviderRuntimeStatus
      .mockResolvedValueOnce(statusOf('opencode'))
      .mockResolvedValueOnce(statusOf('opencode', { version: '1.19.0' }));

    const response = await runAction('runtime=opencode&action=update', { stdout: 'upgraded\n' });

    expectLaunch('opencode', 'update');
    expect(response.text).toContain('OpenCode CLI updated: 1.18.27 → 1.19.0.');
    expect(response.text).toContain('upgraded');
    expect(changed).toHaveBeenCalledOnce();
  });

  // "Up to date" asserted from an exit code alone contradicts the row behind the
  // modal, which still shows Update-available against the published version. Say
  // what the version did instead.
  it('does not claim currency when the version did not move', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));

    const response = await runAction('runtime=opencode&action=update');

    expect(response.text).toContain('still observes version 1.18.27');
    expect(response.text).not.toContain('up to date');
  });

  it('says so when it could not read a version to compare', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode', { version: null }));

    const response = await runAction('runtime=opencode&action=update');

    expect(response.text).toContain('could not read a version to compare');
  });

  // An install short-circuits on "already there"; an update must NOT — that is
  // the whole point of the button, and "you are on the latest" is the vendor
  // updater's answer to give, not ours to guess from a cached registry read.
  it('does not short-circuit on an already-installed harness', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));

    await runAction('runtime=opencode&action=update');

    expectLaunch('opencode', 'update');
  });

  it('refuses to update a harness that is not installed', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValueOnce(statusOf('opencode', { installed: false }));

    const response = await request(app()).post('/action?runtime=opencode&action=update');

    expect(response.text).toContain('nothing to update');
    expect(launch).not.toHaveBeenCalled();
  });

  // A vendor self-updater runs the harness's OWN binary, which the installed
  // check already proved runnable — a missing `curl`/`npm` is irrelevant to it,
  // and blocking on that would strand a script-installed CLI with no update path.
  it('runs a vendor self-updater even when the host install tool is missing', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('agy', {
      method: 'script', installable: false, blockedReason: 'curl is not available.',
    }));

    await runAction('runtime=agy&action=update');

    expectLaunch('agy', 'update');
  });
});

describe('streamHarnessAction — uninstall', () => {
  it('confirms removal only when the binary is really gone', async () => {
    const changed = vi.fn();
    runtimeUpdateEvents.once('changed', changed);
    installer.getProviderRuntimeStatus
      .mockResolvedValueOnce(statusOf('opencode'))
      .mockResolvedValueOnce(statusOf('opencode', { installed: false, probeState: 'missing' }));

    const response = await runAction('runtime=opencode&action=uninstall');

    expect(response.text).toContain('has been removed');
    expect(changed).toHaveBeenCalledWith({ removedHarness: 'opencode' });
  });

  // "npm said ok" is not "PortOS can no longer run it": a Homebrew or vendor
  // script copy PortOS never wrote is still on PATH, and reporting success
  // would leave the user believing a removal that did not happen.
  it('reports a survivor on PATH as an error, not a success', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));

    const response = await runAction('runtime=opencode&action=uninstall');

    expect(response.text).toContain('"type":"error"');
    expect(response.text).toContain('can still run');
  });
});

describe('streamHarnessAction — guards', () => {
  it.skipIf(!supervised)('does not update over active or unreadable PortOS agent work', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    activity.countActiveCosAgents.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('unavailable'));
    expect((await request(app()).post('/action?runtime=opencode&action=update&requireIdle=1')).text).toContain('PortOS work is active or starting');
    expect((await request(app()).post('/action?runtime=opencode&action=update&requireIdle=1')).text).toContain('Could not check active PortOS work');
    expect(launch).not.toHaveBeenCalled();
  });

  it.skipIf(!supervised)('also refuses a Harnesses-page update while PortOS work is active', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    activity.countActiveCosAgents.mockResolvedValueOnce(1);
    const response = await request(app()).post('/action?runtime=opencode&action=update');
    expect(response.text).toContain('PortOS work is active or starting');
    expect(launch).not.toHaveBeenCalled();
    expect(gate.harnessActions.reserve).toHaveBeenCalledWith({ runtime: 'opencode', action: 'update', exclusive: true });
  });

  it.skipIf(!supervised)('distinguishes an unavailable journal from ordinary busy work', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    gate.harnessActions.reserve.mockImplementationOnce(() => { throw Object.assign(new Error('unavailable'), { code: 'MAINTENANCE_UNAVAILABLE' }); });
    const response = await request(app()).post('/action?runtime=opencode&action=update');
    expect(response.text).toContain('Review maintenance status and recovery');
    expect(launch).not.toHaveBeenCalled();
  });

  it.skipIf(!supervised)('refuses an unreachable or malformed runner inventory before launching', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    runner.getActiveAgentsFromRunner.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ agents: [] });
    for (let i = 0; i < 2; i += 1) {
      expect((await request(app()).post('/action?runtime=opencode&action=update&requireIdle=1')).text).toContain('The CoS runner could not be checked');
    }
    expect(launch).not.toHaveBeenCalled();
    expect(gate.harnessActions.finish).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(recovery.checkHarnessActionRecovery).toHaveBeenCalledTimes(2));
  });

  it.skipIf(!supervised)('releases a starting hold when a preflight read times out or the client disconnects', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    activity.countActiveCosAgents.mockImplementation(() => new Promise(() => {}));
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn(() => { res.writableEnded = true; });
    await streamHarnessAction({}, res, { runtime: 'opencode', action: 'update', preflightTimeoutMs: 30 });
    expect(res.write.mock.calls.flat().join('')).toContain('Checking PortOS work timed out');
    expect(gate.harnessActions.finish).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    gate.harnessActions.finish.mockClear();
    const disconnected = new EventEmitter();
    disconnected.writableEnded = false;
    disconnected.writeHead = vi.fn(); disconnected.write = vi.fn(); disconnected.end = vi.fn(() => { disconnected.writableEnded = true; });
    const pending = streamHarnessAction({}, disconnected, { runtime: 'opencode', action: 'update', preflightTimeoutMs: 5000 });
    await vi.waitFor(() => expect(gate.harnessActions.reserve).toHaveBeenCalledTimes(2));
    disconnected.emit('close');
    await pending;
    expect(gate.harnessActions.finish).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
  });

  it.skipIf(!supervised)('releases a starting hold when the review recheck does not finish', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    reference.matchesHarnessUpdateTicket.mockImplementationOnce(() => new Promise(() => {}));
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn(() => { res.writableEnded = true; });
    await streamHarnessAction({}, res, { runtime: 'opencode', action: 'update', requireIdle: true,
      expectedVersion: '1.18.27', reviewed: { candidate: '1.19.0', identity: { path: '/fixture/opencode' } }, preflightTimeoutMs: 30 });
    expect(res.write.mock.calls.flat().join('')).toContain('review could not be checked in time');
    expect(gate.harnessActions.finish).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
  });

  it.skipIf(!supervised)('retains the hold after cancellation while a descendant remains in the group', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    settlement.processAbsent.mockReturnValue(false);
    const child = makeChild();
    launch.mockReturnValueOnce(child);
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn(() => { res.writableEnded = true; });
    await streamHarnessAction({}, res, { runtime: 'opencode', action: 'update', requireIdle: true,
      expectedVersion: '1.18.27', reviewed: { candidate: '1.19.0', identity: { path: '/fixture/opencode' } } });
    res.emit('close');
    expect(installer.stopRuntimeInstaller).toHaveBeenCalledWith(child);
    child.stdout.end(); child.stderr.end(); child.emit('close', 1);
    await vi.waitFor(() => expect(settlement.processAbsent).toHaveBeenCalledWith(-123));
    expect(gate.harnessActions.finish).not.toHaveBeenCalled();
    expect(recovery.checkHarnessActionRecovery).not.toHaveBeenCalled();
    settlement.processAbsent.mockReturnValue(true);
    await vi.waitFor(() => expect(gate.harnessActions.finish).toHaveBeenCalledWith('fixture-owner', 123), { timeout: 2000 });
    await vi.waitFor(() => expect(recovery.checkHarnessActionRecovery).toHaveBeenCalledOnce());
  });

  it.skipIf(!supervised)('also refuses when persisted agents or maintenance blockers indicate work', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    records.readAgentsStateForSafetyCheck.mockResolvedValueOnce({ trusted: true, agents: { a: { status: 'running' } } });
    expect((await request(app()).post('/action?runtime=opencode&action=update&requireIdle=1')).text).toContain('PortOS work is active');
    records.readAgentsStateForSafetyCheck.mockResolvedValueOnce({ trusted: true, agents: { a: { status: 'paused' } } });
    expect((await request(app()).post('/action?runtime=opencode&action=update&requireIdle=1')).text).toContain('Paused agents still count as work');
    gate.status.mockReturnValue({ state: 'draining', hold: { id: 'fixture-hold', revision: 1 }, blockers: [{ kind: 'harness-action' }, { kind: 'media' }] });
    expect((await request(app()).post('/action?runtime=opencode&action=update&requireIdle=1')).text).toContain('Could not check active PortOS work');
    expect(launch).not.toHaveBeenCalled();
  });

  it.skipIf(!supervised)('does not disclose the reviewed executable path in a startup failure', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    launch.mockImplementationOnce(() => { throw Object.assign(new Error('spawn /fixture/opencode denied'), { code: 'EACCES' }); });
    const response = await request(app()).post('/action?runtime=opencode&action=update&requireIdle=1&expectedVersion=1.18.27');
    expect(response.text).toContain('EACCES');
    expect(response.text).not.toContain('/fixture/opencode');
  });

  it.skipIf(!supervised)('rechecks candidate and executable and passes the review to the supervisor', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    reference.matchesHarnessUpdateTicket.mockResolvedValueOnce(false);
    expect((await request(app()).post('/action?runtime=opencode&action=update&requireIdle=1&expectedVersion=1.18.27')).text).toContain('review, executable, or active work changed');
    review.getRuntimeUpdateReviewSnapshot.mockReturnValueOnce({ items: [{ id: 'harness:opencode', harnessUpdate: {
      installedVersion: '1.18.27', candidateVersion: '1.19.1', updatable: true,
    } }] });
    expect((await request(app()).post('/action?runtime=opencode&action=update&requireIdle=1&expectedVersion=1.18.27')).text).toContain('review, executable, or active work changed');
    expect(launch).not.toHaveBeenCalled();
    await runAction('runtime=opencode&action=update&requireIdle=1&expectedVersion=1.18.27');
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'opencode', action: 'update', reviewed: {
      candidate: '1.19.0', identity: { path: '/fixture/opencode' },
    } }));
  });

  it.skipIf(!supervised)('refuses the wrapper go-ahead if the reviewed candidate changes during startup', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    const child = makeChild();
    launch.mockReturnValueOnce(child);
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn(() => { res.writableEnded = true; });
    await streamHarnessAction({}, res, { runtime: 'opencode', action: 'update', requireIdle: true,
      expectedVersion: '1.18.27', reviewed: { candidate: '1.19.0', identity: { path: '/fixture/opencode' } } });
    review.getRuntimeUpdateReviewSnapshot.mockReturnValue({ items: [{ id: 'harness:opencode', harnessUpdate: {
      installedVersion: '1.18.27', candidateVersion: '1.19.1', updatable: true,
    } }] });
    child.emit('message', { type: 'harness-action-ready', ownerId: 'fixture-owner' });
    await vi.waitFor(() => expect(installer.stopRuntimeInstaller).toHaveBeenCalledWith(child));
    expect(child.send).not.toHaveBeenCalled();
    expect(res.write.mock.calls.flat().join('')).toContain('changed before launch');
    child.stdout.end(); child.stderr.end(); child.emit('close', 1);
    await vi.waitFor(() => expect(gate.harnessActions.finish).toHaveBeenCalled());
  });

  it.skipIf(!supervised)('sends one owner-bound go-ahead after the wrapper is ready', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    const child = makeChild();
    launch.mockReturnValueOnce(child);
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn(() => { res.writableEnded = true; });
    await streamHarnessAction({}, res, { runtime: 'opencode', action: 'update', requireIdle: true,
      expectedVersion: '1.18.27', reviewed: { candidate: '1.19.0', identity: { path: '/fixture/opencode' } } });
    child.emit('message', { type: 'harness-action-ready', ownerId: 'fixture-owner' });
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith({ type: 'harness-action-go', ownerId: 'fixture-owner' }, expect.any(Function)));
    child.emit('message', { type: 'harness-action-ready', ownerId: 'fixture-owner' });
    await vi.waitFor(() => expect(installer.stopRuntimeInstaller).toHaveBeenCalledWith(child));
    expect(child.send).toHaveBeenCalledOnce();
    child.stdout.end(); child.stderr.end(); child.emit('close', 1);
    await vi.waitFor(() => expect(gate.harnessActions.finish).toHaveBeenCalled());
  });

  it.skipIf(!supervised)('does not signal a wrapper after it exits while a review check is pending', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    const child = makeChild();
    launch.mockReturnValueOnce(child);
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn(() => { res.writableEnded = true; });
    await streamHarnessAction({}, res, { runtime: 'opencode', action: 'update', requireIdle: true,
      expectedVersion: '1.18.27', reviewed: { candidate: '1.19.0', identity: { path: '/fixture/opencode' } } });
    let resolveProof;
    reference.matchesHarnessUpdateTicket.mockImplementationOnce(() => new Promise(resolve => { resolveProof = resolve; }));
    child.emit('message', { type: 'harness-action-ready', ownerId: 'fixture-owner' });
    await vi.waitFor(() => expect(resolveProof).toBeTypeOf('function'));
    child.emit('exit', 0);
    child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    await vi.waitFor(() => expect(gate.harnessActions.finish).toHaveBeenCalled());
    resolveProof(true);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(installer.stopRuntimeInstaller).not.toHaveBeenCalled();
    expect(child.send).not.toHaveBeenCalled();
  });

  it.skipIf(!supervised)('explains an unavailable process inspection and keeps the supervisor alive', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    group.isSupervisorOnly.mockResolvedValue(null);
    const child = makeChild();
    launch.mockReturnValueOnce(child);
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn(() => { res.writableEnded = true; });
    await streamHarnessAction({}, res, { runtime: 'opencode', action: 'update' });
    child.emit('message', { type: 'harness-action-ready', ownerId: 'fixture-owner' });
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledOnce());
    child.emit('message', { type: 'harness-action-draining', ownerId: 'fixture-owner' });
    await vi.waitFor(() => expect(res.write.mock.calls.flat().join('')).toContain('Process inspection is unavailable'));
    expect(child.send).toHaveBeenCalledOnce();
    child.emit('exit', 1);
    child.stdout.end(); child.stderr.end(); child.emit('close', 1);
    await vi.waitFor(() => expect(gate.harnessActions.finish).toHaveBeenCalled());
  });

  it.skipIf(!supervised)('lets the wrapper exit only after it is alone in its process group', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    group.isSupervisorOnly.mockResolvedValue(true);
    const child = makeChild();
    launch.mockReturnValueOnce(child);
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn(() => { res.writableEnded = true; });
    await streamHarnessAction({}, res, { runtime: 'opencode', action: 'update' });
    child.emit('message', { type: 'harness-action-ready', ownerId: 'fixture-owner' });
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledOnce());
    child.emit('message', { type: 'harness-action-draining', ownerId: 'fixture-owner' });
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith({ type: 'harness-action-finish', ownerId: 'fixture-owner' }, expect.any(Function)));
    expect(gate.harnessActions.finish).not.toHaveBeenCalled();
    child.emit('exit', 0);
    child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    await vi.waitFor(() => expect(gate.harnessActions.finish).toHaveBeenCalledWith('fixture-owner', 123));
  });

  it.skipIf(!supervised)('stops a running updater when existing PortOS work is recovered', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    const child = makeChild();
    launch.mockReturnValueOnce(child);
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn(() => { res.writableEnded = true; });
    await streamHarnessAction({}, res, { runtime: 'opencode', action: 'update' });
    child.emit('message', { type: 'harness-action-ready', ownerId: 'fixture-owner' });
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledOnce());
    gate.active.overlap = true;
    gate.active.invalidated = true;
    await vi.waitFor(() => expect(installer.stopRuntimeInstaller).toHaveBeenCalledWith(child), { timeout: 2000 });
    expect(res.write.mock.calls.flat().join('')).toContain('recovered existing work');
    child.emit('exit', 1);
    child.stdout.end(); child.stderr.end(); child.emit('close', 1);
    await vi.waitFor(() => expect(gate.harnessActions.finish).toHaveBeenCalled());
  });

  it.skipIf(!supervised)('stops a running updater when maintenance state becomes unreadable', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    const child = makeChild();
    launch.mockReturnValueOnce(child);
    const res = new EventEmitter();
    res.writableEnded = false;
    res.writeHead = vi.fn(); res.write = vi.fn(); res.end = vi.fn(() => { res.writableEnded = true; });
    await streamHarnessAction({}, res, { runtime: 'opencode', action: 'update' });
    child.emit('message', { type: 'harness-action-ready', ownerId: 'fixture-owner' });
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledOnce());
    gate.harnessActions.operation.mockImplementation(() => { throw new Error('unavailable'); });
    await vi.waitFor(() => expect(installer.stopRuntimeInstaller).toHaveBeenCalledWith(child), { timeout: 2000 });
    expect(res.write.mock.calls.flat().join('')).toContain('Maintenance state became unavailable or changed');
    child.emit('exit', 1);
    child.stdout.end(); child.stderr.end(); child.emit('close', 1);
    await vi.waitFor(() => expect(gate.harnessActions.finish).toHaveBeenCalled());
  });

  it('refuses a stale inline update when the installed version changed', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode', { version: '1.19.0' }));
    const response = await request(app()).post('/action?runtime=opencode&action=update&requireIdle=1&expectedVersion=1.18.27');
    expect(response.text).toContain('version changed');
    expect(launch).not.toHaveBeenCalled();
  });
  it('rejects an unknown action and an unknown runtime before the headers flush', async () => {
    expect((await request(app()).post('/action?runtime=opencode&action=purge')).status).toBe(400);
    expect((await request(app()).post('/action?runtime=nope&action=install')).status).toBe(400);
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects an action this runtime does not support, naming the vendor path instead', async () => {
    // Antigravity ships no uninstall PortOS can run.
    installer.buildRuntimeActionCommand.mockReturnValueOnce(null);

    const response = await request(app()).post('/action?runtime=agy&action=uninstall');

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('vendor instructions');
  });

  it('holds one action at a time across every lane', async () => {
    // npm's global prefix is one directory; an update racing an install there is
    // exactly the corruption this guard exists to prevent.
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));
    const child = makeChild();
    launch.mockReturnValueOnce(child);

    const first = request(app()).post('/action?runtime=opencode&action=update').then((r) => r);
    await vi.waitFor(() => expect(launch).toHaveBeenCalled());

    const second = await request(app()).post('/action?runtime=opencode&action=uninstall');
    expect(second.text).toContain('Another harness install is already running');
    expect(launch).toHaveBeenCalledTimes(1);

    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    await first;
  });
});
