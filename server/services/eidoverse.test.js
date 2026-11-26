// test-memo: git-fixture — git only ever runs in repositories this suite creates under the temp directory (docs/TEST_MEMO.md#git-fixtures).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { commandExists } from '../lib/commandExists.js';
import { eidoverseStartCommand } from '../lib/eidoverseStartCommand.js';

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

vi.mock('./repoCloner.js', () => ({
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
  BUN_RELEASE_TARGETS,
  BUN_VERSION,
  getBunReleaseTarget,
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
      if (command === 'tar' || command === 'unzip') {
        const directory = command === 'tar' ? _args[_args.indexOf('-C') + 1] : _args[_args.indexOf('-d') + 1];
        const folder = join(directory, getBunReleaseTarget().archive.replace(/\.zip$/, ''));
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, process.platform === 'win32' ? 'bun.exe' : 'bun'), 'fake-bun');
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

  it('passes the selected branch only to the Worlds clone', async () => {
    await installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO, worldsBranch: ' feature/worlds ' });
    expect(mock.cloneRepo).toHaveBeenCalledWith(SELECTED_WORLDS_REPO, { branch: 'feature/worlds' });
    expect(mock.cloneRepo).toHaveBeenCalledWith(EIDOVERSE_VIDEO_REPO);
  });

  it('clones separate licensed repos, installs Bun dependencies, and registers Worlds', async () => {
    vi.stubEnv('PRIVACY_VAULT_KEY', 'vault');
    vi.stubEnv('PGPASSWORD', 'db');
    const status = await installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO });
    const installEnv = mock.spawn.mock.calls.find(([, args]) => args[0] === 'install')[2].env;
    expect(installEnv).not.toHaveProperty('PRIVACY_VAULT_KEY');
    expect(installEnv).not.toHaveProperty('PGPASSWORD');
    for (const [, , options] of vi.mocked(commandExists).mock.calls) {
      expect(options.env).not.toHaveProperty('PRIVACY_VAULT_KEY');
      expect(options.env).not.toHaveProperty('PGPASSWORD');
    }
    vi.unstubAllEnvs();

    expect(mock.cloneRepo).toHaveBeenCalledWith(SELECTED_WORLDS_REPO, { branch: '' });
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
      startCommands: [eidoverseStartCommand('bun')],
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

    expect(mock.cloneRepo).not.toHaveBeenCalledWith(SELECTED_WORLDS_REPO, { branch: '' });
    expect(mock.spawn).toHaveBeenCalledWith('bun', ['install', '--frozen-lockfile'], expect.objectContaining({ cwd: existingPaths.worlds }));
    expect(mock.atomicWrite).toHaveBeenCalledWith(
      existingPaths.envFile,
      expect.stringContaining(`EIDOVERSE_DIR=${JSON.stringify(existingPaths.video)}`),
    );
    expect(status).toMatchObject({ installed: true, appId: 'app-eidoverse' });
  });

  it('configures a fresh checkout with the selected SSH origin', async () => {
    const status = await installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO_SSH });

    expect(mock.cloneRepo).toHaveBeenCalledWith(SELECTED_WORLDS_REPO_SSH, { branch: '' });
    expect(mock.execGit).toHaveBeenCalledWith(
      ['remote', 'set-url', 'origin', SELECTED_WORLDS_REPO_SSH],
      selectedPaths.worlds,
      { ignoreExitCode: true },
    );
    expect(status).toMatchObject({ installed: true, worldsRepoUrl: SELECTED_WORLDS_REPO_SSH });
  });

  it('uses the canonical upstream by default and preserves the selected Git transport', () => {
    expect(getEidoversePaths().worlds).toBe(join('/example/data/repos', 'atomantic', 'eidoverse-worlds'));
    expect(DEFAULT_EIDOVERSE_WORLDS_REPO).toBe('https://github.com/atomantic/eidoverse-worlds');
    expect(normalizeEidoverseWorldsRepo('https://github.com/example-owner/eidoverse-worlds.git'))
      .toBe(SELECTED_WORLDS_REPO);
    expect(normalizeEidoverseWorldsRepo('git@github.com:example-owner/eidoverse-worlds.git'))
      .toBe('git@github.com:example-owner/eidoverse-worlds.git');
  });

  it('pins a SHA-256 digest for every supported platform and keeps remote install scripts out of the module', async () => {
    expect(Object.keys(BUN_RELEASE_TARGETS).sort())
      .toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
    for (const target of Object.values(BUN_RELEASE_TARGETS)) expect(target.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(getBunReleaseTarget('freebsd', 'x64')).toBeNull();
    const source = await (await import('node:fs/promises')).readFile(new URL('./eidoverse.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Invoke-Expression|bun\.com\/install|curl -fsSL/);
  });

  it('rejects non-GitHub Worlds repositories before cloning', async () => {
    await expect(installEidoverse({ worldsRepoUrl: 'https://example.com/eidoverse-worlds' }))
      .rejects.toMatchObject({ status: 400, code: 'EIDOVERSE_REPO_INVALID' });
    expect(mock.cloneRepo).not.toHaveBeenCalled();
  });

  describe('pinned Bun download', () => {
    let root;
    let previousInstall;
    const target = getBunReleaseTarget();
    const archiveBytes = Buffer.from('fake-archive');

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'eidoverse-bun-'));
      previousInstall = process.env.BUN_INSTALL;
      process.env.BUN_INSTALL = root;
      mock.bunAvailable = false;
      vi.stubGlobal('fetch', vi.fn(async () => new Response(archiveBytes)));
    });

    afterEach(async () => {
      vi.unstubAllGlobals();
      if (previousInstall === undefined) delete process.env.BUN_INSTALL;
      else process.env.BUN_INSTALL = previousInstall;
      await rm(root, { recursive: true, force: true });
    });

    it('verifies the pinned digest, extracts the binary, and installs before cloning', async () => {
      const digest = createHash('sha256').update(archiveBytes).digest('hex');
      const patched = { ...BUN_RELEASE_TARGETS[`${process.platform}-${process.arch}`] };
      const original = patched.sha256;
      // The table is frozen at the top level only; entries are patched for the fixture archive.
      Object.defineProperty(BUN_RELEASE_TARGETS[`${process.platform}-${process.arch}`], 'sha256', { value: digest, configurable: true });
      try {
        await expect(installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO }))
          .resolves.toMatchObject({ installed: true, bunAvailable: true });
      } finally {
        Object.defineProperty(BUN_RELEASE_TARGETS[`${process.platform}-${process.arch}`], 'sha256', { value: original, configurable: true });
      }

      expect(fetch).toHaveBeenCalledWith(
        `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${target.archive}`,
        expect.objectContaining({ signal: expect.anything() }),
      );
      const bunExecutable = getBunExecutable();
      expect((await stat(bunExecutable)).isFile()).toBe(true);
      if (process.platform !== 'win32') expect((await stat(bunExecutable)).mode & 0o777).toBe(0o755);
      expect(mock.spawn).toHaveBeenCalledWith(
        bunExecutable,
        ['install', '--frozen-lockfile'],
        expect.objectContaining({ cwd: selectedPaths.worlds }),
      );
    });

    it('refuses a digest mismatch without extracting or executing anything', async () => {
      await expect(installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO }))
        .rejects.toMatchObject({ code: 'EIDOVERSE_BUN_DIGEST_MISMATCH' });
      expect(mock.spawn).not.toHaveBeenCalled();
      await expect(stat(getBunExecutable())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(mock.cloneRepo).not.toHaveBeenCalled();
    });

    it('fails closed when the download fails', async () => {
      fetch.mockResolvedValue(new Response('nope', { status: 404 }));
      await expect(installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO }))
        .rejects.toMatchObject({ code: 'EIDOVERSE_BUN_DOWNLOAD_FAILED' });
      expect(mock.spawn).not.toHaveBeenCalled();
    });
  });

  it('reuses the default Bun installation without any download even when it is not on PATH', async () => {
    mock.bunAvailable = false;
    mock.installedBunAvailable = true;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await installEidoverse({ worldsRepoUrl: SELECTED_WORLDS_REPO });
    vi.unstubAllGlobals();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalledWith('tar', expect.anything(), expect.anything());
    expect(mock.spawn).toHaveBeenCalledWith(
      getBunExecutable(),
      ['install', '--frozen-lockfile'],
      expect.objectContaining({ cwd: selectedPaths.worlds }),
    );
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

  it('applies a new tracking branch to a real single-branch clone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eidoverse-source-'));
    const remote = join(root, 'remote');
    const checkout = join(root, 'checkout');
    const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      git(['init', '-b', 'main', remote]);
      git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial'], remote);
      git(['branch', 'portos'], remote);
      git(['clone', '--single-branch', '--branch', 'main', remote, checkout]);
      mock.apps = [{ id: 'worlds', repoPath: checkout, pm2ProcessNames: ['eidoverse-worlds'] }];
      mock.existing.add(join(checkout, '.git'));
      const { execGit } = await vi.importActual('../lib/execGit.js');
      mock.execGit.mockImplementation((args, cwd, options) => execGit(args.map(arg => arg === SELECTED_WORLDS_REPO ? remote : arg), cwd, options));
      await setEidoverseWorldsOrigin(SELECTED_WORLDS_REPO, 'portos');
      expect(git(['branch', '--show-current'], checkout).trim()).toBe('portos');
      expect(git(['rev-parse', '--abbrev-ref', '@{upstream}'], checkout).trim()).toBe('origin/portos');
      expect(git(['config', '--get', 'portos.runtimeBranch'], checkout).trim()).toBe('portos');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('switches and tracks the selected runtime branch without resetting local work', async () => {
    mock.apps = [{ id: 'worlds', repoPath: selectedPaths.worlds, pm2ProcessNames: ['eidoverse-worlds'] }];
    mock.existing.add(join(selectedPaths.worlds, '.git'));
    await setEidoverseWorldsOrigin(SELECTED_WORLDS_REPO, 'portos');
    expect(mock.execGit).toHaveBeenCalledWith(['switch', '--', 'portos'], selectedPaths.worlds);
    expect(mock.execGit).toHaveBeenCalledWith(['config', 'branch.portos.merge', 'refs/heads/portos'], selectedPaths.worlds);
    expect(mock.execGit).toHaveBeenCalledWith(['config', 'portos.runtimeBranch', 'portos'], selectedPaths.worlds);

    mock.execGit.mockClear();
    mock.execGit.mockImplementation(async (args) => ({ stdout: args[0] === 'status' ? ' M local.txt' : '', exitCode: 0 }));
    await expect(setEidoverseWorldsOrigin(SELECTED_WORLDS_REPO, 'main')).rejects.toMatchObject({ code: 'EIDOVERSE_CHECKOUT_DIRTY' });
    expect(mock.execGit.mock.calls.some(([args]) => ['switch', 'remote', 'fetch'].includes(args[0]))).toBe(false);
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
