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

  it('never removes the destination for an ordinary clone', async () => {
    // `replaceIncomplete` is the ONLY thing licensed to delete a checkout the
    // user may already be using; a plain clone must stage and rename instead.
    const child = createChild();
    spawn.mockReturnValue(child);

    const resultPromise = cloneRepo('https://github.com/acme/widgets');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.emit('close', 0);
    await resultPromise;

    expect(rm).not.toHaveBeenCalledWith('/repos/acme/widgets', expect.anything());
  });

  it('discards staging and surfaces the git error when the clone fails', async () => {
    const child = createChild();
    spawn.mockReturnValue(child);

    const resultPromise = cloneRepo('https://github.com/acme/widgets');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('fatal: repository not found'));
    child.emit('close', 128);

    await expect(resultPromise).rejects.toThrow('fatal: repository not found');
    // Nothing published, and the abandoned partial checkout is gone rather than
    // left for the boot-time reaper.
    expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith(
      '/repos/acme/.widgets-cloning-attempt',
      { recursive: true, force: true }
    );
  });

  it('keeps a checkout a concurrent attempt already published', async () => {
    const child = createChild();
    spawn.mockReturnValue(child);

    const resultPromise = cloneRepo('https://github.com/acme/widgets');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    // The rival attempt won while git was running.
    existsSync.mockReturnValue(true);
    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({
      localPath: '/repos/acme/widgets',
      alreadyCloned: true
    });
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('reapStaleCloneStaging', () => {
  const directory = name => ({ name, isDirectory: () => true });

  beforeEach(() => {
    vi.clearAllMocks();
    rm.mockResolvedValue();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('reaps only expired PortOS clone staging directories', async () => {
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

  it('reports an empty repos directory rather than throwing', async () => {
    readdir.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'ENOENT' }));

    await expect(reapStaleCloneStaging({ cloneDir: '/repos' })).resolves.toBe(0);
    expect(rm).not.toHaveBeenCalled();
  });

  it('keeps sweeping after an unreadable owner directory', async () => {
    readdir
      .mockResolvedValueOnce([directory('locked'), directory('acme')])
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      .mockResolvedValueOnce([directory('.portos-clone-1000000000000-old123')]);

    await expect(reapStaleCloneStaging({
      cloneDir: '/repos',
      now: 2000000000000
    })).resolves.toBe(1);

    expect(rm).toHaveBeenCalledWith(
      '/repos/acme/.portos-clone-1000000000000-old123',
      { recursive: true, force: true }
    );
  });
});
