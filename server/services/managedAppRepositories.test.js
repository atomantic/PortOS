import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  pathExists: vi.fn(),
  getOriginInfo: vi.fn(),
  readRemoteUrl: vi.fn(),
  execGit: vi.fn(),
  fetchOrigin: vi.fn(),
  isFetchFresh: vi.fn(),
  resolveForgeForRepo: vi.fn(),
  execGh: vi.fn(),
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  pathExists: mock.pathExists,
}));
vi.mock('../lib/gitRemote.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getOriginInfo: mock.getOriginInfo,
  readRemoteUrl: mock.readRemoteUrl,
}));
vi.mock('./git.js', () => ({
  execGitSafe: mock.execGit,
  fetchOrigin: mock.fetchOrigin,
  isFetchFresh: mock.isFetchFresh,
  resolveForgeForRepo: mock.resolveForgeForRepo,
}));
vi.mock('./github.js', () => ({ execGh: mock.execGh }));

import {
  getManagedAppRepositorySources,
  resolveManagedAppIssueTarget,
  resolveRepositoryTopology,
  syncManagedAppFork,
} from './managedAppRepositories.js';

const REPO = '/example/app';
const app = { id: 'app-example', name: 'Example App', repoPath: REPO, pm2ProcessNames: ['example-app'] };
const forkOrigin = {
  hasOrigin: true,
  originUrl: 'git@github.com:example-owner/example-app.git',
  host: 'github.com',
  owner: 'example-owner',
  repo: 'example-app',
  fullName: 'example-owner/example-app',
  isGithub: true,
  isFork: false,
  isUpstream: false,
};

