import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  existing: new Set(),
  bunAvailable: true,
  apps: [],
  registryError: null,
  cloneRepo: vi.fn(),
  spawn: vi.fn(),
  atomicWrite: vi.fn(),
  ensureDir: vi.fn(),
  createApp: vi.fn(),
  updateApp: vi.fn(),
  notifyAppsChanged: vi.fn(),
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { repos: '/example/data/repos', data: '/example/data' },
  pathExists: vi.fn(async (path) => mock.existing.has(path)),
  ensureDir: mock.ensureDir,
  atomicWrite: mock.atomicWrite,
}));

vi.mock('../lib/commandExists.js', () => ({
  commandExists: vi.fn(async () => mock.bunAvailable),
}));

vi.mock('../lib/bufferedSpawn.js', () => ({
  bufferedSpawnOrThrow: mock.spawn,
}));

vi.mock('./githubCloner.js', () => ({
  cloneRepo: mock.cloneRepo,
}));

vi.mock('./apps.js', () => ({
  getAllApps: vi.fn(async () => {
    if (mock.registryError) throw mock.registryError;
    return structuredClone(mock.apps);
  }),
  createApp: mock.createApp,
  updateApp: mock.updateApp,
  notifyAppsChanged: mock.notifyAppsChanged,
}));

vi.mock('./pm2.js', () => ({
  getAppStatusStrict: vi.fn(async () => ({ status: 'not_found' })),
}));

import {
  __resetEidoverseInstallForTests,
  EIDOVERSE_PATHS,
  EIDOVERSE_VIDEO_REPO,
  EIDOVERSE_WORLDS_REPO,
  getEidoverseStatus,
  installEidoverse,
} from './eidoverse.js';

describe('Eidoverse managed-app installer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.existing.clear();
    mock.bunAvailable = true;
    mock.apps = [];
    mock.registryError = null;
    __resetEidoverseInstallForTests();

    mock.cloneRepo.mockImplementation(async (url) => {
      mock.existing.add(url === EIDOVERSE_WORLDS_REPO
        ? `${EIDOVERSE_PATHS.worlds}/.git`
        : `${EIDOVERSE_PATHS.video}/.git`);
    });
    mock.spawn.mockImplementation(async (_cmd, _args, { cwd }) => {
      mock.existing.add(`${cwd}/node_modules`);
      return { stdout: '', stderr: '' };
    });
    mock.ensureDir.mockImplementation(async (path) => {
      mock.existing.add(path);
    });
    mock.atomicWrite.mockImplementation(async (path) => {
      mock.existing.add(path);
    });
    mock.createApp.mockImplementation(async (fields) => {
      const app = { id: 'app-eidoverse', ...fields };
      mock.apps.push(app);
      return app;
    });
  });

  it('clones separate licensed repos, installs Bun dependencies, and registers Worlds', async () => {
    const status = await installEidoverse();

    expect(mock.cloneRepo).toHaveBeenCalledWith(EIDOVERSE_WORLDS_REPO);
    expect(mock.cloneRepo).toHaveBeenCalledWith(EIDOVERSE_VIDEO_REPO);
    expect(mock.spawn).toHaveBeenCalledWith('bun', ['install', '--frozen-lockfile'], expect.objectContaining({ cwd: EIDOVERSE_PATHS.worlds }));
    expect(mock.spawn).toHaveBeenCalledWith('bun', ['install', '--frozen-lockfile'], expect.objectContaining({ cwd: `${EIDOVERSE_PATHS.worlds}/client` }));
    expect(mock.atomicWrite).toHaveBeenCalledWith(
      EIDOVERSE_PATHS.envFile,
      expect.stringContaining(`EIDOVERSE_DIR="${EIDOVERSE_PATHS.video}"`),
    );
    expect(mock.createApp).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Eidoverse Worlds',
      type: 'bun',
      repoPath: EIDOVERSE_PATHS.worlds,
      startCommands: ['bun --env-file=.env.portos server/server.ts'],
    }));
    expect(status).toMatchObject({ installed: true, appId: 'app-eidoverse', runtimeStatus: 'not_started' });
  });

  it('refuses installation before creating files when Bun is unavailable', async () => {
    mock.bunAvailable = false;

    await expect(installEidoverse()).rejects.toMatchObject({ status: 412, code: 'EIDOVERSE_BUN_REQUIRED' });
    expect(mock.cloneRepo).not.toHaveBeenCalled();
    expect(mock.atomicWrite).not.toHaveBeenCalled();
  });

  it('keeps an unreadable app registry distinct from a confirmed missing registration', async () => {
    mock.registryError = new Error('apps registry unreadable');

    await expect(getEidoverseStatus()).resolves.toMatchObject({
      installed: false,
      registryAvailable: false,
      appRegistered: null,
      registryError: 'Managed-app registry unavailable',
    });
  });
});
