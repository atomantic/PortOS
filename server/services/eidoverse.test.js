import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';

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
  DEFAULT_EIDOVERSE_WORLDS_REPO,
  EIDOVERSE_VIDEO_REPO,
  getEidoversePaths,
  getEidoverseStatus,
  installEidoverse,
  normalizeEidoverseWorldsRepo,
} from './eidoverse.js';

const SELECTED_WORLDS_REPO = 'https://github.com/example-owner/eidoverse-worlds';
const selectedPaths = getEidoversePaths(SELECTED_WORLDS_REPO);

describe('Eidoverse managed-app installer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.existing.clear();
    mock.bunAvailable = true;
    mock.apps = [];
    mock.registryError = null;
    __resetEidoverseInstallForTests();

    mock.cloneRepo.mockImplementation(async (url) => {
      mock.existing.add(url === SELECTED_WORLDS_REPO
        ? join(selectedPaths.worlds, '.git')
        : join(selectedPaths.video, '.git'));
    });
    mock.spawn.mockImplementation(async (_cmd, _args, { cwd }) => {
      mock.existing.add(join(cwd, 'node_modules'));
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
    const status = await installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO });

    expect(mock.cloneRepo).toHaveBeenCalledWith(SELECTED_WORLDS_REPO);
    expect(mock.cloneRepo).toHaveBeenCalledWith(EIDOVERSE_VIDEO_REPO);
    expect(mock.spawn).toHaveBeenCalledWith('bun', ['install', '--frozen-lockfile'], expect.objectContaining({ cwd: selectedPaths.worlds }));
    expect(mock.spawn).toHaveBeenCalledWith('bun', ['install', '--frozen-lockfile'], expect.objectContaining({ cwd: join(selectedPaths.worlds, 'client') }));
    expect(mock.atomicWrite).toHaveBeenCalledWith(
      selectedPaths.envFile,
      expect.stringContaining(`EIDOVERSE_DIR=${JSON.stringify(selectedPaths.video)}`),
    );
    expect(mock.createApp).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Eidoverse Worlds',
      type: 'bun',
      repoPath: selectedPaths.worlds,
      companionRepoPaths: [selectedPaths.video],
      startCommands: ['bun --env-file=.env.portos server/server.ts'],
    }));
    expect(status).toMatchObject({
      installed: true,
      worldsRepoUrl: SELECTED_WORLDS_REPO,
      appId: 'app-eidoverse',
      runtimeStatus: 'not_started',
    });
  });

  it('uses the canonical upstream by default and normalizes a selected fork URL', () => {
    expect(getEidoversePaths().worlds).toBe(join('/example/data/repos', 'anima-research', 'eidoverse-worlds'));
    expect(DEFAULT_EIDOVERSE_WORLDS_REPO).toBe('https://github.com/anima-research/eidoverse-worlds');
    expect(normalizeEidoverseWorldsRepo('git@github.com:example-owner/eidoverse-worlds.git'))
      .toBe(SELECTED_WORLDS_REPO);
  });

  it('rejects non-GitHub Worlds repositories before cloning', async () => {
    await expect(installEidoverse({ worldsRepoUrl: 'https://example.com/eidoverse-worlds' }))
      .rejects.toMatchObject({ status: 400, code: 'EIDOVERSE_REPO_INVALID' });
    expect(mock.cloneRepo).not.toHaveBeenCalled();
  });

  it('refuses installation before creating files when Bun is unavailable', async () => {
    mock.bunAvailable = false;

    await expect(installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO }))
      .rejects.toMatchObject({ status: 412, code: 'EIDOVERSE_BUN_REQUIRED' });
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
