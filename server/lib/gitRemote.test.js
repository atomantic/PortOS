import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./execGit.js', () => ({
  execGit: vi.fn()
}));

vi.mock('./fileUtils.js', () => ({
  PATHS: { root: '/mock' }
}));

import { execGit } from './execGit.js';
import {
  parseGitRemoteUrl,
  getOriginInfo,
  readOriginRemoteUrl,
  UPSTREAM_OWNER,
  UPSTREAM_REPO,
  UPSTREAM_FULL_NAME
} from './gitRemote.js';

describe('parseGitRemoteUrl', () => {
  it('parses SCP-style SSH URLs', () => {
    expect(parseGitRemoteUrl('git@github.com:atomantic/PortOS.git')).toEqual({
      host: 'github.com', owner: 'atomantic', repo: 'PortOS'
    });
    expect(parseGitRemoteUrl('git@github.com:alice/my-fork')).toEqual({
      host: 'github.com', owner: 'alice', repo: 'my-fork'
    });
  });

  it('parses HTTPS URLs', () => {
    expect(parseGitRemoteUrl('https://github.com/atomantic/PortOS.git')).toEqual({
      host: 'github.com', owner: 'atomantic', repo: 'PortOS'
    });
    expect(parseGitRemoteUrl('https://github.com/alice/my-fork')).toEqual({
      host: 'github.com', owner: 'alice', repo: 'my-fork'
    });
  });

  it('parses HTTPS URLs with embedded credentials', () => {
    expect(parseGitRemoteUrl('https://user:token@github.com/alice/my-fork.git')).toEqual({
      host: 'github.com', owner: 'alice', repo: 'my-fork'
    });
  });

  it('parses ssh:// URLs', () => {
    expect(parseGitRemoteUrl('ssh://git@github.com/atomantic/PortOS.git')).toEqual({
      host: 'github.com', owner: 'atomantic', repo: 'PortOS'
    });
  });

  it('handles enterprise/non-github hosts', () => {
    expect(parseGitRemoteUrl('git@git.example.com:team/repo.git')).toEqual({
      host: 'git.example.com', owner: 'team', repo: 'repo'
    });
    expect(parseGitRemoteUrl('https://gitlab.com/group/proj.git')).toEqual({
      host: 'gitlab.com', owner: 'group', repo: 'proj'
    });
  });

  it('strips trailing slashes and .git suffix only', () => {
    expect(parseGitRemoteUrl('https://github.com/alice/PortOS/')).toEqual({
      host: 'github.com', owner: 'alice', repo: 'PortOS'
    });
    expect(parseGitRemoteUrl('https://github.com/alice/portos.git.backup')).toEqual({
      host: 'github.com', owner: 'alice', repo: 'portos.git.backup'
    });
  });

  it('returns null for invalid input', () => {
    expect(parseGitRemoteUrl('')).toBeNull();
    expect(parseGitRemoteUrl(null)).toBeNull();
    expect(parseGitRemoteUrl(undefined)).toBeNull();
    expect(parseGitRemoteUrl(123)).toBeNull();
    expect(parseGitRemoteUrl('not-a-url')).toBeNull();
  });

  it('rejects URLs with extra path segments beyond owner/repo', () => {
    // SCP-style with extra segment would otherwise produce repo="repo/extra"
    expect(parseGitRemoteUrl('git@github.com:owner/repo/extra')).toBeNull();
    expect(parseGitRemoteUrl('git@github.com:owner/repo/extra.git')).toBeNull();
    // HTTPS with extra path segment
    expect(parseGitRemoteUrl('https://github.com/owner/repo/extra')).toBeNull();
    expect(parseGitRemoteUrl('https://github.com/org/team/repo.git')).toBeNull();
    // ssh:// with extra
    expect(parseGitRemoteUrl('ssh://git@github.com/owner/repo/extra.git')).toBeNull();
  });
});

