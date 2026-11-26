import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal(),
  cpus: () => [{ model: 'Apple M5 Max' }],
  release: () => '25.6.0',
  totalmem: () => 128 * 2 ** 30,
}));

vi.mock('../lib/platform.js', () => ({ isPortInUse: vi.fn() }));
vi.mock('./pm2.js', () => ({ clearJlistCache: vi.fn(), execPm2: vi.fn(), getAppStatusStrict: vi.fn() }));
vi.mock('./mkserveRuntimeInstall.js', async (importOriginal) => ({
  ...await importOriginal(),
  readMkserveInstall: vi.fn(),
  installPinnedMkserve: vi.fn(),
  removeMkserveRelease: vi.fn(),
}));

import { isPortInUse } from '../lib/platform.js';
import { execPm2, getAppStatusStrict } from './pm2.js';
import { installPinnedMkserve, mkserveInstallPaths, readMkserveInstall, removeMkserveRelease, MKSERVE_BUNDLE, MKSERVE_VERSION } from './mkserveRuntimeInstall.js';
import { MKSERVE_APP, MKSERVE_MODEL, getMkserveRuntimeStatus, installMkserve, startMkserveServer, stopMkserveServer, uninstallMkserve } from './mkserveRuntimeManager.js';

const modelRevision = 'a'.repeat(40);
const installed = {
  ...mkserveInstallPaths(MKSERVE_BUNDLE, modelRevision),
  bundle: MKSERVE_BUNDLE,
  version: MKSERVE_VERSION,
  revision: modelRevision,
};
const missingApp = { status: 'not_found', args: null };
const serve = () => {
  fetch.mockImplementation(async (url) => url.endsWith('/health')
    ? Response.json({ status: 'ok', engine: 'offline-c', max_context: 32768 })
    : Response.json({ data: [{ id: MKSERVE_MODEL, engine: 'offline-c', owned_by: 'mkserve' }] }));
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('not listening')));
  vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64' });
  getAppStatusStrict.mockResolvedValue(missingApp);
  isPortInUse.mockResolvedValue(false);
  readMkserveInstall.mockResolvedValue(null);
});

afterEach(() => vi.unstubAllGlobals());

