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
  redactRemoteUrlCredentials,
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

  it('strips ports from host so github.com:443 still classifies as GitHub', () => {
    // ssh:// with explicit port
    expect(parseGitRemoteUrl('ssh://git@github.com:443/atomantic/PortOS.git')).toEqual({
      host: 'github.com', owner: 'atomantic', repo: 'PortOS'
    });
    // HTTPS with explicit port
    expect(parseGitRemoteUrl('https://github.com:443/atomantic/PortOS.git')).toEqual({
      host: 'github.com', owner: 'atomantic', repo: 'PortOS'
    });
  });

  it('accepts the SCP `host:port/owner/repo` GitHub variant', () => {
    // GitHub publishes `git@ssh.github.com:443/owner/repo.git` for users
    // tunneling SSH over 443 — must classify the same as the standard form.
    expect(parseGitRemoteUrl('git@ssh.github.com:443/atomantic/PortOS.git')).toEqual({
      host: 'ssh.github.com', owner: 'atomantic', repo: 'PortOS'
    });
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

  it('classifies fork when origin is another github user with the same repo name', async () => {
    execGit.mockResolvedValue({ stdout: 'git@github.com:alice/PortOS.git\n', stderr: '', exitCode: 0 });
    const info = await getOriginInfo();
    expect(info.isFork).toBe(true);
    expect(info.isUpstream).toBe(false);
    expect(info.fullName).toBe('alice/PortOS');
  });

  it('does NOT classify as fork when the repo name differs (renamed/unrelated)', async () => {
    // Someone might fork-and-rename, or point origin at an unrelated GitHub
    // repo. Treating that as a fork would invoke `gh repo sync` and fail.
    execGit.mockResolvedValue({ stdout: 'git@github.com:alice/MyCustomOS.git\n', stderr: '', exitCode: 0 });
    const info = await getOriginInfo();
    expect(info.isGithub).toBe(true);
    expect(info.isFork).toBe(false);
    expect(info.isUpstream).toBe(false);
    expect(info.fullName).toBe('alice/MyCustomOS');
  });

  it('classifies upstream even when origin URL carries a port', async () => {
    execGit.mockResolvedValue({ stdout: 'ssh://git@github.com:443/atomantic/PortOS.git\n', stderr: '', exitCode: 0 });
    const info = await getOriginInfo();
    expect(info.host).toBe('github.com');
    expect(info.isGithub).toBe(true);
    expect(info.isUpstream).toBe(true);
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

describe('redactRemoteUrlCredentials', () => {
  it('strips https://user:token@ prefix', () => {
    expect(redactRemoteUrlCredentials('https://user:ghp_secret@github.com/alice/PortOS.git'))
      .toBe('https://***@github.com/alice/PortOS.git');
  });

  it('strips https://token@ prefix (no password)', () => {
    expect(redactRemoteUrlCredentials('https://ghp_token@github.com/alice/PortOS.git'))
      .toBe('https://***@github.com/alice/PortOS.git');
  });

  it('strips credentials from ssh:// URLs', () => {
    expect(redactRemoteUrlCredentials('ssh://git:secret@github.com/alice/PortOS.git'))
      .toBe('ssh://***@github.com/alice/PortOS.git');
  });

  it('leaves SCP-style remotes untouched (no embedded secret)', () => {
    expect(redactRemoteUrlCredentials('git@github.com:alice/PortOS.git'))
      .toBe('git@github.com:alice/PortOS.git');
  });

  it('leaves URLs without credentials untouched', () => {
    expect(redactRemoteUrlCredentials('https://github.com/alice/PortOS.git'))
      .toBe('https://github.com/alice/PortOS.git');
  });

  it('returns non-string input unchanged', () => {
    expect(redactRemoteUrlCredentials(null)).toBeNull();
    expect(redactRemoteUrlCredentials(undefined)).toBeUndefined();
  });
});

describe('getOriginInfo credential leak regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never returns credentials in originUrl when the remote embeds a PAT', async () => {
    execGit.mockResolvedValue({
      stdout: 'https://alice:ghp_secret_abc123@github.com/alice/PortOS.git\n',
      stderr: '',
      exitCode: 0
    });
    const info = await getOriginInfo();
    expect(info.originUrl).toBe('https://***@github.com/alice/PortOS.git');
    // Belt-and-suspenders: the secret must not appear anywhere in the result
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain('ghp_secret_abc123');
    expect(serialized).not.toContain('alice:'); // user:pass prefix
    // Classification should still work — credentials don't break the parser
    expect(info.isGithub).toBe(true);
    expect(info.isFork).toBe(true);
    expect(info.fullName).toBe('alice/PortOS');
  });

  it('also redacts when the URL is unparseable', async () => {
    execGit.mockResolvedValue({
      stdout: 'https://user:tok@somethingweirdwithoutslash',
      stderr: '',
      exitCode: 0
    });
    const info = await getOriginInfo();
    expect(info.originUrl).not.toContain('tok');
    expect(info.originUrl).toContain('***@');
  });
});

describe('upstream constants', () => {
  it('exposes UPSTREAM_OWNER, UPSTREAM_REPO, UPSTREAM_FULL_NAME', () => {
    expect(UPSTREAM_OWNER).toBe('atomantic');
    expect(UPSTREAM_REPO).toBe('PortOS');
    expect(UPSTREAM_FULL_NAME).toBe('atomantic/PortOS');
  });
});
