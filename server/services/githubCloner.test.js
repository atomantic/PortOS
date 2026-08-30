import { beforeEach, describe, expect, it, vi } from 'vitest';
import EventEmitter from 'node:events';

vi.mock('fs', () => ({ existsSync: vi.fn() }));
vi.mock('fs/promises', () => ({
  mkdtemp: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('../lib/childProcess.js', () => ({ spawn: vi.fn() }));
vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(),
  PATHS: { repos: '/repos' },
}));

import { existsSync } from 'fs';
import { mkdtemp, readdir, rename, rm } from 'fs/promises';
import { spawn } from '../lib/childProcess.js';
import { cloneRepo, reapStaleCloneStaging } from './githubCloner.js';

const createChild = () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('cloneRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSync.mockImplementation(path => !String(path).endsWith('.git'));
    mkdtemp.mockResolvedValue('/repos/acme/.widgets-cloning-attempt');
    readdir.mockResolvedValue([]);
    rename.mockResolvedValue();
    rm.mockResolvedValue();
  });

  it('publishes a clone only after git completes in attempt-specific staging', async () => {
    const child = createChild();
    spawn.mockReturnValue(child);

    const resultPromise = cloneRepo('https://github.com/acme/widgets');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

    expect(spawn).toHaveBeenCalledWith('git', [
      'clone', '--depth', '1', '--single-branch',
      'https://github.com/acme/widgets.git',
      '/repos/acme/.widgets-cloning-attempt/widgets'
    ], expect.objectContaining({ shell: false }));
    expect(rename).not.toHaveBeenCalled();

    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({
      localPath: '/repos/acme/widgets',
      alreadyCloned: false
    });
    expect(rename).toHaveBeenCalledWith(
      '/repos/acme/.widgets-cloning-attempt/widgets',
      '/repos/acme/widgets'
    );
    expect(rm).toHaveBeenCalledWith(
      '/repos/acme/.widgets-cloning-attempt',
      { recursive: true, force: true }
    );
  });

  it('removes a legacy partial destination only for a recovered attempt', async () => {
    const child = createChild();
    spawn.mockReturnValue(child);

    const resultPromise = cloneRepo('https://github.com/acme/widgets', { replaceIncomplete: true });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

    expect(rm).toHaveBeenCalledWith('/repos/acme/widgets', { recursive: true, force: true });
    child.emit('close', 0);
    await resultPromise;
  });

  it('reaps only expired PortOS clone staging directories', async () => {
    const directory = name => ({ name, isDirectory: () => true });
    readdir
      .mockResolvedValueOnce([directory('acme')])
      .mockResolvedValueOnce([
        directory('.portos-clone-1000000000000-old123'),
        directory('.portos-clone-1999999999999-new123'),
        directory('.unrelated'),
      ]);

    await expect(reapStaleCloneStaging({
      cloneDir: '/repos',
      now: 2000000000000
    })).resolves.toBe(1);

    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith(
      '/repos/acme/.portos-clone-1000000000000-old123',
      { recursive: true, force: true }
    );
  });
});
