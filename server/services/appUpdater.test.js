import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mock = vi.hoisted(() => ({
  pull: vi.fn(),
  spawn: vi.fn(),
  dashboardOpen: vi.fn(),
  dashboardRunning: vi.fn(),
  dashboardHandle: { on: vi.fn() },
  restart: vi.fn(),
  syncFork: vi.fn(),
}));

vi.mock('./git.js', () => ({ pull: mock.pull }));
vi.mock('./pm2.js', () => ({ restartApp: mock.restart }));
vi.mock('../lib/bufferedSpawn.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, bufferedSpawnOrThrow: mock.spawn };
});
vi.mock('../lib/detachedSpawn.js', () => ({
  isDetachedRunning: mock.dashboardRunning,
  spawnDetached: mock.dashboardOpen,
}));
vi.mock('./managedAppRepositories.js', () => ({ syncManagedAppFork: mock.syncFork }));

import { updateApp } from './appUpdater.js';

describe('managed app updates', () => {
  let repo;

  beforeEach(async () => {
    vi.clearAllMocks();
    repo = await mkdtemp(join(tmpdir(), 'portos-app-updater-'));
    await mkdir(join(repo, 'client'));
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { setup: 'example-setup' } }));
    await writeFile(join(repo, 'client', 'package.json'), JSON.stringify({}));
    mock.pull.mockResolvedValue({ output: 'Already up to date' });
    mock.spawn.mockResolvedValue({ stdout: '', stderr: '' });
    mock.dashboardRunning.mockResolvedValue(false);
    mock.dashboardOpen.mockResolvedValue(mock.dashboardHandle);
    mock.restart.mockResolvedValue({ success: true });
    mock.syncFork.mockResolvedValue({
      alreadyUpToDate: false,
      fullName: 'example-owner/example-app',
      source: 'example-org/example-app',
    });
  });

  afterEach(async () => {
    await Promise.all(mock.dashboardOpen.mock.calls
      .map(([, , options]) => options?.controlDir)
      .filter(Boolean)
      .map((controlDir) => rm(controlDir, { recursive: true, force: true })));
    await rm(repo, { recursive: true, force: true });
  });

  it('uses Bun and its frozen lockfile for Bun-managed apps', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { setup: 'example-setup', build: 'vite build' } }));
    const emit = vi.fn();
    const companionRepo = join(repo, '..', 'eidoverse-video');
    const bunCommand = join(repo, 'tools with spaces', 'bun');
    const result = await updateApp({
      name: 'Eidoverse Worlds',
      type: 'bun',
      repoPath: repo,
      companionRepoPaths: [companionRepo],
      pm2ProcessNames: ['eidoverse-worlds'],
      startCommands: [`"${bunCommand}" --env-file=.env.portos server/server.ts`],
    }, emit);

    expect(result.success).toBe(true);
    expect(mock.pull).toHaveBeenNthCalledWith(1, repo);
    expect(mock.pull).toHaveBeenNthCalledWith(2, companionRepo);
    expect(mock.spawn).toHaveBeenCalledWith(bunCommand, ['install', '--frozen-lockfile'], expect.objectContaining({ cwd: repo }));
    expect(mock.spawn).toHaveBeenCalledWith(bunCommand, ['install', '--frozen-lockfile'], expect.objectContaining({ cwd: join(repo, 'client') }));
    expect(mock.spawn).toHaveBeenCalledWith(bunCommand, ['run', 'setup'], expect.objectContaining({ cwd: repo }));
    expect(mock.spawn).toHaveBeenCalledWith(bunCommand, ['run', 'build'], expect.objectContaining({ cwd: repo }));
    expect(mock.spawn).not.toHaveBeenCalledWith('npm', expect.anything(), expect.anything());
    expect(emit).toHaveBeenCalledWith('git-pull:companion-1', 'done', 'Already up to date');
    expect(emit).toHaveBeenCalledWith('bun-install:root', 'done', 'root dependencies installed');
  });

  it('syncs a detected fork before pulling when the managed update requests it', async () => {
    const emit = vi.fn();
    const managed = { name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] };

    await updateApp(managed, emit, { syncFork: true });

    expect(mock.syncFork).toHaveBeenCalledWith(managed);
    expect(mock.syncFork.mock.invocationCallOrder[0]).toBeLessThan(mock.pull.mock.invocationCallOrder[0]);
    expect(emit).toHaveBeenCalledWith(
      'git-sync-fork',
      'done',
      'Synced example-owner/example-app from example-org/example-app',
    );
  });

  it('starts the trusted dashboard handoff before restarting PortOS', async () => {
    const emit = vi.fn();
    const managed = {
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server', 'portos-browser'],
    };

    await updateApp(managed, emit);

    expect(mock.dashboardOpen).toHaveBeenCalledWith(
      process.execPath,
      [join(repo, 'scripts/open-ui-in-browser.js')],
      expect.objectContaining({
        cwd: repo,
        cleanup: true,
        controlDir: expect.stringContaining('portos-dashboard-open'),
      }),
    );
    expect(mock.dashboardRunning).toHaveBeenCalledWith(
      expect.stringContaining('portos-dashboard-open'),
      {
        executable: process.execPath,
        args: [join(repo, 'scripts/open-ui-in-browser.js')],
      },
    );
    expect(mock.dashboardOpen.mock.invocationCallOrder[0]).toBeLessThan(mock.restart.mock.invocationCallOrder[0]);
  });

  it('does not overwrite an unreadable dashboard handoff control dir', async () => {
    const emit = vi.fn();
    mock.dashboardRunning.mockRejectedValueOnce(new Error('control dir unavailable'));
    const managed = {
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server'],
    };

    await updateApp(managed, emit);

    expect(mock.dashboardOpen).not.toHaveBeenCalled();
    expect(mock.restart).toHaveBeenCalledWith('portos-server', undefined);
  });

  it('rebuilds the production UI before restarting so a managed update does not leave a stale client bundle', async () => {
    const emit = vi.fn();
    const managed = {
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      buildCommand: 'npm run build',
      pm2ProcessNames: ['portos-server'],
    };

    const result = await updateApp(managed, emit);

    expect(result.success).toBe(true);
    expect(result.steps.some((step) => step.step === 'build' && step.success)).toBe(true);
    expect(mock.spawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'build'],
      expect.objectContaining({ cwd: repo }),
    );
    const buildCall = mock.spawn.mock.invocationCallOrder[
      mock.spawn.mock.calls.findIndex((call) => call[0] === 'npm' && call[1]?.[1] === 'build')
    ];
    expect(buildCall).toBeLessThan(mock.restart.mock.invocationCallOrder[0]);
    expect(emit).toHaveBeenCalledWith('build', 'done', 'Production UI built');
  });

  it('rebuilds from package.json when no explicit build command is configured', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
    const emit = vi.fn();

    await updateApp({ name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] }, emit);

    expect(mock.spawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'build'],
      expect.objectContaining({ cwd: repo }),
    );
    expect(emit).toHaveBeenCalledWith('build', 'done', 'Production UI built');
  });

  it('does not invent a production build when the app has none', async () => {
    const emit = vi.fn();

    await updateApp({ name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] }, emit);

    expect(mock.spawn).not.toHaveBeenCalledWith('npm', ['run', 'build'], expect.anything());
    expect(emit).not.toHaveBeenCalledWith('build', expect.anything(), expect.anything());
  });

  it('refuses a disallowed build command before restarting', async () => {
    const emit = vi.fn();

    await expect(updateApp({
      name: 'Example App',
      type: 'express',
      repoPath: repo,
      buildCommand: 'rm -rf /',
      pm2ProcessNames: ['example-app'],
    }, emit)).rejects.toThrow(/not allowed/);

    expect(mock.restart).not.toHaveBeenCalled();
  });
});
