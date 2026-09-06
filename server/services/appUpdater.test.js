import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mock = vi.hoisted(() => ({
  // The shared launcher resolves update.sh from PATHS.root, so the delegation
  // is gated on the app record pointing at this checkout — point it at the
  // per-test temp repo instead.
  paths: { root: '' },
  updateDefaultBranch: vi.fn(),
  addTask: vi.fn(),
  spawn: vi.fn(),
  startPortosSelfUpdate: vi.fn(),
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
vi.mock('./portosSelfUpdate.js', () => ({ startPortosSelfUpdate: mock.startPortosSelfUpdate }));
vi.mock('../lib/detachedSpawn.js', () => ({
  isDetachedRunning: mock.dashboardRunning,
  spawnDetached: mock.dashboardOpen,
}));
vi.mock('./managedAppRepositories.js', () => ({ syncManagedAppFork: mock.syncFork }));
vi.mock('./cosTaskStore.js', () => ({ addTask: mock.addTask }));

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
    mock.startPortosSelfUpdate.mockResolvedValue({ started: true, tag: 'v9.9.9' });
    mock.dashboardRunning.mockResolvedValue(false);
    mock.dashboardOpen.mockResolvedValue(mock.dashboardHandle);
    mock.restart.mockResolvedValue({ success: true });
    mock.addTask.mockResolvedValue({ id: 'sys-conflict' });
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

  it('queues a CoS agent and stops the update when the pull hits a conflict', async () => {
    mock.updateDefaultBranch.mockResolvedValueOnce({
      success: false,
      branch: 'main',
      conflict: true,
      error: 'CONFLICT (content): Merge conflict in server/index.js',
    });
    const emit = vi.fn();

    const result = await updateApp({
      id: 'example-app',
      name: 'Example App',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['example-app'],
    }, emit);

    expect(result.success).toBe(false);
    expect(result.steps).toEqual([expect.objectContaining({ step: 'git-pull', success: false })]);
    expect(emit).toHaveBeenCalledWith('git-pull', 'error', expect.stringContaining('CoS agent'));
    expect(mock.addTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: `Resolve git conflict in Example App at ${repo}`,
        app: 'example-app',
        priority: 'HIGH',
      }),
      'internal',
    );
    expect(mock.addTask.mock.calls[0][0].context).toContain('Merge conflict in server/index.js');
    // The conflict is upstream of every mutating step — nothing may run on a
    // checkout that is mid-rebase or carrying conflict markers.
    expect(mock.spawn).not.toHaveBeenCalled();
    expect(mock.restart).not.toHaveBeenCalled();
  });

  it('queues a CoS agent for a companion repository conflict', async () => {
    const companionRepo = join(repo, '..', 'example-companion');
    mock.updateDefaultBranch
      .mockResolvedValueOnce({ branch: 'main', output: 'Already up to date' })
      .mockResolvedValueOnce({ success: false, branch: 'main', conflict: true, error: 'CONFLICT (content): x' });
    const emit = vi.fn();

    const result = await updateApp({
      id: 'example-app',
      name: 'Example App',
      type: 'express',
      repoPath: repo,
      companionRepoPaths: [companionRepo],
      pm2ProcessNames: ['example-app'],
    }, emit);

    expect(result.success).toBe(false);
    expect(emit).toHaveBeenCalledWith('git-pull:companion-1', 'error', expect.stringContaining('CoS agent'));
    // `app` routes the agent's workspace to the app's PRIMARY repoPath, so a
    // companion conflict must NOT claim it — the agent would land in a checkout
    // that isn't even conflicted. The absolute path steers it instead.
    expect(mock.addTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: `Resolve git conflict in Example App at ${companionRepo}`,
        app: null,
        context: expect.stringContaining(companionRepo),
      }),
      'internal',
    );
    expect(mock.restart).not.toHaveBeenCalled();
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

  it('hands PortOS\'s own update to the shared launcher and returns without awaiting update.sh', async () => {
    // PortOS is a managed app, so App Management updates route through here —
    // and update.sh's `pm2 delete` tree-kills the server that would be this
    // spawn's PPID parent, taking the script down mid-delete (#5976). The
    // shared launcher owns the detached spawn that survives it, the preflight
    // and the update lock; this path must not re-roll any of them, and must
    // not await a script that outlives the process awaiting it.
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
    }, emit, { acknowledgeFork: true });

    expect(result).toMatchObject({ success: true, selfUpdateStarted: true });
    // `refresh`, because the git-pull step above already moved the checkout —
    // a reconcile's out-of-sync gate would only be re-asking whether that pull
    // happened. No `io`: App Management renders the run from `onStep`, and
    // mirroring the same frames onto portos:update:* would double the fan-out.
    expect(mock.startPortosSelfUpdate).toHaveBeenCalledWith({
      acknowledgeFork: true,
      acknowledgePersistentMindImageBackup: false,
      preflightAlreadyRun: true,
      mode: 'refresh',
      onStep: emit,
    });
    expect(mock.spawn).not.toHaveBeenCalled();
    // Never "done": the script is still running, and claiming completion is
    // what let the Git tab clear its progress row mid-update.
    expect(emit).not.toHaveBeenCalledWith('app-update', 'done', expect.anything());
    expect(emit).toHaveBeenCalledWith(
      'app-update', 'running', 'PortOS update running — this process restarts as part of it',
    );
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

  it('surfaces a refused PortOS update instead of reporting success', async () => {
    // Only the LAUNCH is awaited, so the failures this path can still report
    // are the launcher's own refusals (preflight, the lock, a spawn that never
    // started) — not a step the script failed at after the process was gone.
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 1\n');
    await writeFile(join(repo, 'update.ps1'), 'exit 1\n');
    mock.startPortosSelfUpdate.mockRejectedValue(new Error('1 CoS agent is running'));

    await expect(updateApp({
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server'],
    }, vi.fn())).rejects.toThrow('1 CoS agent is running');
  });

  it('propagates the shared launcher\'s "already in progress" refusal', async () => {
    // The atomic lock now lives in the launcher, shared with
    // POST /api/update/execute — the two entry points into update.sh must not
    // launch it concurrently, and this path must not swallow that refusal.
    await writeFile(join(repo, 'update.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(repo, 'update.ps1'), 'exit 0\n');
    mock.startPortosSelfUpdate.mockRejectedValue(new Error('Update already in progress'));

    await expect(updateApp({
      id: 'portos-default',
      name: 'PortOS',
      type: 'express',
      repoPath: repo,
      pm2ProcessNames: ['portos-server'],
    }, vi.fn())).rejects.toThrow(/already in progress/i);
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

    expect(mock.startPortosSelfUpdate).toHaveBeenCalled();
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

    expect(mock.startPortosSelfUpdate).not.toHaveBeenCalled();
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

    expect(mock.startPortosSelfUpdate).not.toHaveBeenCalled();
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

    expect(mock.startPortosSelfUpdate).not.toHaveBeenCalled();
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