describe('managed mkserve lifecycle', () => {
  it('only uninstalls the PortOS release when the process manager and port are clear', async () => {
    readMkserveInstall.mockResolvedValue(installed);
    isPortInUse.mockResolvedValueOnce(true);
    await expect(uninstallMkserve()).rejects.toThrow(/free its port/);
    getAppStatusStrict.mockResolvedValueOnce({ status: 'stopped', args: ['external app'] });
    await expect(uninstallMkserve()).rejects.toMatchObject({ code: 'MKSERVE_NAME_IN_USE' });
    expect(removeMkserveRelease).not.toHaveBeenCalled();
    await expect(getMkserveRuntimeStatus()).resolves.toMatchObject({ state: 'stopped', canUninstall: true });
    await expect(uninstallMkserve()).resolves.toMatchObject({ success: true });
    expect(removeMkserveRelease).toHaveBeenCalledExactlyOnceWith(installed);
    expect(execPm2).not.toHaveBeenCalled();
  });

  it('installs without launching, refuses concurrent Start, then moves from missing to stopped', async () => {
    let finishInstall;
    installPinnedMkserve.mockImplementation(() => new Promise((resolve) => { finishInstall = resolve; }));
    const progress = vi.fn();
    await expect(getMkserveRuntimeStatus()).resolves.toMatchObject({ supported: true, installed: false, state: 'missing' });
    const pending = installMkserve({ onProgress: progress });
    await vi.waitFor(() => expect(installPinnedMkserve).toHaveBeenCalledOnce());
    expect(() => startMkserveServer()).toThrow(/Another mkserve operation/);
    await expect(getMkserveRuntimeStatus()).resolves.toMatchObject({ state: 'installing' });
    installPinnedMkserve.mock.calls[0][0]('Verifying checkpoint…');
    expect(progress).toHaveBeenCalledWith({ event: 'progress', message: 'Verifying checkpoint…' });
    readMkserveInstall.mockResolvedValue(installed);
    finishInstall();
    await expect(pending).resolves.toMatchObject({ success: true, message: 'mkserve installed' });
    await expect(getMkserveRuntimeStatus()).resolves.toMatchObject({ state: 'stopped', updateAvailable: false });
    expect(execPm2).not.toHaveBeenCalled();
  });

  it('launches local files with a clean environment and recognizes the existing process before stopping it', async () => {
    readMkserveInstall.mockResolvedValue(installed);
    execPm2.mockImplementation(async ([verb, , ...args]) => {
      if (verb === 'start') {
        getAppStatusStrict.mockResolvedValue({ status: 'online', pm_id: 7, args: args.slice(args.indexOf('--') + 1) });
        serve();
      } else if (verb === 'delete') {
        getAppStatusStrict.mockResolvedValue(missingApp);
      } else if (verb === 'logs') {
        return { stdout: 'fixture output', stderr: 'fixture diagnostics' };
      }
    });

    await expect(startMkserveServer()).resolves.toMatchObject({ success: true });
    expect(execPm2).toHaveBeenCalledWith(expect.arrayContaining([
      'start', '/usr/bin/env', '--name', MKSERVE_APP, '--cwd', installed.source,
      '-i', 'HF_HUB_OFFLINE=1', installed.python, '127.0.0.1', '8002', installed.weights,
    ]));
    await expect(getMkserveRuntimeStatus({ includeLogs: true })).resolves.toMatchObject({
      state: 'running', managed: true, recentLogs: ['fixture output', 'fixture diagnostics'], model: MKSERVE_MODEL, engine: 'offline-c', maxContext: 32768,
    });
    expect(installPinnedMkserve).not.toHaveBeenCalled();
    expect(execPm2).toHaveBeenCalledWith(['logs', '7', '--nostream', '--lines', '100']);
    await expect(stopMkserveServer()).resolves.toMatchObject({ success: true });
    expect(execPm2).toHaveBeenCalledWith(['delete', '7'], { timeoutMs: 60_000 });
  });

  it('does not replace or stop another listener, even when it really is mkserve', async () => {
    readMkserveInstall.mockResolvedValue(installed);
    isPortInUse.mockResolvedValue(true);
    serve();
    await expect(getMkserveRuntimeStatus({ includeLogs: true })).resolves.toMatchObject({ state: 'external', managed: false, model: MKSERVE_MODEL });
    await expect(startMkserveServer()).rejects.toMatchObject({ code: 'MKSERVE_PORT_IN_USE' });
    await expect(stopMkserveServer()).rejects.toMatchObject({ code: 'MKSERVE_EXTERNAL_PROCESS' });
    getAppStatusStrict.mockResolvedValue({ status: 'online', args: ['unrelated local process'] });
    await expect(stopMkserveServer()).rejects.toMatchObject({ code: 'MKSERVE_NAME_IN_USE' });
    expect(execPm2).not.toHaveBeenCalled();
  });

  it('keeps the old runtime available after a failed update and lets you retry', async () => {
    const previous = { ...installed, bundle: 'b'.repeat(40) };
    readMkserveInstall.mockResolvedValue(previous);
    installPinnedMkserve.mockRejectedValueOnce(new Error('checkpoint hash mismatch'));
    await expect(installMkserve()).rejects.toThrow('checkpoint hash mismatch');
    await expect(getMkserveRuntimeStatus()).resolves.toMatchObject({
      state: 'stopped', installed: true, version: previous.version, updateAvailable: true,
    });
    await expect(installMkserve()).resolves.toMatchObject({ success: true, message: 'mkserve updated' });
  });

  it('does not mutate PM2 when its application ownership could not be checked', async () => {
    readMkserveInstall.mockResolvedValue(installed);
    getAppStatusStrict.mockResolvedValue(null);
    await expect(startMkserveServer()).rejects.toMatchObject({ code: 'MKSERVE_PM2_UNAVAILABLE' });
    await expect(stopMkserveServer()).rejects.toMatchObject({ code: 'MKSERVE_PM2_UNAVAILABLE' });
    expect(execPm2).not.toHaveBeenCalled();
  });

  it('refuses an unsupported host before fetching assets or checking PM2', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux', arch: 'x64' });
    await expect(getMkserveRuntimeStatus()).resolves.toMatchObject({ supported: false, state: 'unsupported' });
    expect(() => installMkserve()).toThrow(/Apple M5 Max/);
    expect(() => startMkserveServer()).toThrow(/Apple M5 Max/);
    expect(() => stopMkserveServer()).toThrow(/Apple M5 Max/);
    expect(fetch).not.toHaveBeenCalled();
    expect(getAppStatusStrict).not.toHaveBeenCalled();
    expect(installPinnedMkserve).not.toHaveBeenCalled();
  });
});
