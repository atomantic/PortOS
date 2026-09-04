import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  spawn: vi.fn(),
  readJSONFile: vi.fn(),
  atomicWrite: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({ secrets: { EXAMPLE_SECRET: 'fake-value' } })),
  updateSettings: vi.fn(async () => ({})),
}));

vi.mock('../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: mock.spawn };
});

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readJSONFile: mock.readJSONFile,
    atomicWrite: mock.atomicWrite,
    ensureDir: vi.fn(async () => {}),
  };
});

vi.mock('./settings.js', () => {
  return {
    getSettings: mock.getSettings,
    updateSettings: mock.updateSettings,
  };
});

import { spawn } from '../lib/childProcess.js';
import {
  __resetGitHubDataCache,
  execGh,
  getGitHubAuthStatus,
  getPullRequestState,
  setRepoArchived,
  setSecret,
  syncRepos,
  syncSecretToRepos,
  updateRepoFlags,
} from './github.js';

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = vi.fn();
  child.stdin.end = vi.fn();
  child.kill = vi.fn();
  return child;
};

describe('execGh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a timeout error and kills the child when it never closes', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'slow'], 50);
    // Suppress unhandled-rejection noise until we await below.
    promise.catch(() => {});
    vi.advanceTimersByTime(50);
    await expect(promise).rejects.toThrow(/timed out after 50ms/);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('resolves with trimmed stdout on a successful close', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'repos'], 5000);
    child.stdout.emit('data', Buffer.from('  {"ok":true}  \n'));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('{"ok":true}');
  });

  it('writes a supplied JSON body to stdin for gh api --input calls', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', '--input', '-', 'repos/o/r/pulls/1/reviews'], 5000, {
      input: '{"event":"APPROVE"}'
    });
    expect(child.stdin.end).toHaveBeenCalledWith('{"event":"APPROVE"}');
    child.emit('close', 0);
    await expect(promise).resolves.toBe('');
  });

  it('preserves gh stderr when an input write ends with EPIPE', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', '--input', '-', 'repos/o/r/pulls/1/reviews'], 5000, {
      input: '{"event":"APPROVE"}'
    });
    child.stderr.emit('data', Buffer.from('HTTP 422: validation failed'));
    const error = new Error('write EPIPE');
    error.code = 'EPIPE';
    child.stdin.emit('error', error);
    child.emit('close', 1);
    await expect(promise).rejects.toThrow('HTTP 422: validation failed');
  });

  it('rejects with stderr on a non-zero close', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'bad'], 5000);
    child.stderr.emit('data', Buffer.from('not found'));
    child.emit('close', 1);
    await expect(promise).rejects.toThrow(/not found/);
  });

  it('falls back to a generic error message when stderr is empty on non-zero close', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'bad'], 5000);
    child.emit('close', 7);
    await expect(promise).rejects.toThrow(/gh exited with code 7/);
  });

  it('does not fire the timeout timer on a fast normal completion', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'fast'], 5000);
    child.stdout.emit('data', Buffer.from('done'));
    child.emit('close', 0);
    await expect(promise).resolves.toBe('done');
    // Advancing well past the timeout must not reject/kill after settling.
    vi.advanceTimersByTime(10000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('rejects on a child spawn error', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = execGh(['api', 'x'], 5000);
    child.emit('error', new Error('spawn gh ENOENT'));
    await expect(promise).rejects.toThrow(/ENOENT/);
  });

  it('reports a timed-out account check as unreachable rather than signed out', async () => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = getGitHubAuthStatus();
    vi.advanceTimersByTime(10000);

    await expect(promise).resolves.toMatchObject({
      authenticated: false,
      status: 'unreachable',
    });
  });
});

