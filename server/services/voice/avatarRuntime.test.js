import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const bundle = 'a'.repeat(24);
const staleBundle = 'b'.repeat(24);
const {
  readMarker, rmMock, avatarFilesPresent, installAvatar, openAvatarWorker, isHostShuttingDown,
  getActiveAvatarFilename, loadAvatarPortrait, emitToOperators, getVoiceConfig, updateVoiceConfig,
} = vi.hoisted(() => ({
  readMarker: vi.fn(),
  rmMock: vi.fn(),
  avatarFilesPresent: vi.fn(),
  installAvatar: vi.fn(),
  openAvatarWorker: vi.fn(),
  isHostShuttingDown: vi.fn(),
  getActiveAvatarFilename: vi.fn(),
  loadAvatarPortrait: vi.fn(),
  emitToOperators: vi.fn(),
  getVoiceConfig: vi.fn(),
  updateVoiceConfig: vi.fn(),
}));

vi.mock('node:os', () => ({ release: () => '25.0.0' }));
vi.mock('node:fs/promises', () => ({ readFile: readMarker, rm: rmMock }));
vi.mock('../../lib/hostShutdown.js', () => ({ isHostShuttingDown }));
vi.mock('../socketIo.js', () => ({ emitToOperators }));
vi.mock('./config.js', () => ({ getVoiceConfig, updateVoiceConfig }));
vi.mock('./avatarInstall.js', () => ({
  avatarBundle: () => bundle,
  avatarFilesPresent,
  avatarPython: () => '/fixture/python',
  avatarMarker: '/fixture/marker',
  avatarRoot: '/fixture/avatar-root',
  installAvatar,
}));
vi.mock('./avatarWorker.js', () => ({
  DEFAULT_PORTRAIT_KEY: 'default',
  avatarError: (message, status = 409) => Object.assign(new Error(message), { status, code: 'VOICE_AVATAR' }),
  openAvatarWorker,
}));
vi.mock('./avatarLibrary.js', () => ({
  getActiveAvatarFilename,
  loadAvatarPortrait,
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('process', Object.create(process, {
    platform: { value: 'darwin' },
    arch: { value: 'arm64' },
  }));
  readMarker.mockResolvedValue(bundle);
  avatarFilesPresent.mockResolvedValue(true);
  rmMock.mockResolvedValue(undefined);
  getActiveAvatarFilename.mockResolvedValue(null);
  getVoiceConfig.mockResolvedValue({ avatar: { autoStart: true } });
  updateVoiceConfig.mockResolvedValue({});
});

afterEach(() => vi.unstubAllGlobals());

it('stops the worker while it is warming', async () => {
  const { manageAvatar, stopAvatarForShutdown } = await import('./avatarRuntime.js');
  const { promise: warmed, reject } = Promise.withResolvers();
  const stop = vi.fn();
  openAvatarWorker.mockImplementation((_python, onClose) => {
    stop.mockImplementation(() => {
      reject(new Error('Worker stopped'));
      onClose(true);
    });
    return { stop, warmed };
  });

  await expect(manageAvatar('start')).resolves.toMatchObject({ phase: 'starting' });
  stopAvatarForShutdown();
  stopAvatarForShutdown();

  expect(stop).toHaveBeenCalledTimes(1);
  await expect(manageAvatar('stop')).resolves.toMatchObject({ phase: 'stopped' });
});

it('aborts an active installation', async () => {
  const { getAvatarStatus, manageAvatar, stopAvatarForShutdown } = await import('./avatarRuntime.js');
  installAvatar.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));

  await expect(manageAvatar('install')).resolves.toMatchObject({ phase: 'installing' });
  stopAvatarForShutdown();

  expect(installAvatar.mock.calls[0][0].signal.aborted).toBe(true);
  await expect(getAvatarStatus()).resolves.toMatchObject({ phase: 'stopped' });
});

