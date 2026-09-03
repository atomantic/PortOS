import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mock = vi.hoisted(() => ({
  // updateExecutor resolves update.sh from PATHS.root, so the delegation is
  // gated on the app record pointing at this checkout — point it at the
  // per-test temp repo instead.
  paths: { root: '' },
  updateDefaultBranch: vi.fn(),
  spawn: vi.fn(),
  executeUpdate: vi.fn(),
  setUpdateInProgress: vi.fn(),
  dashboardOpen: vi.fn(),
  dashboardRunning: vi.fn(),
  dashboardHandle: { on: vi.fn() },
  restart: vi.fn(),
  syncFork: vi.fn(),
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: mock.paths };
});
vi.mock('./git.js', () => ({ updateDefaultBranch: mock.updateDefaultBranch }));
vi.mock('./pm2.js', () => ({ restartApp: mock.restart }));
vi.mock('../lib/bufferedSpawn.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, bufferedSpawnOrThrow: mock.spawn };
});
vi.mock('./updateExecutor.js', () => ({ executeUpdate: mock.executeUpdate }));
vi.mock('./updateChecker.js', () => ({ setUpdateInProgress: mock.setUpdateInProgress }));
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
    mock.paths.root = repo;
    await mkdir(join(repo, 'client'));
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { setup: 'example-setup' } }));
    await writeFile(join(repo, 'client', 'package.json'), JSON.stringify({}));
    mock.updateDefaultBranch.mockResolvedValue({ branch: 'main', output: 'Already up to date' });
    mock.spawn.mockResolvedValue({ stdout: '', stderr: '' });
    mock.executeUpdate.mockResolvedValue({ success: true, version: '9.9.9' });
    mock.setUpdateInProgress.mockResolvedValue(true);
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

  it('uses the Bun portos:update script without inheriting PortOS install or build steps', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'portos:update': 'example-update', setup: 'example-setup', build: 'vite build' } }));
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
    expect(mock.updateDefaultBranch).toHaveBeenNthCalledWith(1, repo);
    expect(mock.updateDefaultBranch).toHaveBeenNthCalledWith(2, companionRepo);
    expect(mock.spawn).toHaveBeenCalledWith(bunCommand, ['run', 'portos:update'], expect.objectContaining({ cwd: repo }));
    expect(mock.spawn).not.toHaveBeenCalledWith('npm', expect.anything(), expect.anything());
    expect(emit).toHaveBeenCalledWith('git-pull:companion-1', 'done', 'Already up to date');
    expect(emit).toHaveBeenCalledWith('app-update', 'done', 'App update routine complete');
  });

  it('syncs a detected fork before pulling when the managed update requests it', async () => {
    const emit = vi.fn();
    const managed = { name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] };

    await updateApp(managed, emit, { syncFork: true });

    expect(mock.syncFork).toHaveBeenCalledWith(managed);
    expect(mock.syncFork.mock.invocationCallOrder[0]).toBeLessThan(mock.updateDefaultBranch.mock.invocationCallOrder[0]);
    expect(emit).toHaveBeenCalledWith(
      'git-sync-fork',
      'done',
      'Synced example-owner/example-app from example-org/example-app',
    );
  });

  it('launches PortOS\'s own update through the detached executor, never the attached spawn', async () => {
    // PortOS is a managed app, so App Management updates route through here —
    // and update.sh's `pm2 delete` tree-kills the server that would be this
    // spawn's PPID parent, taking the script down mid-delete (#5976). The
    // detached launcher in updateExecutor is what survives it.
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(repo, 'update.ps1'), 'exit 0\n');
    await writeFile(join(repo, 'package.json'), JSON.stringify({ version: '2.56.0' }));
    const emit = vi.fn();

    const result = await updateApp({
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server', 'portos-cos', 'portos-browser'],
    }, emit);

    expect(result.success).toBe(true);
    expect(mock.executeUpdate).toHaveBeenCalledWith('2.56.0', emit);
    expect(mock.spawn).not.toHaveBeenCalled();
    // The flag CoS spawn gates read (#4124) has to be up before the script that
    // deletes portos-cos starts, not after.
    expect(mock.setUpdateInProgress).toHaveBeenCalledWith(true);
    expect(mock.setUpdateInProgress.mock.invocationCallOrder[0])
      .toBeLessThan(mock.executeUpdate.mock.invocationCallOrder[0]);
    expect(emit).toHaveBeenCalledWith('app-update', 'done', 'App update routine complete');
  });

  it('leaves the PM2 restart to update.sh instead of double-restarting PortOS', async () => {
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(repo, 'update.ps1'), 'exit 0\n');
    const emit = vi.fn();

    const result = await updateApp({
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server', 'portos-cos'],
    }, emit);

    expect(mock.restart).not.toHaveBeenCalled();
    expect(result.steps.some((step) => step.step === 'restart')).toBe(false);
    expect(emit).not.toHaveBeenCalledWith('restart', expect.anything(), expect.anything());
    // update.sh runs open-ui-in-browser.js itself once the ecosystem is back.
    expect(mock.dashboardOpen).not.toHaveBeenCalled();
  });

  it('surfaces a failed PortOS update instead of reporting success', async () => {
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 1\n');
    await writeFile(join(repo, 'update.ps1'), 'exit 1\n');
    mock.executeUpdate.mockResolvedValue({ success: false, failedStep: 'npm-install', errorMessage: 'Update failed at step "npm-install" (exit code 1)' });

    await expect(updateApp({
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server'],
    }, vi.fn())).rejects.toThrow('Update failed at step "npm-install" (exit code 1)');
  });

  it('refuses to launch a second update while one already holds the flag', async () => {
    // The same atomic lock POST /api/update/execute takes — the two entry points
    // into update.sh must not launch it concurrently.
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(repo, 'update.ps1'), 'exit 0\n');
    mock.setUpdateInProgress.mockResolvedValue(false);

    await expect(updateApp({
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server'],
    }, vi.fn())).rejects.toThrow(/already in progress/i);

    expect(mock.executeUpdate).not.toHaveBeenCalled();
  });

  it('still delegates when the record spells this checkout differently', async () => {
    // repoPath is user-editable and not force-synced, so a trailing slash or a
    // '..' segment is a realistic spelling — and treating it as "not this
    // checkout" would silently re-arm the attached spawn of #5976.
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(repo, 'update.ps1'), 'exit 0\n');

    await updateApp({
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: `${repo}/client/..`,
      pm2ProcessNames: ['portos-server'],
    }, vi.fn());

    expect(mock.executeUpdate).toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it('does not delegate when the PortOS record points outside this checkout', async () => {
    // executeUpdate resolves update.sh from PATHS.root, not from the record —
    // delegating a record aimed elsewhere would run a different script than the
    // one the update was configured to run.
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(repo, 'update.ps1'), 'exit 0\n');
    mock.paths.root = join(repo, 'somewhere-else');

    await updateApp({
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server'],
    }, vi.fn());

    expect(mock.executeUpdate).not.toHaveBeenCalled();
    expect(mock.spawn).toHaveBeenCalled();
    expect(mock.restart).toHaveBeenCalledWith('portos-server', undefined);
  });

  it('keeps a non-PortOS app on the attached spawn and its own PM2 restart', async () => {
    // The detached launcher is PortOS-only — it hard-codes this checkout's
    // update script, which is not another app's update routine.
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(repo, 'update.ps1'), 'exit 0\n');

    await updateApp({
      id: 'example-managed-app',
      name: 'Example App',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['example-app'],
    }, vi.fn());

    expect(mock.executeUpdate).not.toHaveBeenCalled();
    expect(mock.spawn).toHaveBeenCalled();
    expect(mock.restart).toHaveBeenCalledWith('example-app', undefined);
  });

  it('honors a custom update command configured on the PortOS record', async () => {
    // Delegating here would silently run update.sh instead of what the user
    // configured, so the explicit command keeps the ordinary attached path.
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(repo, 'update.ps1'), 'exit 0\n');

    await updateApp({
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      updateCommand: 'npm run update',
      pm2ProcessNames: ['portos-server'],
    }, vi.fn());

    expect(mock.executeUpdate).not.toHaveBeenCalled();
    expect(mock.spawn).toHaveBeenCalledWith('npm', ['run', 'update'], expect.objectContaining({ cwd: repo }));
    expect(mock.restart).toHaveBeenCalledWith('portos-server', undefined);
    // This path still restarts PortOS itself, so it still owns the dashboard
    // handoff — only the delegated one hands that to update.sh.
    expect(mock.dashboardOpen).toHaveBeenCalled();
    expect(mock.dashboardOpen.mock.invocationCallOrder[0]).toBeLessThan(mock.restart.mock.invocationCallOrder[0]);
  });

  it('runs an explicit update command before restarting', async () => {
    const emit = vi.fn();
    const managed = {
      id: 'example-managed-app',
      name: 'Example App',
      type: 'express',
      repoPath: repo,
      updateCommand: 'npm run update',
      pm2ProcessNames: ['example-app'],
    };

    const result = await updateApp(managed, emit);

    expect(result.success).toBe(true);
    expect(result.steps.some((step) => step.step === 'app-update' && step.success)).toBe(true);
    expect(mock.spawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'update'],
      expect.objectContaining({ cwd: repo }),
    );
    const updateCall = mock.spawn.mock.invocationCallOrder[
      mock.spawn.mock.calls.findIndex((call) => call[0] === 'npm' && call[1]?.[1] === 'update')
    ];
    expect(updateCall).toBeLessThan(mock.restart.mock.invocationCallOrder[0]);
    expect(emit).toHaveBeenCalledWith('app-update', 'done', 'App update routine complete');
  });

  it('runs the dedicated package script when no explicit update command is configured', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { 'portos:update': 'vite build' } }));
    const emit = vi.fn();

    await updateApp({ name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] }, emit);

    expect(mock.spawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'portos:update'],
      expect.objectContaining({ cwd: repo }),
    );
    expect(emit).toHaveBeenCalledWith('app-update', 'done', 'App update routine complete');
  });

  it('recognizes a conventional repository update script', async () => {
    // The convention is platform-specific: a POSIX host looks for update.sh and
    // executes it directly, while Windows looks for update.ps1 and hands it to
    // powershell. Assert the shape for the host actually running the suite.
    const isWindows = process.platform === 'win32';
    const scriptName = isWindows ? 'update.ps1' : 'update.sh';
    const scriptPath = join(repo, scriptName);
    await writeFile(scriptPath, isWindows ? 'exit 0\n' : '#!/bin/sh\nexit 0\n');
    const emit = vi.fn();

    await updateApp({ name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] }, emit);

    expect(mock.spawn).toHaveBeenCalledWith(
      isWindows ? 'powershell' : scriptPath,
      isWindows ? ['-ExecutionPolicy', 'Bypass', '-File', scriptPath] : [],
      expect.objectContaining({ cwd: repo }),
    );
  });

  it('defaults to checkout update and restart without guessing package lifecycle steps', async () => {
    const emit = vi.fn();

    await updateApp({ name: 'Example App', type: 'express', repoPath: repo, pm2ProcessNames: [] }, emit);

    expect(mock.spawn).not.toHaveBeenCalled();
    expect(mock.updateDefaultBranch).toHaveBeenCalledWith(repo);
    expect(emit).not.toHaveBeenCalledWith('app-update', expect.anything(), expect.anything());
  });

  it('refuses a disallowed update command before restarting', async () => {
    const emit = vi.fn();

    await expect(updateApp({
      name: 'Example App',
      type: 'express',
      repoPath: repo,
      updateCommand: 'rm -rf /',
      pm2ProcessNames: ['example-app'],
    }, emit)).rejects.toThrow(/Update command is not allowed/);

    expect(mock.restart).not.toHaveBeenCalled();
  });
});
