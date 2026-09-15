import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { parseSshHostAliases, resolveSshHostAlias, __resetSshHostAliasCache } from './sshHostAlias.js';
import { parseGitRemote, detectForgeCli } from './gitForge.js';
import { parseGitRemoteUrl } from './gitRemote.js';
import { hostFromOriginUrl, hostToWorkTracker } from './workTracker.js';

describe('parseSshHostAliases', () => {
  it('maps every literal alias in a block to its HostName', () => {
    const aliases = parseSshHostAliases([
      '# a comment',
      'Host github-acme gh-acme',
      '  HostName github.com',
      '  IdentityFile ~/.ssh/id_acme',
      '',
      'Host gl-internal',
      '  HostName=gitlab.example.com',
      '  Port 2222',
    ].join('\n'));
    expect(Object.fromEntries(aliases)).toEqual({
      'github-acme': 'github.com',
      'gh-acme': 'github.com',
      'gl-internal': 'gitlab.example.com',
    });
  });

  it('declines the patterns ssh resolves at connect time rather than guessing', () => {
    // A wildcard alias never appears verbatim in a remote URL; a Match block's
    // HostName depends on the local network; and `%h` expands per connection.
    // Each must leave NO entry rather than a plausible-looking wrong one.
    const aliases = parseSshHostAliases([
      'Host *',
      '  HostName fallback.example.com',
      'Host bastion-?',
      '  HostName bastion.example.com',
      'Host tunneled',
      '  HostName %h.internal.example.com',
      'Host after-match',
      'Match host github.com',
      '  HostName wrong.example.com',
    ].join('\n'));
    expect(aliases.size).toBe(0);
  });

  it('keeps the first HostName for a repeated alias and drops a user@ prefix', () => {
    const aliases = parseSshHostAliases([
      'Host dup',
      '  HostName git@first.example.com',
      'Host dup',
      '  HostName second.example.com',
    ].join('\n'));
    expect(aliases.get('dup')).toBe('first.example.com');
  });

  it('does not chain one alias through another, matching ssh', () => {
    // ssh applies `Host` matching to the name in the URL once; the resulting
    // `HostName` is the final value and is never re-matched. Chaining here would
    // send a remote to a host ssh itself would never dial.
    const aliases = parseSshHostAliases([
      'Host first',
      '  HostName second',
      'Host second',
      '  HostName third.example.com',
    ].join('\n'));
    expect(aliases.get('first')).toBe('second');
    expect(aliases.get('second')).toBe('third.example.com');
  });

  it('records a self-referential alias as the harmless no-op it is', () => {
    const aliases = parseSshHostAliases('Host github.com\n  HostName github.com\n');
    expect(aliases.get('github.com')).toBe('github.com');
  });

  it('returns an empty map for missing or non-string input', () => {
    expect(parseSshHostAliases('').size).toBe(0);
    expect(parseSshHostAliases(null).size).toBe(0);
  });
});

describe('resolveSshHostAlias', () => {
  let home;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'portos-ssh-'));
    mkdirSync(join(home, '.ssh'));
    // `os.homedir()` reads $HOME on POSIX, which is how the module under test
    // finds the config — no module mock needed.
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    __resetSshHostAliasCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSshHostAliasCache();
    rmSync(home, { recursive: true, force: true });
  });

  const writeConfig = (text) => writeFileSync(join(home, '.ssh', 'config'), text);

  it('resolves a per-account alias to the host the remote really connects to', () => {
    writeConfig('Host github-acme\n  HostName github.com\n');
    expect(resolveSshHostAlias('github-acme')).toBe('github.com');
    // Aliases are case-insensitive to ssh, and a remote may be written either way.
    expect(resolveSshHostAlias('GitHub-Acme')).toBe('github.com');
  });

  it('passes through a host that is not an alias, and non-string input', () => {
    writeConfig('Host github-acme\n  HostName github.com\n');
    expect(resolveSshHostAlias('github.com')).toBe('github.com');
    expect(resolveSshHostAlias('gitlab.example.com')).toBe('gitlab.example.com');
    expect(resolveSshHostAlias(null)).toBe(null);
    expect(resolveSshHostAlias('')).toBe('');
  });

  it('treats an absent ssh config as "no aliases" rather than an error', () => {
    expect(() => resolveSshHostAlias('github-acme')).not.toThrow();
    expect(resolveSshHostAlias('github-acme')).toBe('github-acme');
  });
});

describe('remote-host parsers under a multi-account ssh alias', () => {
  // The regression this module exists for: a repo cloned through a per-account
  // alias classified as an unknown host, so CoS reported the forge unreachable
  // and held every change-request task, the work tracker silently fell back to
  // PLAN.md, and agents never received an account-pinned GH_TOKEN. Asserted at
  // all three parsers because each one feeds a different one of those paths.
  let home;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'portos-ssh-'));
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'config'), 'Host github-acme\n  HostName github.com\n  IdentityFile ~/.ssh/id_acme\n');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    __resetSshHostAliasCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSshHostAliasCache();
    rmSync(home, { recursive: true, force: true });
  });

  const REMOTE = 'git@github-acme:acme/widget.git';

  it('reports the real forge host, so the repo is a GitHub repo everywhere', () => {
    expect(parseGitRemote(REMOTE)).toEqual({ host: 'github.com', owner: 'acme' });
    expect(parseGitRemoteUrl(REMOTE)).toEqual({ host: 'github.com', owner: 'acme', repo: 'widget' });
    expect(hostFromOriginUrl(REMOTE)).toBe('github.com');
    expect(detectForgeCli(parseGitRemote(REMOTE).host)).toBe('gh');
    expect(hostToWorkTracker(hostFromOriginUrl(REMOTE))).toBe('github');
  });

  it('strips a port before the alias lookup', () => {
    expect(parseGitRemoteUrl('ssh://git@github-acme:22/acme/widget.git').host).toBe('github.com');
  });

  it('leaves an alias the ssh config does not declare alone', () => {
    expect(parseGitRemote('git@github-other:acme/widget.git')).toEqual({ host: 'github-other', owner: 'acme' });
  });
});
