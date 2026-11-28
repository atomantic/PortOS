import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const bundle = 'a'.repeat(24);
const { readMarker, installAvatar, openAvatarWorker, isHostShuttingDown } = vi.hoisted(() => ({
  readMarker: vi.fn(),
  installAvatar: vi.fn(),
  openAvatarWorker: vi.fn(),
  isHostShuttingDown: vi.fn(),
}));

vi.mock('node:os', () => ({ release: () => '25.0.0' }));
vi.mock('node:fs/promises', () => ({ readFile: readMarker }));
vi.mock('../../lib/hostShutdown.js', () => ({ isHostShuttingDown }));
vi.mock('../socketIo.js', () => ({ emitToOperators: vi.fn() }));
vi.mock('./avatarInstall.js', () => ({
  avatarBundle: () => bundle,
  avatarFilesPresent: async () => true,
  avatarPython: () => '/fixture/python',
  avatarMarker: '/fixture/marker',
  installAvatar,
}));
vi.mock('./avatarWorker.js', () => ({
  DEFAULT_PORTRAIT_KEY: 'default',
  avatarError: message => new Error(message),
  openAvatarWorker,
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('process', Object.create(process, {
    platform: { value: 'darwin' },
    arch: { value: 'arm64' },
  }));
  readMarker.mockResolvedValue(bundle);
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
