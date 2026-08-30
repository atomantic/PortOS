import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';

const mock = vi.hoisted(() => ({
  existing: new Set(),
  bunAvailable: true,
  installedBunAvailable: false,
  apps: [],
  registryError: null,
  cloneRepo: vi.fn(),
  execGit: vi.fn(),
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
  commandExists: vi.fn(async (command) => (
    command === 'bun' ? mock.bunAvailable : mock.installedBunAvailable
  )),
}));

vi.mock('../lib/execGit.js', () => ({
  execGit: mock.execGit,
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
  getBunExecutable,
  getBunInstallInvocation,
  getEidoversePaths,
  getEidoverseStatus,
  installEidoverse,
  normalizeEidoverseWorldsRepo,
  setEidoverseWorldsOrigin,
} from './eidoverse.js';

const SELECTED_WORLDS_REPO = 'https://github.com/example-owner/eidoverse-worlds';
const SELECTED_WORLDS_REPO_SSH = 'git@github.com:example-owner/eidoverse-worlds.git';
const selectedPaths = getEidoversePaths(SELECTED_WORLDS_REPO);

describe('Eidoverse managed-app installer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.existing.clear();
    mock.bunAvailable = true;
    mock.installedBunAvailable = false;
    mock.apps = [];
    mock.registryError = null;
    mock.execGit.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    __resetEidoverseInstallForTests();

    mock.cloneRepo.mockImplementation(async (url) => {
      mock.existing.add(url === EIDOVERSE_VIDEO_REPO
        ? join(selectedPaths.video, '.git')
        : join(selectedPaths.worlds, '.git'));
    });
    mock.spawn.mockImplementation(async (command, _args, options = {}) => {
      if (command === 'powershell' || command === 'bash') {
        mock.installedBunAvailable = true;
      } else {
        mock.existing.add(join(options.cwd, 'node_modules'));
      }
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
    mock.updateApp.mockImplementation(async (id, fields) => {
      const index = mock.apps.findIndex((app) => app.id === id);
      mock.apps[index] = { ...mock.apps[index], ...fields };
      return mock.apps[index];
    });
  });

  it('clones separate licensed repos, installs Bun dependencies, and registers Worlds', async () => {
    const status = await installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO });

    expect(mock.cloneRepo).toHaveBeenCalledWith(SELECTED_WORLDS_REPO);
    expect(mock.cloneRepo).toHaveBeenCalledWith(EIDOVERSE_VIDEO_REPO);
    expect(mock.execGit).toHaveBeenCalledWith(
      ['remote', 'set-url', 'origin', SELECTED_WORLDS_REPO],
      selectedPaths.worlds,
      { ignoreExitCode: true },
    );
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

  it('resumes an existing checkout after its configured source changes', async () => {
    const existingPaths = getEidoversePaths();
    mock.apps = [{
      id: 'app-eidoverse',
      name: 'Eidoverse Worlds',
      repoPath: existingPaths.worlds,
      pm2ProcessNames: ['eidoverse-worlds'],
    }];
    mock.existing.add(join(existingPaths.worlds, '.git'));

    const status = await installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO });

    expect(mock.cloneRepo).not.toHaveBeenCalledWith(SELECTED_WORLDS_REPO);
    expect(mock.spawn).toHaveBeenCalledWith('bun', ['install', '--frozen-lockfile'], expect.objectContaining({ cwd: existingPaths.worlds }));
    expect(mock.atomicWrite).toHaveBeenCalledWith(
      existingPaths.envFile,
      expect.stringContaining(`EIDOVERSE_DIR=${JSON.stringify(existingPaths.video)}`),
    );
    expect(status).toMatchObject({ installed: true, appId: 'app-eidoverse' });
  });

  it('configures a fresh checkout with the selected SSH origin', async () => {
    const status = await installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO_SSH });

    expect(mock.cloneRepo).toHaveBeenCalledWith(SELECTED_WORLDS_REPO_SSH);
    expect(mock.execGit).toHaveBeenCalledWith(
      ['remote', 'set-url', 'origin', SELECTED_WORLDS_REPO_SSH],
      selectedPaths.worlds,
      { ignoreExitCode: true },
    );
    expect(status).toMatchObject({ installed: true, worldsRepoUrl: SELECTED_WORLDS_REPO_SSH });
  });

  it('uses the canonical upstream by default and preserves the selected Git transport', () => {
    expect(getEidoversePaths().worlds).toBe(join('/example/data/repos', 'anima-research', 'eidoverse-worlds'));
    expect(DEFAULT_EIDOVERSE_WORLDS_REPO).toBe('https://github.com/anima-research/eidoverse-worlds');
    expect(normalizeEidoverseWorldsRepo('https://github.com/example-owner/eidoverse-worlds.git'))
      .toBe(SELECTED_WORLDS_REPO);
    expect(normalizeEidoverseWorldsRepo('git@github.com:example-owner/eidoverse-worlds.git'))
      .toBe('git@github.com:example-owner/eidoverse-worlds.git');
  });

  it('selects the official unattended Bun installer for each supported platform', () => {
    expect(getBunInstallInvocation('win32')).toEqual({
      command: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "Invoke-RestMethod 'https://bun.com/install.ps1' | Invoke-Expression",
      ],
    });
    expect(getBunInstallInvocation('darwin')).toEqual({
      command: 'bash',
      args: ['-c', 'curl -fsSL https://bun.com/install | bash'],
    });
    expect(getBunInstallInvocation('linux')).toEqual(getBunInstallInvocation('darwin'));
  });

  it('rejects non-GitHub Worlds repositories before cloning', async () => {
    await expect(installEidoverse({ worldsRepoUrl: 'https://example.com/eidoverse-worlds' }))
      .rejects.toMatchObject({ status: 400, code: 'EIDOVERSE_REPO_INVALID' });
    expect(mock.cloneRepo).not.toHaveBeenCalled();
  });

  it('installs Bun automatically before cloning when it is unavailable', async () => {
    mock.bunAvailable = false;

    await expect(installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO }))
      .resolves.toMatchObject({ installed: true, bunAvailable: true });

    const installer = getBunInstallInvocation();
    const bunExecutable = getBunExecutable();
    expect(mock.spawn).toHaveBeenCalledWith(
      installer.command,
      installer.args,
      expect.objectContaining({ timeoutLabel: 'Bun installation' }),
    );
    expect(mock.spawn).toHaveBeenCalledWith(
      bunExecutable,
      ['install', '--frozen-lockfile'],
      expect.objectContaining({ cwd: selectedPaths.worlds }),
    );
    expect(mock.createApp).toHaveBeenCalledWith(expect.objectContaining({
      startCommands: [expect.stringContaining(bunExecutable)],
    }));
  });

  it('reuses the default Bun installation even when it is not on PATH', async () => {
    mock.bunAvailable = false;
    mock.installedBunAvailable = true;

    await installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO });

    const installer = getBunInstallInvocation();
    expect(mock.spawn).not.toHaveBeenCalledWith(
      installer.command,
      installer.args,
      expect.anything(),
    );
    expect(mock.spawn).toHaveBeenCalledWith(
      getBunExecutable(),
      ['install', '--frozen-lockfile'],
      expect.objectContaining({ cwd: selectedPaths.worlds }),
    );
  });

  it('stops before cloning when the Bun installer does not produce a runnable binary', async () => {
    mock.bunAvailable = false;
    mock.spawn.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO }))
      .rejects.toMatchObject({ status: 500, code: 'EIDOVERSE_BUN_INSTALL_FAILED' });
    expect(mock.cloneRepo).not.toHaveBeenCalled();
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

  it('changes the origin of an existing checkout without moving or cloning it', async () => {
    const existingPaths = getEidoversePaths();
    mock.apps = [{
      id: 'app-eidoverse',
      name: 'Eidoverse Worlds',
      repoPath: existingPaths.worlds,
      pm2ProcessNames: ['eidoverse-worlds'],
    }];
    mock.existing.add(join(existingPaths.worlds, '.git'));

    await expect(setEidoverseWorldsOrigin(SELECTED_WORLDS_REPO)).resolves.toEqual({
      appId: 'app-eidoverse',
      worldsRepoUrl: SELECTED_WORLDS_REPO,
    });
    expect(mock.execGit).toHaveBeenCalledWith(
      ['remote', 'set-url', 'origin', SELECTED_WORLDS_REPO],
      existingPaths.worlds,
      { ignoreExitCode: true },
    );
    expect(mock.cloneRepo).not.toHaveBeenCalled();
  });

  it('keeps the registered checkout installed after its configured source changes', async () => {
    const existingPaths = getEidoversePaths();
    mock.apps = [{
      id: 'app-eidoverse',
      name: 'Eidoverse Worlds',
      repoPath: existingPaths.worlds,
      pm2ProcessNames: ['eidoverse-worlds'],
    }];
    mock.existing = new Set([
      join(existingPaths.worlds, '.git'),
      join(existingPaths.worlds, 'node_modules'),
      join(existingPaths.worlds, 'client', 'node_modules'),
      existingPaths.envFile,
      join(existingPaths.video, '.git'),
      existingPaths.worldData,
    ]);

    await expect(getEidoverseStatus({ worldsRepoUrl: SELECTED_WORLDS_REPO })).resolves.toMatchObject({
      installed: true,
      worldsRepoUrl: SELECTED_WORLDS_REPO,
      appId: 'app-eidoverse',
    });
  });

  it('refuses to update a source when the managed checkout is missing', async () => {
    mock.apps = [{
      id: 'app-eidoverse',
      name: 'Eidoverse Worlds',
      repoPath: getEidoversePaths().worlds,
      pm2ProcessNames: ['eidoverse-worlds'],
    }];

    await expect(setEidoverseWorldsOrigin(SELECTED_WORLDS_REPO)).rejects.toMatchObject({
      status: 409,
      code: 'EIDOVERSE_CHECKOUT_MISSING',
    });
    expect(mock.execGit).not.toHaveBeenCalled();
  });

  it('adds origin when an existing checkout has no origin remote', async () => {
    const existingPaths = getEidoversePaths();
    mock.apps = [{
      id: 'app-eidoverse',
      repoPath: existingPaths.worlds,
      pm2ProcessNames: ['eidoverse-worlds'],
    }];
    mock.existing.add(join(existingPaths.worlds, '.git'));
    mock.execGit
      .mockResolvedValueOnce({ stdout: '', stderr: "error: No such remote 'origin'", exitCode: 2 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await expect(setEidoverseWorldsOrigin(SELECTED_WORLDS_REPO)).resolves.toMatchObject({
      appId: 'app-eidoverse',
      worldsRepoUrl: SELECTED_WORLDS_REPO,
    });
    expect(mock.execGit).toHaveBeenNthCalledWith(
      2,
      ['remote', 'add', 'origin', SELECTED_WORLDS_REPO],
      existingPaths.worlds,
      { ignoreExitCode: true },
    );
  });

  it('refuses to update a source with no registered managed app', async () => {
    await expect(setEidoverseWorldsOrigin(SELECTED_WORLDS_REPO)).rejects.toMatchObject({
      status: 409,
      code: 'EIDOVERSE_NOT_INSTALLED',
    });
    expect(mock.execGit).not.toHaveBeenCalled();
  });
});
