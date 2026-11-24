import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  data: '',
  pm2: null,
  download: vi.fn(),
  command: vi.fn(),
  spawn: vi.fn(),
  pm2Command: vi.fn(),
  pm2Status: vi.fn(),
  portUsed: vi.fn(),
  probe: vi.fn(),
  settings: {},
  saveSettings: vi.fn(),
}));
vi.mock('../lib/childProcess.js', async (original) => ({
  ...await original(),
  spawn: mocks.spawn,
}));
vi.mock('../lib/paths.js', () => ({ PATHS: { get data() { return mocks.data; } } }));
vi.mock('../lib/platform.js', () => ({ isPortInUse: mocks.portUsed }));
vi.mock('../lib/downloadPreflight.js', () => ({ streamResumableDownload: mocks.download }));
vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: mocks.command }));
vi.mock('./pm2.js', () => ({
  clearJlistCache: vi.fn(),
  execPm2: mocks.pm2Command,
  getAppStatusStrict: mocks.pm2Status,
}));
vi.mock('./settings.js', () => ({
  readSettingsStrict: async () => ({ settings: mocks.settings, corrupt: false }),
  updateSettingsWith: mocks.saveSettings,
}));
vi.mock('./splashManagedRuntime.js', async (original) => ({
  ...await original(),
  supportsManagedSplash: () => true,
  probeSplashEndpoint: mocks.probe,
}));

import { getSplashManagedState, installSplashRuntime, saveSplashContextWindow, SPLASH_APP, startSplashServer, stopSplashServer } from './splashServerManager.js';
import { SPLASH_VERSION, splashRoot } from './splashManagedRuntime.js';

const mockedApp = (rest = {}) => ({ name: SPLASH_APP, status: 'not_found', ...rest });

async function stageFakeRelease(directory) {
  const bin = join(directory, 'python', 'bin');
  const install = join(directory, 'install');
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(install, { recursive: true })]);
  await Promise.all([
    writeFile(join(bin, 'python3'), '#!/bin/sh\n', { mode: 0o700 }),
    writeFile(join(install, 'launcher.py'), ''),
  ]);
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.data = await mkdtemp(join(tmpdir(), 'splash-manager-'));
  mocks.pm2 = mockedApp();
  mocks.settings = { localLlm: { backend: 'ollama' }, theme: 'dark' };
  mocks.saveSettings.mockImplementation(async (mutate) => { mocks.settings = mutate(mocks.settings); });
  mocks.portUsed.mockResolvedValue(false);
  mocks.probe.mockResolvedValue({ state: 'external', model: 'inkling2-mini' });
  mocks.pm2Status.mockImplementation(async () => mocks.pm2);
  mocks.pm2Command.mockImplementation(async (args) => {
    if (args[0] === 'start') mocks.pm2 = mockedApp({ status: 'online', pm_id: 42, args: args.slice(args.indexOf('--') + 1) });
    if (args[0] === 'delete') mocks.pm2 = mockedApp();
  });
  mocks.download.mockResolvedValue({});
  mocks.command.mockImplementation(async (cmd, args, onLine, { cwd }) => {
    if (cmd === '/usr/bin/tar') await stageFakeRelease(join(cwd, `splash-${SPLASH_VERSION}-arm64-macos26`));
    if (args.includes('prepare')) {
      onLine('A raw line with an unexpected URL should never be displayed.');
      onLine(JSON.stringify({ event: 'download', repo: 'incoai/Inkling-2-Mini-DFlash2', done: 1, total: 2 }));
    }
    return { success: true };
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(mocks.data, { recursive: true, force: true });
});

it('installs the verified bundle and checkpoint, starts only from cache, and stops only the owned PM2 instance', async () => {
  await expect(getSplashManagedState()).resolves.toMatchObject({ installed: false, managed: false, requestedContextWindow: 65536 });
  await expect(startSplashServer()).rejects.toMatchObject({ code: 'SPLASH_NOT_INSTALLED' });
  expect(mocks.pm2Command).not.toHaveBeenCalled();

  const progress = vi.fn();
  await expect(installSplashRuntime({ onProgress: progress })).resolves.toMatchObject({ success: true });
  expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({
    url: expect.stringMatching(/^https:\/\/github\.com\/incoai\/splash\/releases\/download\/1\.7\.2\//),
    expectedSha256: '40a1e6d585ed8f51b2f2e17c331e7d9533a1b666e1e6e418ddd623bdd3a29e2b',
  }));
  expect(progress.mock.calls.flat()).toContain('Downloading Inkling 2 Mini drafter: 50%');
  expect(progress.mock.calls.flat().join('\n')).not.toContain('unexpected URL');
  await expect(getSplashManagedState()).resolves.toMatchObject({ installed: true, managed: false, version: SPLASH_VERSION });
  expect(mocks.pm2Command).not.toHaveBeenCalled();

  await startSplashServer();
  expect(mocks.pm2Command.mock.calls[0][0]).toEqual(expect.arrayContaining([
    'start', '/usr/bin/env', SPLASH_APP, '--offline', '--host', '127.0.0.1', '--port', '8001', '--no-autorestart', '--max-context', '65536',
  ]));
  expect(mocks.pm2.args.slice(0, 2)).toEqual(['-i', `HOME=${join(splashRoot(), 'home')}`]);
  await expect(getSplashManagedState()).resolves.toMatchObject({ installed: true, managed: true });
  await expect(installSplashRuntime()).rejects.toThrow('Stop the PortOS-managed Splash');
  expect(mocks.download).toHaveBeenCalledTimes(1);
  await stopSplashServer();
  expect(mocks.pm2Command).toHaveBeenLastCalledWith(['delete', '42']);
  await expect(getSplashManagedState()).resolves.toMatchObject({ installed: true, managed: false, version: SPLASH_VERSION });
});