it('refuses to launch a worker when shutdown starts during installation lookup', async () => {
  const { manageAvatar, stopAvatarForShutdown } = await import('./avatarRuntime.js');
  const marker = Promise.withResolvers();
  readMarker.mockReturnValueOnce(marker.promise);

  const start = manageAvatar('start');
  isHostShuttingDown.mockReturnValue(true);
  stopAvatarForShutdown();
  marker.resolve(bundle);

  await expect(start).rejects.toThrow('PortOS is shutting down');
  expect(openAvatarWorker).not.toHaveBeenCalled();
});

it('refuses unsupported platforms, missing installs, stale bundles, and idle cancel', async () => {
  vi.stubGlobal('process', Object.create(process, {
    platform: { value: 'linux' },
    arch: { value: 'x64' },
  }));
  const unsupported = await import('./avatarRuntime.js');
  await expect(unsupported.getAvatarStatus()).resolves.toMatchObject({ supported: false, installed: false, updateAvailable: false });
  await expect(unsupported.manageAvatar('start')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Apple Silicon') });

  vi.resetModules();
  vi.stubGlobal('process', Object.create(process, {
    platform: { value: 'darwin' },
    arch: { value: 'arm64' },
  }));
  const runtime = await import('./avatarRuntime.js');

  readMarker.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await expect(runtime.manageAvatar('start')).rejects.toThrow('Install AvatarForcing before starting it.');

  readMarker.mockResolvedValue(staleBundle);
  await expect(runtime.getAvatarStatus()).resolves.toMatchObject({ supported: true, installed: true, updateAvailable: true });
  await expect(runtime.manageAvatar('start')).rejects.toThrow('Update AvatarForcing before starting it.');

  await expect(runtime.manageAvatar('cancel')).rejects.toThrow('No avatar installation is in progress.');
});

it('guards destructive uninstall while running and removes avatarRoot once stopped', async () => {
  const { manageAvatar } = await import('./avatarRuntime.js');
  const stop = vi.fn();
  openAvatarWorker.mockImplementation((_python, onClose) => {
    stop.mockImplementation(() => onClose(true));
    return { stop, warmed: Promise.resolve() };
  });

  await manageAvatar('start');
  await expect(manageAvatar('uninstall')).rejects.toThrow('Stop AvatarForcing before making this change.');
  expect(rmMock).not.toHaveBeenCalled();

  await manageAvatar('stop');
  const status = await manageAvatar('uninstall');
  expect(rmMock).toHaveBeenCalledWith('/fixture/avatar-root', { recursive: true, force: true });
  expect(status).toMatchObject({ phase: 'stopped', detail: expect.stringContaining('removed') });
});

it('sanitizes install failure messages and blocks concurrent actions during install', async () => {
  const { getAvatarStatus, manageAvatar } = await import('./avatarRuntime.js');
  const pending = Promise.withResolvers();
  installAvatar.mockReturnValueOnce(pending.promise);

  await expect(manageAvatar('install')).resolves.toMatchObject({ phase: 'installing' });
  await expect(manageAvatar('start')).rejects.toThrow('Wait for the avatar installation to finish.');
  await expect(manageAvatar('uninstall')).rejects.toThrow('Wait for the avatar installation to finish.');

  pending.reject(Object.assign(new Error('ENOSPC: /example/host/path'), { code: 'ENOSPC' }));
  await vi.waitFor(async () => expect(await getAvatarStatus()).toMatchObject({
    phase: 'failed',
    detail: 'Installation failed. Check disk space and network access.',
  }));

  installAvatar.mockRejectedValueOnce(Object.assign(new Error('uv fail'), { code: 'MKSERVE_INSTALL_FAILED' }));
  await manageAvatar('update');
  await vi.waitFor(async () => expect(await getAvatarStatus()).toMatchObject({
    phase: 'failed',
    detail: 'Could not prepare the pinned Python installer. Check your connection and retry.',
  }));

  installAvatar.mockRejectedValueOnce(new Error('AvatarForcing weights cannot be symlinked.'));
  await manageAvatar('install');
  await vi.waitFor(async () => expect(await getAvatarStatus()).toMatchObject({
    phase: 'failed',
    detail: 'AvatarForcing weights cannot be symlinked.',
  }));
});

it('wires active channel portraits into render calls and refuses renders when stopped or crashed', async () => {
  const { getAvatarStatus, manageAvatar, renderAvatar, renderAvatarIdle } = await import('./avatarRuntime.js');
  await expect(renderAvatar(Buffer.from('wav'), { onFrame: vi.fn(), signal: new AbortController().signal }))
    .rejects.toMatchObject({ status: 503 });

  let notifyClose;
  const render = vi.fn(async () => {});
  const renderIdle = vi.fn(async () => {});
  openAvatarWorker.mockImplementation((_python, onClose) => {
    notifyClose = onClose;
    return { stop: vi.fn(), warmed: Promise.resolve(), render, renderIdle };
  });

  await manageAvatar('start');
  await vi.waitFor(async () => expect(await getAvatarStatus()).toMatchObject({ phase: 'running' }));

  const portraitBytes = Buffer.from('jpeg-bytes');
  getActiveAvatarFilename.mockResolvedValueOnce('channel-face.png');
  loadAvatarPortrait.mockResolvedValueOnce(portraitBytes);
  await renderAvatar(Buffer.from('wav'), { onFrame: vi.fn(), signal: new AbortController().signal });
  const speakPortrait = render.mock.calls[0][1].portrait;
  expect(speakPortrait.key).toBe('channel-face.png');
  expect(await speakPortrait.load()).toBe(portraitBytes);
  expect(loadAvatarPortrait).toHaveBeenCalledWith('channel-face.png');

  // Unreadable library state falls back to the bundled default portrait.
  getActiveAvatarFilename.mockRejectedValueOnce(new Error('settings unreadable'));
  await renderAvatarIdle({ stage: 'idle', onFrame: vi.fn(), signal: new AbortController().signal });
  expect(renderIdle.mock.calls[0][0].portrait).toEqual({ key: 'default' });

  // Unexpected worker crash transitions to failed and blocks further renders.
  notifyClose(false);
  expect(await getAvatarStatus()).toMatchObject({ phase: 'failed', detail: expect.stringContaining('worker stopped') });
  await expect(renderAvatarIdle({ stage: 'idle', onFrame: vi.fn(), signal: new AbortController().signal }))
    .rejects.toMatchObject({ status: 503 });
});

it('starts an installed, stopped worker when a call view opens, unless the operator turned auto-start off', async () => {
  const { manageAvatar } = await import('./avatarRuntime.js');
  openAvatarWorker.mockReturnValue({ warmed: new Promise(() => {}), stop: vi.fn() });

  getVoiceConfig.mockResolvedValue({ avatar: { autoStart: false } });
  await expect(manageAvatar('autostart')).resolves.toMatchObject({ phase: 'stopped', autoStart: false });
  expect(openAvatarWorker).not.toHaveBeenCalled();

  getVoiceConfig.mockResolvedValue({ avatar: { autoStart: true } });
  await expect(manageAvatar('autostart')).resolves.toMatchObject({ phase: 'starting', autoStart: true });
  expect(openAvatarWorker).toHaveBeenCalledTimes(1);

  // Already starting: a second view opening does not launch another worker.
  await manageAvatar('autostart');
  expect(openAvatarWorker).toHaveBeenCalledTimes(1);
});

it('does not auto-start a stale install, and remembers Start and Stop as the auto-start choice', async () => {
  const { manageAvatar } = await import('./avatarRuntime.js');
  readMarker.mockResolvedValue(staleBundle);
  await manageAvatar('autostart');
  expect(openAvatarWorker).not.toHaveBeenCalled();

  readMarker.mockResolvedValue(bundle);
  openAvatarWorker.mockReturnValue({ warmed: new Promise(() => {}), stop: vi.fn() });
  await manageAvatar('start');
  expect(updateVoiceConfig).toHaveBeenLastCalledWith({ avatar: { autoStart: true } });
  await manageAvatar('stop');
  expect(updateVoiceConfig).toHaveBeenLastCalledWith({ avatar: { autoStart: false } });
});
