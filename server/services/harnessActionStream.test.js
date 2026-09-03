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

import { streamHarnessAction, __resetHarnessActionGuard } from './harnessActionStream.js';

const makeChild = () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
};

const app = () => {
  const server = express();
  server.post('/action', (req, res, next) => {
    streamHarnessAction(req, res, { runtime: req.query.runtime, action: req.query.action }).catch(next);
  });
  server.use(errorMiddleware);
  return server;
};

/** Drive one action to completion with a fake child that exits `code`. */
const runAction = async (query, { code = 0, stdout = '' } = {}) => {
  const child = makeChild();
  installer.spawnRuntimeInstaller.mockReturnValueOnce(child);
  const responsePromise = request(app()).post(`/action?${query}`).then((r) => r);
  await vi.waitFor(() => expect(installer.spawnRuntimeInstaller).toHaveBeenCalled());
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
});

describe('streamHarnessAction — update', () => {
  it('reports the version transition the update actually produced', async () => {
    installer.getProviderRuntimeStatus
      .mockResolvedValueOnce(statusOf('opencode'))
      .mockResolvedValueOnce(statusOf('opencode', { version: '1.19.0' }));

    const response = await runAction('runtime=opencode&action=update', { stdout: 'upgraded\n' });

    expect(installer.spawnRuntimeInstaller).toHaveBeenCalledWith('opencode', { action: 'update' });
    expect(response.text).toContain('OpenCode CLI updated: 1.18.27 → 1.19.0.');
    expect(response.text).toContain('upgraded');
  });

  // "Up to date" asserted from an exit code alone contradicts the row behind the
  // modal, which still shows Update-available against the published version. Say
  // what the version did instead.
  it('does not claim currency when the version did not move', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('opencode'));

    const response = await runAction('runtime=opencode&action=update');

    expect(response.text).toContain('left it on 1.18.27');
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

    expect(installer.spawnRuntimeInstaller).toHaveBeenCalledWith('opencode', { action: 'update' });
  });

  it('refuses to update a harness that is not installed', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValueOnce(statusOf('opencode', { installed: false }));

    const response = await request(app()).post('/action?runtime=opencode&action=update');

    expect(response.text).toContain('nothing to update');
    expect(installer.spawnRuntimeInstaller).not.toHaveBeenCalled();
  });

  // A vendor self-updater runs the harness's OWN binary, which the installed
  // check already proved runnable — a missing `curl`/`npm` is irrelevant to it,
  // and blocking on that would strand a script-installed CLI with no update path.
  it('runs a vendor self-updater even when the host install tool is missing', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('agy', {
      method: 'script', installable: false, blockedReason: 'curl is not available.',
    }));

    await runAction('runtime=agy&action=update');

    expect(installer.spawnRuntimeInstaller).toHaveBeenCalledWith('agy', { action: 'update' });
  });
});

describe('streamHarnessAction — uninstall', () => {
  it('confirms removal only when the binary is really gone', async () => {
    installer.getProviderRuntimeStatus
      .mockResolvedValueOnce(statusOf('opencode'))
      .mockResolvedValueOnce(statusOf('opencode', { installed: false }));

    const response = await runAction('runtime=opencode&action=uninstall');

    expect(response.text).toContain('has been removed');
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
  it('rejects an unknown action and an unknown runtime before the headers flush', async () => {
    expect((await request(app()).post('/action?runtime=opencode&action=purge')).status).toBe(400);
    expect((await request(app()).post('/action?runtime=nope&action=install')).status).toBe(400);
    expect(installer.spawnRuntimeInstaller).not.toHaveBeenCalled();
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
    installer.spawnRuntimeInstaller.mockReturnValueOnce(child);

    const first = request(app()).post('/action?runtime=opencode&action=update').then((r) => r);
    await vi.waitFor(() => expect(installer.spawnRuntimeInstaller).toHaveBeenCalled());

    const second = await request(app()).post('/action?runtime=opencode&action=uninstall');
    expect(second.text).toContain('Another harness install is already running');
    expect(installer.spawnRuntimeInstaller).toHaveBeenCalledTimes(1);

    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    await first;
  });
});
