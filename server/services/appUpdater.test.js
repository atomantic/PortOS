import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mock = vi.hoisted(() => ({
  pull: vi.fn(),
  spawn: vi.fn(),
  restart: vi.fn(),
}));

vi.mock('./git.js', () => ({ pull: mock.pull }));
vi.mock('./pm2.js', () => ({ restartApp: mock.restart }));
vi.mock('../lib/bufferedSpawn.js', () => ({ bufferedSpawnOrThrow: mock.spawn }));

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
    mock.restart.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('uses Bun and its frozen lockfile for Bun-managed apps', async () => {
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
    expect(mock.spawn).not.toHaveBeenCalledWith('npm', expect.anything(), expect.anything());
    expect(emit).toHaveBeenCalledWith('git-pull:companion-1', 'done', 'Already up to date');
    expect(emit).toHaveBeenCalledWith('bun-install:root', 'done', 'root dependencies installed');
  });
});
