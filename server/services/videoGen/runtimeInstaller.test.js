import { EventEmitter } from 'node:events';
import { existsSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from '../../lib/childProcess.js';
import { spawnSetupScript, stopSetupScript } from '../../lib/setupScriptRunner.js';
import { getVideoRuntimeStatus, streamVideoRuntimeInstall } from './runtimeInstaller.js';
import { BYOV_RUNTIME_INFO, isByovRuntimeCurrent, isByovRuntimeInstalled, isByovRuntimeReady } from './runtimes.js';

vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal();
  return { ...fs, existsSync: vi.fn(fs.existsSync) };
});

vi.mock('../../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  spawn: vi.fn(),
}));

vi.mock('../../lib/setupScriptRunner.js', async () => {
  const { fileURLToPath } = await import('node:url');
  return {
    SETUP_IMAGE_VIDEO_SCRIPT: fileURLToPath(new URL('../../../scripts/setup-image-video.sh', import.meta.url)),
    spawnSetupScript: vi.fn(),
    stopSetupScript: vi.fn(),
  };
});

vi.mock('../../lib/installLogger.js', () => ({
  createInstallLogger: () => ({ start: vi.fn(), onEvent: vi.fn(), cancel: vi.fn() }),
}));

vi.mock('./runtimes.js', async (importOriginal) => ({
  BYOV_RUNTIME_INFO: {
    ...(await importOriginal()).BYOV_RUNTIME_INFO,
    example: {
      id: 'example',
      label: 'Example',
      installEnvVar: 'INSTALL_EXAMPLE',
      venvPython: '/example/venv/python',
    },
  },
  invalidateByovLoraCapabilityCache: vi.fn(),
  invalidateByovReadyCache: vi.fn(),
  invalidateRuntimeFingerprintCache: vi.fn(),
  isByovRuntimeInstalled: vi.fn(),
  isByovRuntimeCurrent: vi.fn(),
  isByovRuntimeReady: vi.fn(),
}));

function stream({ onSend, runtime = 'example' } = {}) {
  const close = Promise.withResolvers();
  const connection = new EventEmitter();
  let ended = false;
  const send = vi.fn(onSend ? (event) => onSend(event, connection) : undefined);
  const safeEnd = vi.fn(() => {
    ended = true;
    close.resolve();
    connection.emit('close');
  });
  const started = streamVideoRuntimeInstall({
    runtime,
    send,
    safeEnd,
    onDisconnect: (handler) => connection.on('close', handler),
    isResponseEnded: () => ended,
  });
  return { started, send, safeEnd, closed: close.promise, disconnect: () => connection.emit('close') };
}

function mockChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  spawnSetupScript.mockReturnValueOnce(child);
  return child;
}