// The merge-follow-up reaper turns "the forge says this PR is OPEN" into a
// needs-manual-finish failure and "we could not ask" into leave-prior-behavior-
// alone, so collapsing those two answers is the whole hazard this shape exists
// to prevent (same discipline as findPullRequestForBranch, #3358).
describe('getPullRequestState', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const run = (prRef, drive) => {
    const child = makeChild();
    spawn.mockReturnValue(child);
    const promise = getPullRequestState(prRef);
    drive(child);
    return promise;
  };

  it('reports a known MERGED state, upper-cased', async () => {
    await expect(run('https://example.test/o/r/pull/7', (c) => {
      c.stdout.emit('data', Buffer.from('{"state":"merged"}'));
      c.emit('close', 0);
    })).resolves.toEqual({ status: 'known', state: 'MERGED', detail: null });
  });

  it('reports a known OPEN state rather than collapsing it into "not merged"', async () => {
    const res = await run('7', (c) => {
      c.stdout.emit('data', Buffer.from('{"state":"OPEN"}'));
      c.emit('close', 0);
    });
    expect(res).toEqual({ status: 'known', state: 'OPEN', detail: null });
  });

  it('passes the PR reference straight to `gh pr view --json state`', async () => {
    await run('https://example.test/o/r/pull/7', (c) => {
      c.stdout.emit('data', Buffer.from('{"state":"MERGED"}'));
      c.emit('close', 0);
    });
    expect(spawn).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'https://example.test/o/r/pull/7', '--json', 'state'],
      expect.anything()
    );
  });

  it('reports unavailable — NOT a state — when gh fails (the firewalled-gh case)', async () => {
    const res = await run('7', (c) => {
      c.stderr.emit('data', Buffer.from('dial tcp: connect: bad file descriptor'));
      c.emit('close', 1);
    });
    expect(res.status).toBe('unavailable');
    expect(res.state).toBeNull();
    expect(res.detail).toMatch(/bad file descriptor/);
  });

  it('reports unavailable when a zero-exit gh emits nothing parseable', async () => {
    const res = await run('7', (c) => {
      c.stdout.emit('data', Buffer.from('not json'));
      c.emit('close', 0);
    });
    expect(res).toEqual({ status: 'unavailable', state: null, detail: 'gh returned unparseable output' });
  });

  it('reports unavailable without shelling out when given no reference', async () => {
    await expect(getPullRequestState('')).resolves.toEqual({ status: 'unavailable', state: null, detail: 'no PR reference' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

const childReturning = (stdout) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = vi.fn();
  child.stdin.end = vi.fn();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
};

const childFailing = (stderr) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = vi.fn();
  child.stdin.end = vi.fn();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', 1);
  });
  return child;
};

const hangingChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = vi.fn();
  child.stdin.end = vi.fn();
  child.kill = vi.fn();
  return child;
};