it('passes proxy and CA settings to prepare only, without forwarding provider credentials', async () => {
  vi.stubEnv('HTTPS_PROXY', 'http://example.com:1234');
  vi.stubEnv('SSL_CERT_FILE', '/tmp/example-ca.pem');
  vi.stubEnv('OPENAI_API_KEY', 'fake-provider-secret');
  await installSplashRuntime();

  for (const [command, args, , options] of mocks.command.mock.calls) {
    options.spawnImpl(command, args, { env: { OPENAI_API_KEY: 'fake-provider-secret' } });
    const [, , { env }] = mocks.spawn.mock.lastCall;
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env.PWD).toBe(options.cwd);
    expect(args.join(' ')).not.toContain('example.com');
    if (args.includes('prepare')) {
      expect(env).toMatchObject({ HTTPS_PROXY: 'http://example.com:1234', SSL_CERT_FILE: '/tmp/example-ca.pem' });
    } else {
      expect(env).not.toHaveProperty('HTTPS_PROXY');
      expect(env).not.toHaveProperty('SSL_CERT_FILE');
    }
  }

  await startSplashServer();
  expect(mocks.pm2.args.join(' ')).not.toMatch(/HTTPS_PROXY|SSL_CERT_FILE|OPENAI_API_KEY/);
});

it('refuses to replace a listening process or delete a reserved-name PM2 process it did not launch', async () => {
  await installSplashRuntime();
  mocks.portUsed.mockResolvedValue(true);
  await expect(startSplashServer()).rejects.toMatchObject({ code: 'SPLASH_PORT_IN_USE' });
  mocks.pm2 = mockedApp({ status: 'online', pm_id: 7, args: ['/anywhere/splash', 'serve', '--port', '8001'] });
  await expect(stopSplashServer()).rejects.toThrow('will not stop an external process');
  await expect(startSplashServer()).rejects.toThrow('not owned by this PortOS installation');
  expect(mocks.pm2Command).not.toHaveBeenCalled();
});

it('preserves the old installed release when verification/preparation fails and publishes the update only after success', async () => {
  const old = '1.7.1';
  const marker = join(splashRoot(), 'active-version');
  await stageFakeRelease(join(splashRoot(), `runtime-${old}`));
  await writeFile(marker, old);
  const command = mocks.command.getMockImplementation();
  mocks.command.mockImplementation(async (...args) => args[1].includes('prepare') ? { success: false } : command(...args));
  await expect(installSplashRuntime()).rejects.toMatchObject({ code: 'SPLASH_INSTALL_FAILED' });
  await expect(readFile(marker, 'utf8')).resolves.toBe(old);
  await expect(getSplashManagedState()).resolves.toMatchObject({ version: old, updateAvailable: true });
  mocks.command.mockImplementation(command);
  await installSplashRuntime();
  await expect(getSplashManagedState()).resolves.toMatchObject({ version: SPLASH_VERSION, updateAvailable: false });
  expect(mocks.pm2Command).not.toHaveBeenCalled();
});

it('keeps install/update mutually exclusive with another install or start, even before the vendor download returns', async () => {
  let finishDownload;
  mocks.download.mockImplementation(() => new Promise((resolve) => { finishDownload = resolve; }));
  const installing = installSplashRuntime();
  await expect(installSplashRuntime()).rejects.toThrow('Another Splash operation');
  await expect(startSplashServer()).rejects.toThrow('Another Splash operation');
  await expect(getSplashManagedState()).resolves.toMatchObject({ installing: true });
  await vi.waitFor(() => expect(finishDownload).toBeTypeOf('function'));
  finishDownload({});
  await installing;
});

it('requires verified model readiness before declaring Start complete', async () => {
  await installSplashRuntime();
  let resolveInitialProbe;
  mocks.probe.mockImplementationOnce(() => new Promise((resolve) => { resolveInitialProbe = resolve; }));
  const start = startSplashServer();
  const completion = vi.fn();
  const checkedStart = start.then(completion);
  await vi.waitFor(() => expect(resolveInitialProbe).toBeTypeOf('function'));
  expect(completion).not.toHaveBeenCalled();
  resolveInitialProbe({ state: 'external', model: 'some-other-model' });
  await checkedStart;
  expect(mocks.probe).toHaveBeenCalledTimes(2);
  expect(completion).toHaveBeenCalledWith({ success: true, message: 'Splash is ready with Inkling 2 Mini.' });
});

it('saves a per-machine next-start context and does not alter a running or external Splash instance', async () => {
  await expect(saveSplashContextWindow(262144)).resolves.toEqual({ requestedContextWindow: 262144 });
  expect(mocks.settings).toEqual({ localLlm: { backend: 'ollama', splash: { contextWindow: 262144 } }, theme: 'dark' });
  expect(mocks.pm2Command).not.toHaveBeenCalled();
  await installSplashRuntime();
  await startSplashServer();
  expect(mocks.pm2.args).toEqual(expect.arrayContaining(['--max-context', '262144']));
  await expect(saveSplashContextWindow(1000000)).rejects.toThrow('Stop Splash');
  await stopSplashServer();
  mocks.portUsed.mockResolvedValue(true);
  await expect(saveSplashContextWindow(1000000)).rejects.toThrow('external server');
  await expect(saveSplashContextWindow(1010000)).rejects.toMatchObject({ code: 'SPLASH_INVALID_CONTEXT' });
  expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
});
