import { beforeEach, describe, expect, it, vi } from 'vitest';
import EventEmitter from 'node:events';
import { join } from 'node:path';

vi.mock('fs', () => ({ existsSync: vi.fn() }));
vi.mock('fs/promises', () => ({
  access: vi.fn(),
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
import { access, mkdtemp, readdir, rename, rm } from 'fs/promises';
import { spawn } from '../lib/childProcess.js';
import { cloneRepo, reapStaleCloneStaging } from './repoCloner.js';

const REPOS_DIR = '/repos';
const OWNER_DIR = join(REPOS_DIR, 'acme');
const LOCAL_PATH = join(OWNER_DIR, 'widgets');
const STAGING_ROOT = join(OWNER_DIR, '.widgets-cloning-attempt');
const STAGING_PATH = join(STAGING_ROOT, 'widgets');

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
    mkdtemp.mockResolvedValue(STAGING_ROOT);
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
      STAGING_PATH
    ], expect.objectContaining({ shell: false }));
    expect(rename).not.toHaveBeenCalled();

    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({
      localPath: LOCAL_PATH,
      alreadyCloned: false
    });
    expect(rename).toHaveBeenCalledWith(
      STAGING_PATH,
      LOCAL_PATH
    );
    expect(rm).toHaveBeenCalledWith(
      STAGING_ROOT,
      { recursive: true, force: true }
    );
  });

  it('removes a legacy partial destination only for a recovered attempt', async () => {
    const child = createChild();
    spawn.mockReturnValue(child);

    const resultPromise = cloneRepo('https://github.com/acme/widgets', { replaceIncomplete: true });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

    expect(rm).toHaveBeenCalledWith(LOCAL_PATH, { recursive: true, force: true });
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

    expect(rm).not.toHaveBeenCalledWith(LOCAL_PATH, expect.anything());
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
      STAGING_ROOT,
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
      localPath: LOCAL_PATH,
      alreadyCloned: true
    });
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('reapStaleCloneStaging', () => {
  const directory = name => ({ name, isDirectory: () => true });

  // The sweep walks a TREE now (a namespaced host and a GitLab subgroup each add
  // a level), so the fixtures are a path → entries map rather than a call
  // sequence — a sequence would silently encode one particular walk order.
  const mockTree = (tree, { clones = [] } = {}) => {
    readdir.mockImplementation(async (dir) => {
      const entries = tree[String(dir)];
      if (!entries) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      if (entries instanceof Error) throw entries;
      return entries;
    });
    // A directory holding `.git` is a finished clone; the sweep must not walk in.
    access.mockImplementation(async (path) => {
      if (!clones.includes(String(path).replace(/[/\\]\.git$/, ''))) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    readdir.mockReset();
    access.mockReset();
    rm.mockResolvedValue();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('reaps only expired PortOS clone staging directories', async () => {
    mockTree({
      [REPOS_DIR]: [directory('acme')],
      [OWNER_DIR]: [
        directory('.portos-clone-1000000000000-old123'),
        directory('.portos-clone-1999999999999-new123'),
        directory('widgets'),
      ],
    }, { clones: [LOCAL_PATH] });

    await expect(reapStaleCloneStaging({
      cloneDir: REPOS_DIR,
      now: 2000000000000
    })).resolves.toBe(1);

    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith(
      join(OWNER_DIR, '.portos-clone-1000000000000-old123'),
      { recursive: true, force: true }
    );
    // The finished clone is a leaf, not another namespace level.
    expect(readdir).not.toHaveBeenCalledWith(LOCAL_PATH, expect.anything());
  });

  // The DEEPEST layout the host table allows: hostname + the full subgroup cap.
  // A hardcoded sweep bound stops one level short of this and leaks the staging
  // tree of every interrupted clone in a deeply-nested group.
  it('reaps staging nested under a namespaced host and the deepest allowed subgroup path', async () => {
    const hostDir = join(REPOS_DIR, 'gitlab.com');
    const groupDir = join(hostDir, 'example-group');
    const subgroupDir = join(groupDir, 'example-sub', 'example-sub-sub');
    mockTree({
      [REPOS_DIR]: [directory('gitlab.com')],
      [hostDir]: [directory('example-group')],
      [groupDir]: [directory('example-sub')],
      [join(groupDir, 'example-sub')]: [directory('example-sub-sub')],
      [subgroupDir]: [directory('.portos-clone-1000000000000-old123')],
    });

    await expect(reapStaleCloneStaging({
      cloneDir: REPOS_DIR,
      now: 2000000000000
    })).resolves.toBe(1);
    expect(rm).toHaveBeenCalledWith(
      join(subgroupDir, '.portos-clone-1000000000000-old123'),
      { recursive: true, force: true }
    );
  });

  it('reports an empty repos directory rather than throwing', async () => {
    mockTree({});

    await expect(reapStaleCloneStaging({ cloneDir: REPOS_DIR })).resolves.toBe(0);
    expect(rm).not.toHaveBeenCalled();
  });

  it('keeps sweeping after an unreadable owner directory', async () => {
    mockTree({
      [REPOS_DIR]: [directory('locked'), directory('acme')],
      [join(REPOS_DIR, 'locked')]: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      [OWNER_DIR]: [directory('.portos-clone-1000000000000-old123')],
    });

    await expect(reapStaleCloneStaging({
      cloneDir: REPOS_DIR,
      now: 2000000000000
    })).resolves.toBe(1);

    expect(rm).toHaveBeenCalledWith(
      join(OWNER_DIR, '.portos-clone-1000000000000-old123'),
      { recursive: true, force: true }
    );
  });
});

describe('cloneRepo across hosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readdir.mockReset();
    existsSync.mockReset();
    access.mockReset();
    existsSync.mockImplementation(path => !String(path).endsWith('.git'));
    mkdtemp.mockImplementation(async (prefix) => `${prefix}staging`);
    readdir.mockResolvedValue([]);
    rename.mockResolvedValue();
    rm.mockResolvedValue();
  });

  it('clones a gitlab.com project from its own host, under a hostname-namespaced path', async () => {
    const child = createChild();
    spawn.mockReturnValue(child);

    const resultPromise = cloneRepo('https://gitlab.com/example-group/example-sub/example-repo');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.emit('close', 0);

    const [, args] = spawn.mock.calls[0];
    expect(args).toContain('https://gitlab.com/example-group/example-sub/example-repo.git');
    await expect(resultPromise).resolves.toMatchObject({
      localPath: join(REPOS_DIR, 'gitlab.com', 'example-group', 'example-sub', 'example-repo'),
      owner: 'example-group/example-sub',
      repo: 'example-repo',
    });
  });

  it('rejects a URL on an unsupported host', async () => {
    await expect(cloneRepo('https://bitbucket.org/acme/widgets'))
      .rejects.toThrow('Invalid repository URL');
    expect(spawn).not.toHaveBeenCalled();
  });
});