describe('GitHub repository sync account selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.spawn.mockReset();
    mock.atomicWrite.mockReset();
    mock.atomicWrite.mockResolvedValue(undefined);
    __resetGitHubDataCache();
    mock.readJSONFile.mockResolvedValue({
      repos: { 'legacy-owner/old-repo': { fullName: 'legacy-owner/old-repo' } },
      secrets: {},
      lastRepoSync: null,
      githubUser: 'legacy-owner',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('targets github.com explicitly and reports when an environment token is in control', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.spawn.mockImplementation(() => childReturning('example-user'));

    await expect(getGitHubAuthStatus()).resolves.toMatchObject({
      authenticated: true,
      login: 'example-user',
      credentialSource: 'env',
    });
    expect(mock.spawn.mock.calls[0][1]).toEqual([
      'api', 'user', '--hostname', 'github.com', '--jq', '.login',
    ]);
  });

  it('redacts command arguments from timeout errors and kill-failure logs', async () => {
    vi.useFakeTimers();
    const child = hangingChild();
    child.kill.mockImplementation(() => { throw new Error('simulated kill failure'); });
    mock.spawn.mockReturnValue(child);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = execGh(['repo', 'list', 'private-account-name'], 10).catch(error => error);
    await vi.advanceTimersByTimeAsync(10);
    const error = await result;

    expect(error.message).toBe('gh command timed out after 10ms');
    expect(error.message).not.toContain('private-account-name');
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('failed to kill timed-out gh command'));
    expect(errorLog.mock.calls.flat().join(' ')).not.toContain('private-account-name');
    errorLog.mockRestore();
    vi.useRealTimers();
  });

  it('gives an environment-specific remedy when GitHub rejects an overriding token', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-rejected-token');
    mock.spawn.mockImplementation(() => childFailing('HTTP 401: Bad credentials'));

    await expect(getGitHubAuthStatus()).resolves.toMatchObject({
      authenticated: false,
      status: 'not-authenticated',
      credentialSource: 'env',
      remedy: expect.stringMatching(/update or remove.*environment credential/i),
    });
  });

  it('refuses to sync cached owner data when gh is not authenticated', async () => {
    mock.spawn.mockImplementation(() => childFailing('You are not logged in. Run gh auth login.'));

    await expect(syncRepos()).rejects.toMatchObject({
      status: 401,
      code: 'GITHUB_NOT_AUTHENTICATED',
    });
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    expect(mock.spawn.mock.calls[0][1]).toEqual([
      'api', 'user', '--hostname', 'github.com', '--jq', '.login',
    ]);
  });

  it('syncs the active gh account instead of the stored legacy owner', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.spawn.mockImplementation((_command, args) => (
      args[0] === 'api' ? childReturning('example-user') : childReturning('[]')
    ));

    const result = await syncRepos();

    expect(mock.spawn).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['api', 'user', '--hostname', 'github.com', '--jq', '.login'],
      expect.anything(),
    );
    expect(mock.spawn).toHaveBeenNthCalledWith(
      2,
      'gh',
      expect.arrayContaining(['repo', 'list', 'example-user']),
      expect.anything(),
    );
    expect(mock.spawn.mock.calls[1][1]).not.toContain('legacy-owner');
    expect(mock.spawn.mock.calls[1][2].env.GH_HOST).toBe('github.com');
    expect(result.githubUser).toBe('example-user');
    expect(result.repos).toEqual({});
  });

  it('pins a CLI account token into repository listing commands', async () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    mock.spawn.mockImplementation((_command, args) => {
      if (args[0] === 'api') return childReturning('example-user');
      if (args[0] === 'auth') return childReturning('fake-pinned-token');
      return childReturning('[]');
    });

    await syncRepos();

    expect(mock.spawn.mock.calls[1][1]).toEqual([
      'auth', 'token', '--user', 'example-user', '--hostname', 'github.com',
    ]);
    expect(mock.spawn.mock.calls[2][2].env).toMatchObject({
      GH_HOST: 'github.com',
      GH_TOKEN: 'fake-pinned-token',
    });
    expect(mock.spawn.mock.calls[2][2].env.GITHUB_TOKEN).toBeUndefined();
  });

  it('falls back to the unqualified token command on a gh build without --user', async () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    mock.spawn.mockImplementation((_command, args) => {
      if (args[0] === 'api') return childReturning('example-user');
      // Older gh: `auth token --user <login>` fails, but the unqualified form
      // (single active account) still resolves.
      if (args.includes('--user')) return childFailing('unknown flag: --user');
      if (args[0] === 'auth') return childReturning('fake-pinned-token');
      return childReturning('[]');
    });

    await syncRepos();

    expect(mock.spawn.mock.calls[2][1]).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(mock.spawn.mock.calls[3][2].env).toMatchObject({
      GH_HOST: 'github.com',
      GH_TOKEN: 'fake-pinned-token',
    });
  });

  it('refuses to push secrets while cached repositories belong to another account', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.readJSONFile.mockResolvedValue({
      repos: {
        'legacy-owner/old-repo': {
          fullName: 'legacy-owner/old-repo',
          managedSecrets: ['EXAMPLE_SECRET'],
          isArchived: false,
        },
      },
      secrets: { EXAMPLE_SECRET: { hasValue: true } },
      lastRepoSync: null,
      githubUser: 'legacy-owner',
    });
    mock.spawn.mockImplementation(() => childReturning('example-user'));

    await expect(syncSecretToRepos('EXAMPLE_SECRET')).rejects.toMatchObject({
      status: 409,
      code: 'GITHUB_ACCOUNT_MISMATCH',
    });
    expect(mock.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not store a secret when its automatic sync would target another account cache', async () => {
    mock.spawn.mockImplementation(() => childReturning('example-user'));

    await expect(setSecret('EXAMPLE_SECRET', 'replacement-fake-value')).rejects.toMatchObject({
      status: 409,
      code: 'GITHUB_ACCOUNT_MISMATCH',
    });
    expect(mock.updateSettings).not.toHaveBeenCalled();
    expect(mock.atomicWrite).not.toHaveBeenCalled();
  });

  it('refuses to archive a cached repository owned by another account', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.spawn.mockImplementation(() => childReturning('example-user'));

    await expect(setRepoArchived('legacy-owner/old-repo', true)).rejects.toMatchObject({
      status: 409,
      code: 'GITHUB_ACCOUNT_MISMATCH',
    });
    expect(mock.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses to update flags on a cached repository owned by another account', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.spawn.mockImplementation(() => childReturning('example-user'));

    await expect(updateRepoFlags('legacy-owner/old-repo', { flags: { npmProject: true } })).rejects.toMatchObject({
      status: 409,
      code: 'GITHUB_ACCOUNT_MISMATCH',
    });
  });

  it('refuses to update flags while gh is not authenticated', async () => {
    mock.spawn.mockImplementation(() => childFailing('You are not logged in. Run gh auth login.'));

    await expect(updateRepoFlags('legacy-owner/old-repo', { flags: { npmProject: true } })).rejects.toMatchObject({
      status: 401,
      code: 'GITHUB_NOT_AUTHENTICATED',
    });
  });

  it('refuses to archive a repository that is not in the authenticated account cache', async () => {
    mock.readJSONFile.mockResolvedValue({
      repos: {},
      secrets: {},
      lastRepoSync: null,
      githubUser: 'example-user',
    });
    mock.spawn.mockImplementation(() => childReturning('example-user'));

    await expect(setRepoArchived('another-owner/unknown-repo', true)).rejects.toMatchObject({
      status: 404,
      code: 'REPO_NOT_FOUND',
    });
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it('archives a cached repository when the active account matches', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.readJSONFile.mockResolvedValue({
      repos: {
        'example-user/example-repo': {
          name: 'example-repo',
          fullName: 'example-user/example-repo',
          isArchived: false,
          flags: {},
          managedSecrets: [],
        },
      },
      secrets: {},
      lastRepoSync: null,
      githubUser: 'example-user',
    });
    mock.spawn.mockImplementation(() => childReturning('example-user'));

    await expect(setRepoArchived('example-user/example-repo', true)).resolves.toMatchObject({
      fullName: 'example-user/example-repo',
      isArchived: true,
    });
    expect(mock.spawn.mock.calls[1][1]).toEqual([
      'repo', 'archive', 'example-user/example-repo', '--yes',
    ]);
    expect(mock.spawn.mock.calls[1][2].env.GH_HOST).toBe('github.com');
  });

  it('pushes a secret only when the active account matches the repository cache', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.readJSONFile.mockResolvedValue({
      repos: {
        'example-user/example-repo': {
          name: 'example-repo',
          fullName: 'example-user/example-repo',
          isArchived: false,
          flags: {},
          managedSecrets: ['EXAMPLE_SECRET'],
        },
      },
      secrets: { EXAMPLE_SECRET: { hasValue: true } },
      lastRepoSync: null,
      githubUser: 'example-user',
    });
    mock.spawn.mockImplementation(() => childReturning('example-user'));

    await expect(syncSecretToRepos('EXAMPLE_SECRET')).resolves.toMatchObject({
      synced: 1,
      failed: 0,
    });
    expect(mock.spawn.mock.calls[1][1]).toEqual([
      'secret', 'set', 'EXAMPLE_SECRET', '--repo', 'example-user/example-repo',
    ]);
    expect(mock.spawn.mock.calls[1][2].env.GH_HOST).toBe('github.com');
    expect(mock.spawn.mock.calls[1][2].env.GH_TOKEN).toBe('fake-example-token');
  });

  it('bounds a hung secret push and releases later GitHub mutations', async () => {
    vi.useFakeTimers();
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.readJSONFile.mockResolvedValue({
      repos: {
        'example-user/example-repo': {
          name: 'example-repo',
          fullName: 'example-user/example-repo',
          isArchived: false,
          flags: {},
          managedSecrets: ['EXAMPLE_SECRET'],
        },
      },
      secrets: { EXAMPLE_SECRET: { hasValue: true } },
      lastRepoSync: null,
      githubUser: 'example-user',
    });
    mock.spawn.mockImplementation((_command, args) => (
      args[0] === 'secret' ? hangingChild() : childReturning('example-user')
    ));

    const secretSync = syncSecretToRepos('EXAMPLE_SECRET');
    await vi.advanceTimersByTimeAsync(60000);
    await expect(secretSync).resolves.toMatchObject({ synced: 0, failed: 1 });

    const flagsUpdate = updateRepoFlags('example-user/example-repo', { flags: { npmProject: true } });
    await expect(flagsUpdate).resolves.toMatchObject({ flags: { npmProject: true } });
    vi.useRealTimers();
  });

  const listedRepos = (count) => Array.from({ length: count }, (_, index) => ({
    name: `repo-${index}`,
    nameWithOwner: `example-user/repo-${index}`,
    description: '',
    pushedAt: null,
    isArchived: false,
    isPrivate: false,
    isFork: false,
    parent: null,
    licenseInfo: null,
  }));

  it('does not delete cached repositories when the GitHub listing is actually truncated', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.readJSONFile.mockResolvedValue({
      repos: {
        'example-user/keep-me': {
          name: 'keep-me',
          fullName: 'example-user/keep-me',
          flags: {},
          managedSecrets: [],
        },
      },
      secrets: {},
      lastRepoSync: null,
      githubUser: 'example-user',
    });
    // The service now asks for REPO_SYNC_LIMIT + 1 so the extra row IS the
    // truncation signal — 201 here, not 200.
    const listed = listedRepos(201);
    mock.spawn.mockImplementation((_command, args) => (
      args[0] === 'api' ? childReturning('example-user') : childReturning(JSON.stringify(listed))
    ));

    const result = await syncRepos();

    expect(result.truncated).toBe(true);
    expect(result.repos['example-user/keep-me']).toBeTruthy();
    expect(Object.keys(result.repos)).toHaveLength(201); // 200 listed + 1 preserved
  });

  it('does not treat exactly REPO_SYNC_LIMIT repos as truncated', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.readJSONFile.mockResolvedValue({
      repos: {
        'example-user/deleted-on-github': {
          name: 'deleted-on-github',
          fullName: 'example-user/deleted-on-github',
          flags: {},
          managedSecrets: [],
        },
      },
      secrets: {},
      lastRepoSync: null,
      githubUser: 'example-user',
    });
    const listed = listedRepos(200);
    mock.spawn.mockImplementation((_command, args) => (
      args[0] === 'api' ? childReturning('example-user') : childReturning(JSON.stringify(listed))
    ));

    const result = await syncRepos();

    // Exactly 200 repos is a complete listing, not a truncated one — a repo
    // that genuinely no longer exists on GitHub is still pruned.
    expect(result.truncated).toBe(false);
    expect(result.repos['example-user/deleted-on-github']).toBeUndefined();
    expect(Object.keys(result.repos)).toHaveLength(200);
  });

  it('preserves a cached repo with configured flags or secrets when a scope-degraded credential omits it, but still prunes an unconfigured one', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.readJSONFile.mockResolvedValue({
      repos: {
        // Not returned by the (scope-limited) listing below, but carries user
        // configuration — must be preserved, not deleted, even though the
        // listing is NOT truncated.
        'example-user/private-configured': {
          name: 'private-configured',
          fullName: 'example-user/private-configured',
          flags: { npmProject: true },
          managedSecrets: ['NPM_TOKEN'],
        },
        // Also missing from the listing, but carries no configuration — a
        // real deletion (or an unconfigured repo made private by the same
        // scope loss) is still pruned rather than accumulating forever.
        'example-user/private-unconfigured': {
          name: 'private-unconfigured',
          fullName: 'example-user/private-unconfigured',
          flags: {},
          managedSecrets: [],
        },
      },
      secrets: {},
      lastRepoSync: null,
      githubUser: 'example-user',
    });
    // A credential that lost `repo` scope still exits 0 with a valid, public-
    // only, NON-truncated listing.
    mock.spawn.mockImplementation((_command, args) => (
      args[0] === 'api' ? childReturning('example-user') : childReturning('[]')
    ));

    const result = await syncRepos();

    expect(result.truncated).toBe(false);
    expect(result.repos['example-user/private-configured']).toMatchObject({
      flags: { npmProject: true },
      managedSecrets: ['NPM_TOKEN'],
    });
    expect(result.repos['example-user/private-unconfigured']).toBeUndefined();
    const persisted = JSON.parse(mock.atomicWrite.mock.calls.at(-1)[1]);
    expect(persisted.repos['example-user/private-configured'].missingFromRemote).toEqual(expect.any(String));
  });

  it('rejects an unparseable repository listing instead of throwing a bare SyntaxError', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.readJSONFile.mockResolvedValue({
      repos: {}, secrets: {}, lastRepoSync: null, githubUser: 'example-user',
    });
    mock.spawn.mockImplementation((_command, args) => (
      args[0] === 'api' ? childReturning('example-user') : childReturning('not json')
    ));

    await expect(syncRepos()).rejects.toMatchObject({
      status: 502,
      code: 'GITHUB_LISTING_UNPARSEABLE',
    });
  });

  it('preserves another account\'s repository configuration across account switches', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.readJSONFile.mockResolvedValue({
      repos: {
        'legacy-owner/configured-repo': {
          name: 'configured-repo',
          fullName: 'legacy-owner/configured-repo',
          flags: { npmProject: true },
          managedSecrets: ['NPM_TOKEN'],
          lastSecretSync: '2026-01-01T00:00:00.000Z',
        },
      },
      secrets: {},
      lastRepoSync: null,
      githubUser: 'legacy-owner',
    });
    mock.spawn.mockImplementation((_command, args) => (
      args[0] === 'api' ? childReturning('example-user') : childReturning('[]')
    ));

    const result = await syncRepos();

    expect(result.repos).toEqual({});
    const persisted = JSON.parse(mock.atomicWrite.mock.calls.at(-1)[1]);
    expect(persisted.repos['legacy-owner/configured-repo']).toMatchObject({
      flags: { npmProject: true },
      managedSecrets: ['NPM_TOKEN'],
      lastSecretSync: '2026-01-01T00:00:00.000Z',
    });
  });

  it('serializes concurrent updates to the shared repository cache', async () => {
    let releaseFirstWrite;
    vi.stubEnv('GH_TOKEN', 'fake-example-token');
    mock.readJSONFile.mockResolvedValue({
      repos: {
        'example-user/example-repo': {
          name: 'example-repo',
          fullName: 'example-user/example-repo',
          flags: {},
          managedSecrets: [],
        },
      },
      secrets: {},
      lastRepoSync: null,
      githubUser: 'example-user',
    });
    mock.spawn.mockImplementation(() => childReturning('example-user'));
    mock.atomicWrite
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirstWrite = resolve; }))
      .mockResolvedValue(undefined);

    const first = updateRepoFlags('example-user/example-repo', { flags: { npmProject: true } });
    const second = updateRepoFlags('example-user/example-repo', { managedSecrets: ['EXAMPLE_SECRET'] });

    await vi.waitFor(() => expect(mock.atomicWrite).toHaveBeenCalledTimes(1));
    releaseFirstWrite();
    await Promise.all([first, second]);

    const persisted = JSON.parse(mock.atomicWrite.mock.calls[1][1]);
    expect(persisted.repos['example-user/example-repo']).toMatchObject({
      flags: { npmProject: true },
      managedSecrets: ['EXAMPLE_SECRET'],
    });
  });
});