describe('managed app repository topology', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.pathExists.mockResolvedValue(true);
    mock.getOriginInfo.mockResolvedValue(forkOrigin);
    mock.readRemoteUrl.mockResolvedValue(null);
    mock.fetchOrigin.mockResolvedValue(true);
    mock.isFetchFresh.mockReturnValue(false);
    mock.resolveForgeForRepo.mockResolvedValue({ env: { GH_TOKEN: 'test-token' } });
    mock.execGh.mockImplementation(async (args) => {
      if (args[1] === 'repos/example-owner/example-app') {
        return JSON.stringify({
          fullName: 'example-owner/example-app',
          defaultBranch: 'main',
          isFork: true,
          parentFullName: 'example-org/example-app',
          parentDefaultBranch: 'main',
          sourceFullName: 'example-org/example-app',
          sourceDefaultBranch: 'main',
        });
      }
      if (String(args[1]).includes('/compare/')) {
        return JSON.stringify({ status: 'behind', ahead: 0, behind: 2 });
      }
      return 'Synced the main branch';
    });
    mock.execGit.mockImplementation(async (args) => {
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-list') return { stdout: '0\t1\n', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: 'main\n', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { stdout: `${'2'.repeat(40)}\n`, stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${'1'.repeat(40)}\n`, stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 1 };
    });
  });

  it('discovers a canonical upstream from GitHub fork metadata without app-specific constants', async () => {
    const topology = await resolveRepositoryTopology(REPO);

    expect(topology).toMatchObject({
      isFork: true,
      origin: { fullName: 'example-owner/example-app', isFork: true, isUpstream: false },
      upstream: { fullName: 'example-org/example-app', branch: 'main' },
    });
    expect(mock.execGh).toHaveBeenCalledWith(
      expect.arrayContaining(['api', 'repos/example-owner/example-app']),
      60000,
      expect.objectContaining({ cwd: REPO }),
    );
  });

  it('reports sanitized source state and defaults issue filing to upstream', async () => {
    const result = await getManagedAppRepositorySources(app);

    expect(result).toMatchObject({
      kind: 'managed-app',
      updateAvailable: true,
      updatePullsAll: true,
      issueTargets: {
        default: 'upstream',
        canChoose: true,
        origin: { fullName: 'example-owner/example-app', role: 'origin' },
        upstream: { fullName: 'example-org/example-app', role: 'upstream' },
      },
      sources: [{
        id: 'primary',
        branch: 'main',
        localVsOrigin: { ahead: 0, behind: 1, state: 'behind' },
        forkVsUpstream: { ahead: 0, behind: 2, state: 'behind' },
      }],
    });
    expect(mock.execGh).toHaveBeenCalledWith(
      [
        'api',
        'repos/example-org/example-app/compare/example-org%3Amain...example-owner%3Amain',
        '--jq',
        '{status: .status, ahead: .ahead_by, behind: .behind_by}',
      ],
      60000,
      expect.objectContaining({ cwd: REPO }),
    );
    expect(JSON.stringify(result)).not.toContain(REPO);
    expect(mock.fetchOrigin).toHaveBeenCalledWith(REPO);
  });

  // The Eidoverse page runs this read on every visit, so an ungated fetch would
  // be a network hop per mount for refs that were just refreshed.
  it('skips the network fetch for refs already refreshed inside the freshness window', async () => {
    mock.isFetchFresh.mockReturnValue(true);

    const result = await getManagedAppRepositorySources(app);

    expect(mock.fetchOrigin).not.toHaveBeenCalled();
    expect(result.sources[0]).toMatchObject({ remoteFresh: true, remoteError: null });
    expect(result.updateAvailable).toBe(true);
  });

  // Cloning someone else's fork of a third project is normal — Eidoverse's video
  // checkout is `anima-research`'s fork of the canonical repo. PortOS can read
  // that fork but never push to it, so its drift from upstream is not an update
  // PortOS can offer, and claiming otherwise raises an advisory that no button
  // clears (#6321).
  it('does not call a fork it cannot push to an available update', async () => {
    mock.execGh.mockImplementation(async (args) => {
      if (args[1] === 'repos/example-owner/example-app') {
        return JSON.stringify({
          fullName: 'example-owner/example-app',
          defaultBranch: 'main',
          isFork: true,
          canPush: false,
          sourceFullName: 'example-org/example-app',
          sourceDefaultBranch: 'main',
        });
      }
      if (String(args[1]).includes('/compare/')) return JSON.stringify({ status: 'behind', ahead: 0, behind: 12 });
      return '';
    });
    // The checkout itself is level with its origin; only the fork is behind.
    mock.execGit.mockImplementation(async (args) => {
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-list') return { stdout: '0\t0\n', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: 'main\n', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse') return { stdout: `${'1'.repeat(40)}\n`, stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 1 };
    });

    const result = await getManagedAppRepositorySources(app);

    // The drift stays reported — it is true, and the Git tab shows it.
    expect(result.sources[0]).toMatchObject({
      forkSyncable: false,
      origin: { canPush: false, isFork: true },
      forkVsUpstream: { behind: 12, state: 'behind' },
    });
    expect(result.updateAvailable).toBe(false);
    await expect(syncManagedAppFork(app)).rejects.toMatchObject({ code: 'FORK_NOT_WRITABLE', status: 403 });
  });

  // `syncManagedAppFork` only ever touches `app.repoPath`, so a companion's fork
  // has no sync path at all — and pulling that companion from its own origin
  // cannot move it past what the fork already has.
  it('does not call a companion checkout fork behind upstream an available update', async () => {
    const withCompanion = { ...app, companionRepoPaths: ['/example/companion'] };
    mock.execGit.mockImplementation(async (args) => {
      if (args[0] === 'status') return { stdout: '', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-list') return { stdout: '0\t0\n', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: 'main\n', stderr: '', exitCode: 0 };
      if (args[0] === 'rev-parse') return { stdout: `${'1'.repeat(40)}\n`, stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 1 };
    });
    // The companion is a checkout of someone else's fork, behind its upstream.
    mock.getOriginInfo.mockImplementation(async (repoPath) => (repoPath === '/example/companion'
      ? { ...forkOrigin, owner: 'other-owner', repo: 'companion', fullName: 'other-owner/companion', originUrl: 'git@github.com:other-owner/companion.git' }
      : forkOrigin));
    mock.execGh.mockImplementation(async (args) => {
      if (args[1] === 'repos/other-owner/companion') {
        return JSON.stringify({
          fullName: 'other-owner/companion',
          defaultBranch: 'main',
          isFork: true,
          canPush: true,
          sourceFullName: 'example-org/companion',
          sourceDefaultBranch: 'main',
        });
      }
      if (args[1] === 'repos/example-owner/example-app') {
        return JSON.stringify({ fullName: 'example-owner/example-app', defaultBranch: 'main', isFork: false, canPush: true });
      }
      if (String(args[1]).includes('/compare/')) return JSON.stringify({ status: 'behind', ahead: 0, behind: 12 });
      return '';
    });

    const result = await getManagedAppRepositorySources(withCompanion);

    expect(result.sources[1]).toMatchObject({
      id: 'companion-1',
      forkSyncable: false,
      forkVsUpstream: { behind: 12, state: 'behind' },
    });
    expect(result.updateAvailable).toBe(false);
  });

  it('resolves upstream by default while honoring an explicit origin choice', async () => {
    await expect(resolveManagedAppIssueTarget(app)).resolves.toMatchObject({
      role: 'upstream',
      repoSpec: 'github.com/example-org/example-app',
    });
    await expect(resolveManagedAppIssueTarget(app, 'origin')).resolves.toMatchObject({
      role: 'origin',
      repoSpec: 'github.com/example-owner/example-app',
    });
  });

  it('syncs a fork from its detected upstream without force', async () => {
    const result = await syncManagedAppFork(app);
    const syncArgs = mock.execGh.mock.calls.at(-1)[0];

    expect(syncArgs).toEqual([
      'repo', 'sync', 'example-owner/example-app',
      '--source', 'example-org/example-app', '--branch', 'main',
    ]);
    expect(syncArgs).not.toContain('--force');
    expect(result).toMatchObject({ fullName: 'example-owner/example-app', source: 'example-org/example-app' });
  });

  it('uses an explicit upstream remote when forge metadata is unavailable', async () => {
    mock.execGh.mockResolvedValue(null);
    mock.readRemoteUrl.mockResolvedValue('git@github.com:example-org/example-app.git');

    await expect(resolveRepositoryTopology(REPO)).resolves.toMatchObject({
      isFork: true,
      upstream: { fullName: 'example-org/example-app' },
    });
  });

  it('keeps successful forge metadata authoritative over an unrelated upstream remote', async () => {
    mock.readRemoteUrl.mockResolvedValue('git@github.com:example-org/example-app.git');
    mock.execGh.mockResolvedValue(JSON.stringify({
      fullName: 'example-owner/example-app',
      defaultBranch: 'trunk',
      isFork: false,
      parentFullName: null,
      sourceFullName: null,
    }));

    await expect(resolveRepositoryTopology(REPO)).resolves.toMatchObject({
      isFork: false,
      origin: { isUpstream: true },
      upstream: { fullName: 'example-owner/example-app', branch: 'trunk' },
    });
  });

  it('targets the origin GitHub host when syncing an enterprise fork', async () => {
    mock.getOriginInfo.mockResolvedValue({
      ...forkOrigin,
      originUrl: 'git@github.example.com:example-owner/example-app.git',
      host: 'github.example.com',
    });
    mock.execGh.mockImplementation(async (args) => {
      if (args.includes('repos/example-owner/example-app')) {
        return JSON.stringify({
          fullName: 'example-owner/example-app',
          defaultBranch: 'main',
          isFork: true,
          parentFullName: 'example-org/example-app',
          parentDefaultBranch: 'main',
          sourceFullName: 'example-org/example-app',
          sourceDefaultBranch: 'main',
        });
      }
      return 'Synced the main branch';
    });

    await syncManagedAppFork(app);

    expect(mock.execGh.mock.calls[0][0]).toEqual(expect.arrayContaining([
      'api', '--hostname', 'github.example.com', 'repos/example-owner/example-app',
    ]));
    expect(mock.execGh.mock.calls.at(-1)[2].env).toMatchObject({ GH_HOST: 'github.example.com' });
  });

  it('preserves upstream intent when canonical discovery is temporarily unavailable', async () => {
    mock.execGh.mockResolvedValue(null);
    mock.readRemoteUrl.mockResolvedValue(null);

    const result = await getManagedAppRepositorySources(app);

    expect(result.issueTargets).toMatchObject({ default: 'upstream', canChoose: false });
    await expect(resolveManagedAppIssueTarget(app)).resolves.toBeNull();
    await expect(resolveManagedAppIssueTarget(app, 'origin')).resolves.toMatchObject({
      role: 'origin',
      fullName: 'example-owner/example-app',
    });
    await expect(syncManagedAppFork(app)).rejects.toMatchObject({
      status: 502,
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
});
