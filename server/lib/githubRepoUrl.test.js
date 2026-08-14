import { describe, it, expect } from 'vitest';
import { posixPath } from './testHelper.js';

import { join } from 'path';
import { parseGitHubUrl, isGitHubRepoUrl } from './githubRepoUrl.js';

const REPOS_ROOT = '/data/repos';
const clonePath = (url) => {
  const parsed = parseGitHubUrl(url);
  return parsed ? join(REPOS_ROOT, parsed.owner, parsed.repo) : null;
};

describe('parseGitHubUrl', () => {
  it('parses the shapes a user actually pastes', () => {
    for (const url of [
      'https://github.com/example-owner/example-repo',
      'https://github.com/example-owner/example-repo.git',
      'http://github.com/example-owner/example-repo',
      'https://www.github.com/example-owner/example-repo',
      'github.com/example-owner/example-repo',
      'git@github.com:example-owner/example-repo.git',
      'git@github.com:example-owner/example-repo',
    ]) {
      expect(parseGitHubUrl(url), url).toEqual({
        owner: 'example-owner',
        repo: 'example-repo',
        isGitHub: true,
      });
    }
  });

  it('resolves a deep link back to the repo it belongs to', () => {
    expect(parseGitHubUrl('https://github.com/example-owner/example-repo/tree/main/src'))
      .toMatchObject({ owner: 'example-owner', repo: 'example-repo' });
    expect(parseGitHubUrl('https://github.com/example-owner/example-repo?tab=readme'))
      .toMatchObject({ repo: 'example-repo' });
    expect(parseGitHubUrl('https://github.com/example-owner/example-repo#install'))
      .toMatchObject({ repo: 'example-repo' });
  });

  it('keeps a dot inside a repo name but strips only a trailing .git', () => {
    expect(parseGitHubUrl('https://github.com/example-owner/my.config.repo'))
      .toMatchObject({ repo: 'my.config.repo' });
    expect(parseGitHubUrl('https://github.com/example-owner/my.repo.git'))
      .toMatchObject({ repo: 'my.repo' });
  });

  it('is not a GitHub repo without both segments', () => {
    expect(parseGitHubUrl('https://github.com/example-owner')).toBeNull();
    expect(parseGitHubUrl('https://github.com/settings')).toBeNull();
    expect(parseGitHubUrl('https://example.com/example-owner/example-repo')).toBeNull();
    expect(parseGitHubUrl('')).toBeNull();
    expect(parseGitHubUrl(null)).toBeNull();
  });

  // The parsed pair is a PATH OPERAND — githubCloner clones into
  // join(reposDir, owner, repo), and that localPath is later handed to an agent
  // as the directory to scan/study. A dot segment escapes (or collapses to) the
  // managed clone root.
  describe('path safety', () => {
    it('refuses a dot segment in either position', () => {
      for (const url of [
        'https://github.com/../evil',
        'github.com/../evil',
        'git@github.com:../evil',
        'https://github.com/example-owner/..',
        'https://github.com/example-owner/.',
        'https://github.com/../../etc/passwd',
      ]) {
        expect(parseGitHubUrl(url), url).toBeNull();
      }
    });

    it('refuses percent-encoded and separator characters in the segments', () => {
      for (const url of [
        'https://github.com/%2e%2e/evil',
        'https://github.com/example-owner/%2e%2e',
        'https://github.com/a b/c',
      ]) {
        expect(parseGitHubUrl(url), url).toBeNull();
      }
    });

    it('never yields a clone path outside the repos root', () => {
      expect(clonePath('https://github.com/../evil')).toBeNull();
      expect(clonePath('https://github.com/example-owner/..')).toBeNull();
      expect(posixPath(clonePath('https://github.com/example-owner/example-repo')))
        .toBe('/data/repos/example-owner/example-repo');
    });

    it('does not read a foreign host that merely mentions github.com', () => {
      expect(parseGitHubUrl('https://evil.example.com/github.com/example-owner/example-repo')).toBeNull();
      expect(parseGitHubUrl('https://notgithub.com/example-owner/example-repo')).toBeNull();
    });
  });
});

describe('isGitHubRepoUrl', () => {
  it('agrees with parseGitHubUrl', () => {
    expect(isGitHubRepoUrl('https://github.com/example-owner/example-repo')).toBe(true);
    expect(isGitHubRepoUrl('https://github.com/../evil')).toBe(false);
    expect(isGitHubRepoUrl('https://example.com')).toBe(false);
  });
});