describe('readOriginRemoteUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the trimmed URL on success', async () => {
    execGit.mockResolvedValue({ stdout: 'https://github.com/atomantic/PortOS.git\n', stderr: '', exitCode: 0 });
    const url = await readOriginRemoteUrl();
    expect(url).toBe('https://github.com/atomantic/PortOS.git');
    expect(execGit).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/mock', { ignoreExitCode: true });
  });

  it('returns null when origin is missing (non-zero exit)', async () => {
    execGit.mockResolvedValue({ stdout: '', stderr: 'error: No such remote: origin', exitCode: 2 });
    const url = await readOriginRemoteUrl();
    expect(url).toBeNull();
  });

  it('returns null when stdout is empty', async () => {
    execGit.mockResolvedValue({ stdout: '   \n', stderr: '', exitCode: 0 });
    const url = await readOriginRemoteUrl();
    expect(url).toBeNull();
  });
});

describe('getOriginInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies upstream when origin == atomantic/PortOS', async () => {
    execGit.mockResolvedValue({ stdout: 'git@github.com:atomantic/PortOS.git\n', stderr: '', exitCode: 0 });
    const info = await getOriginInfo();
    expect(info).toEqual({
      hasOrigin: true,
      originUrl: 'git@github.com:atomantic/PortOS.git',
      host: 'github.com',
      owner: 'atomantic',
      repo: 'PortOS',
      fullName: 'atomantic/PortOS',
      isUpstream: true,
      isGithub: true,
      isFork: false
    });
  });

  it('is case-insensitive for upstream comparison', async () => {
    execGit.mockResolvedValue({ stdout: 'https://github.com/ATOMANTIC/portos.git\n', stderr: '', exitCode: 0 });
    const info = await getOriginInfo();
    expect(info.isUpstream).toBe(true);
    expect(info.isFork).toBe(false);
  });

  it('classifies fork when origin is another github user', async () => {
    execGit.mockResolvedValue({ stdout: 'git@github.com:alice/PortOS.git\n', stderr: '', exitCode: 0 });
    const info = await getOriginInfo();
    expect(info.isFork).toBe(true);
    expect(info.isUpstream).toBe(false);
    expect(info.fullName).toBe('alice/PortOS');
  });

  it('does not flag non-github remotes as fork even when owner/repo differ', async () => {
    execGit.mockResolvedValue({ stdout: 'git@gitlab.example.com:team/PortOS.git\n', stderr: '', exitCode: 0 });
    const info = await getOriginInfo();
    expect(info.isGithub).toBe(false);
    expect(info.isFork).toBe(false);
    expect(info.isUpstream).toBe(false);
    expect(info.fullName).toBe('team/PortOS');
  });

  it('returns hasOrigin=false when no origin remote exists', async () => {
    execGit.mockResolvedValue({ stdout: '', stderr: '', exitCode: 2 });
    const info = await getOriginInfo();
    expect(info.hasOrigin).toBe(false);
    expect(info.isFork).toBe(false);
    expect(info.isUpstream).toBe(false);
    expect(info.fullName).toBeNull();
  });

  it('returns hasOrigin=true but unparsed when URL is malformed', async () => {
    execGit.mockResolvedValue({ stdout: 'mumble-mumble', stderr: '', exitCode: 0 });
    const info = await getOriginInfo();
    expect(info.hasOrigin).toBe(true);
    expect(info.originUrl).toBe('mumble-mumble');
    expect(info.fullName).toBeNull();
    expect(info.isFork).toBe(false);
    expect(info.isUpstream).toBe(false);
  });
});

describe('upstream constants', () => {
  it('exposes UPSTREAM_OWNER, UPSTREAM_REPO, UPSTREAM_FULL_NAME', () => {
    expect(UPSTREAM_OWNER).toBe('atomantic');
    expect(UPSTREAM_REPO).toBe('PortOS');
    expect(UPSTREAM_FULL_NAME).toBe('atomantic/PortOS');
  });
});