describe('streamVideoRuntimeInstall', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    isByovRuntimeInstalled.mockReturnValue(true);
    isByovRuntimeCurrent.mockResolvedValue(true);
    isByovRuntimeReady.mockResolvedValue(true);
  });

  it('rejects overlapping callers without letting their disconnect release the active preflight', async () => {
    const revision = Promise.withResolvers();
    isByovRuntimeCurrent.mockReturnValueOnce(revision.promise);
    const first = stream();
    const second = stream({ onSend: (_event, connection) => connection.emit('close') });
    await second.started;
    const third = stream();
    await third.started;

    revision.resolve(true);
    await first.started;

    expect(second.send).toHaveBeenCalledWith({ type: 'error', message: expect.stringContaining('already running') });
    expect(third.send).toHaveBeenCalledWith({ type: 'error', message: expect.stringContaining('already running') });
    expect(second.safeEnd).toHaveBeenCalledOnce();
    expect(third.safeEnd).toHaveBeenCalledOnce();
    expect(first.send).toHaveBeenLastCalledWith({ type: 'complete', message: expect.any(String) });
    expect(isByovRuntimeCurrent).toHaveBeenCalledOnce();
    expect(spawnSetupScript).not.toHaveBeenCalled();
  });

  it.each([
    ['revision', isByovRuntimeCurrent],
    ['readiness', isByovRuntimeReady],
  ])('closes the stream and permits a retry when the %s probe rejects', async (name, probe) => {
    probe.mockRejectedValueOnce(new Error(`${name} unavailable`));
    const failure = stream();
    await failure.started;

    expect(failure.send).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      message: `Example install preflight failed: ${name} unavailable`,
    });
    expect(failure.safeEnd).toHaveBeenCalledOnce();

    const retry = stream();
    await retry.started;
    expect(retry.send).toHaveBeenLastCalledWith({ type: 'complete', message: expect.any(String) });
    expect(spawnSetupScript).not.toHaveBeenCalled();
  });

  it('does not release a newer reservation when a disconnected preflight rejects', async () => {
    const oldRevision = Promise.withResolvers();
    const newRevision = Promise.withResolvers();
    isByovRuntimeCurrent.mockReturnValueOnce(oldRevision.promise).mockReturnValueOnce(newRevision.promise);
    const first = stream();
    first.disconnect();
    const retry = stream();

    oldRevision.reject(new Error('first probe failed after disconnect'));
    await first.started;
    const overlapping = stream();
    await overlapping.started;
    newRevision.resolve(true);
    await retry.started;

    expect(first.send).not.toHaveBeenCalled();
    expect(overlapping.send).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      message: expect.stringContaining('already running'),
    });
    expect(retry.send).toHaveBeenLastCalledWith({ type: 'complete', message: expect.any(String) });
  });

  it('holds the reservation until a cancelled child closes and skips all post-exit work', async () => {
    isByovRuntimeInstalled.mockReturnValueOnce(false);
    const child = mockChildProcess();
    const first = stream();
    await first.started;
    child.stdout.emit('data', 'buffered installer progress');
    first.send.mockClear();

    first.disconnect();
    const overlapping = stream();
    await overlapping.started;
    expect(stopSetupScript).toHaveBeenCalledExactlyOnceWith(child);
    expect(overlapping.send).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      message: expect.stringContaining('already running'),
    });

    child.emit('close', null);
    expect(isByovRuntimeInstalled).toHaveBeenCalledOnce();
    expect(isByovRuntimeCurrent).not.toHaveBeenCalled();
    expect(isByovRuntimeReady).not.toHaveBeenCalled();
    expect(first.send).not.toHaveBeenCalled();
    expect(first.safeEnd).not.toHaveBeenCalled();

    const retry = stream();
    await retry.started;
    expect(retry.send).toHaveBeenLastCalledWith({ type: 'complete', message: expect.any(String) });
    expect(spawnSetupScript).toHaveBeenCalledOnce();
  });

  it.each([
    { installed: true, current: true, ready: true, type: 'complete', message: 'Example ready:' },
    { installed: false, current: false, ready: false, type: 'error', message: 'runtime is still missing' },
    { installed: true, current: false, ready: false, type: 'error', message: 'still out of date' },
    { installed: true, current: true, ready: false, type: 'error', message: "can't import its core packages" },
  ])('checks the installed runtime after exit 0 and reports $message', async ({ installed, current, ready, type, message }) => {
    isByovRuntimeInstalled.mockReturnValueOnce(false).mockReturnValueOnce(installed);
    isByovRuntimeCurrent.mockResolvedValueOnce(current);
    isByovRuntimeReady.mockResolvedValueOnce(ready);
    const child = mockChildProcess();
    const response = stream();
    await response.started;

    child.emit('close', 0);
    await response.closed;

    expect(response.send).toHaveBeenLastCalledWith({ type, message: expect.stringContaining(message) });
    expect(isByovRuntimeInstalled).toHaveBeenCalledTimes(2);
    expect(isByovRuntimeCurrent).toHaveBeenCalledTimes(installed ? 1 : 0);
    expect(isByovRuntimeReady).toHaveBeenCalledTimes(current ? 1 : 0);
  });

  it('stops post-exit probes and events when the stream disconnects during verification', async () => {
    const revision = Promise.withResolvers();
    isByovRuntimeInstalled.mockReturnValueOnce(false);
    isByovRuntimeCurrent.mockReturnValueOnce(revision.promise);
    const child = mockChildProcess();
    const response = stream();
    await response.started;
    response.send.mockClear();

    child.emit('close', 0);
    expect(isByovRuntimeCurrent).toHaveBeenCalledOnce();
    response.disconnect();
    revision.resolve(true);
    await revision.promise;

    expect(stopSetupScript).not.toHaveBeenCalled();
    expect(isByovRuntimeReady).not.toHaveBeenCalled();
    expect(response.send).not.toHaveBeenCalled();
    expect(response.safeEnd).not.toHaveBeenCalled();
  });
});

describe('locked runtime upgrades', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(['minimax_h3', 'fastvideo'])('offers Upgrade for %s lock drift and skips setup after sync', async (runtime) => {
    const actual = await vi.importActual('./runtimes.js');
    const info = BYOV_RUNTIME_INFO[runtime];
    existsSync.mockReturnValue(true);
    isByovRuntimeInstalled.mockImplementation(actual.isByovRuntimeInstalled);
    isByovRuntimeCurrent.mockImplementation(actual.isByovRuntimeCurrent);
    isByovRuntimeReady.mockImplementation(actual.isByovRuntimeReady);
    actual.invalidateByovReadyCache(runtime);

    let locked = false;
    const importProbe = vi.fn(() => 0);
    spawn.mockImplementation((file, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      queueMicrotask(() => {
        if (file === 'git') {
          const revision = info.sourcePath ? `# branch.oid ${info.expectedRevision}` : info.expectedRevision;
          child.stdout.emit('data', `${revision}\n`);
          child.emit('close', 0);
          return;
        }
        const isLockProbe = args === info.currencyProbeArgs;
        const lockExit = locked ? 0 : 78;
        child.emit('close', isLockProbe ? lockExit : importProbe());
      });
      return child;
    });

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(getVideoRuntimeStatus(runtime)).resolves.toMatchObject({
        binaryPresent: true, current: false, installed: false, upgradeAvailable: true,
      });

      const child = mockChildProcess();
      const upgrade = stream({ runtime });
      await upgrade.started;
      expect(importProbe).not.toHaveBeenCalled();
      expect(spawnSetupScript).toHaveBeenCalledExactlyOnceWith({
        [info.installEnvVar]: '1',
        [info.pinEnvVar]: info.expectedRevision,
      });

      locked = true;
      child.emit('close', 0);
      await upgrade.closed;
      expect(importProbe).toHaveBeenCalledOnce();
      expect(upgrade.send).toHaveBeenLastCalledWith({ type: 'complete', message: expect.stringContaining('ready') });
      await expect(getVideoRuntimeStatus(runtime)).resolves.toMatchObject({
        binaryPresent: true, current: true, installed: true, upgradeAvailable: false,
      });

      const current = stream({ runtime });
      await current.started;
      expect(current.send).toHaveBeenLastCalledWith({ type: 'complete', message: expect.stringContaining('Already installed') });
      expect(spawnSetupScript).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
});
