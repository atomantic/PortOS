import { describe, it, expect } from 'vitest';
import { posixPath } from './testHelper.js';

import { join } from 'path';
import { MAX_REPO_PATH_DEPTH, parseRepoUrl, isRepoUrl, repoCloneUrl, repoBrowseUrl, parseGitHubUrl, isGitHubRepoUrl } from './repoUrl.js';

const REPOS_ROOT = '/data/repos';
const clonePath = (url) => {
  const parsed = parseRepoUrl(url);
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

  // The parsed pair is a PATH OPERAND — repoCloner clones into
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

describe('parseRepoUrl across hosts', () => {
  it('parses a gitlab.com project the same shapes it parses a GitHub one', () => {
    for (const url of [
      'https://gitlab.com/example-group/example-repo',
      'https://gitlab.com/example-group/example-repo.git',
      'gitlab.com/example-group/example-repo',
      'git@gitlab.com:example-group/example-repo.git',
    ]) {
      expect(parseRepoUrl(url), url).toEqual({
        host: 'gitlab.com',
        provider: 'gitlab',
        owner: 'example-group',
        repo: 'example-repo',
      });
    }
  });

  it('keeps GitLab subgroups in the owner path', () => {
    expect(parseRepoUrl('https://gitlab.com/example-group/example-sub/example-repo'))
      .toMatchObject({ owner: 'example-group/example-sub', repo: 'example-repo' });
  });

  // GitLab's modern deep links insert /-/ before the UI route; the legacy shape
  // puts the route word straight after the project, which is why the segment
  // walk also stops at a reserved word.
  it('resolves a GitLab deep link back to the project', () => {
    expect(parseRepoUrl('https://gitlab.com/example-group/example-repo/-/tree/main/src'))
      .toMatchObject({ owner: 'example-group', repo: 'example-repo' });
    expect(parseRepoUrl('https://gitlab.com/example-group/example-repo/blob/main/README.md'))
      .toMatchObject({ owner: 'example-group', repo: 'example-repo' });
    expect(parseRepoUrl('https://github.com/example-owner/example-repo/tree/main'))
      .toMatchObject({ owner: 'example-owner', repo: 'example-repo' });
  });

  it('identifies GitHub repository names before deep-link route words', () => {
    for (const repoName of ['issues', 'settings', 'tree']) {
      expect(parseRepoUrl(`https://github.com/example-owner/${repoName}`), repoName)
        .toMatchObject({ owner: 'example-owner', repo: repoName });
    }
    expect(parseRepoUrl('https://github.com/example-owner/example-repo/discussions/1'))
      .toMatchObject({ owner: 'example-owner', repo: 'example-repo' });
  });

  // Without a depth cap, a project asset URL reads as a DEEPER NAMESPACE, and
  // the cloner then manufactures directories inside the existing acme/widgets
  // checkout before the clone of "pipeline.svg" fails.
  it('reads a GitLab project asset path as the project, not a deeper namespace', () => {
    for (const url of [
      'https://gitlab.com/acme/widgets/badges/main/pipeline.svg',
      'https://gitlab.com/acme/widgets/uploads/abc/screenshot.png',
      'https://gitlab.com/acme/widgets/edit',
    ]) {
      expect(parseRepoUrl(url), url).toMatchObject({ owner: 'acme', repo: 'widgets' });
    }
  });

  it('caps the GitLab namespace depth instead of walking an unbounded path', () => {
    expect(parseRepoUrl('https://gitlab.com/g1/g2/g3/example-repo'))
      .toMatchObject({ owner: 'g1/g2/g3', repo: 'example-repo' });
    // Past the cap the extra segments are a deep link, not a namespace — and an
    // unbounded owner would also push the clone below the staging sweep's reach.
    expect(parseRepoUrl('https://gitlab.com/g1/g2/g3/g4/example-repo')).toBeNull();
  });

  it('allows a dot in a GitLab group path but never in a GitHub owner', () => {
    expect(parseRepoUrl('https://gitlab.com/foo.bar/widgets'))
      .toMatchObject({ owner: 'foo.bar', repo: 'widgets' });
    // A dotted GitHub owner is not a real login, and admitting one would let
    // `github.com/gitlab.com/x` land on the gitlab clone root (GitHub clones use
    // the flat layout, so its owner segment IS the top level).
    expect(parseRepoUrl('https://github.com/gitlab.com/foo')).toBeNull();
  });

  // WHATWG maps a backslash to a slash inside the authority, so a browser
  // resolves this to evil.example.com while a naive regex reads github.com.
  it('refuses a backslash that would spoof the host past the anchor', () => {
    expect(parseRepoUrl(String.raw`https://evil.example.com\@github.com/example-owner/example-repo`)).toBeNull();
    expect(parseRepoUrl(String.raw`https://github.com\evil.example.com/o/r`)).toBeNull();
  });

  it('derives the clone-path depth bound from the host table', () => {
    // repos/<host>/<group>/<subgroup>/<subsubgroup>/<repo>
    expect(MAX_REPO_PATH_DEPTH).toBe(5);
  });

  it('refuses an unsupported host and a path-unsafe GitLab namespace', () => {
    expect(parseRepoUrl('https://bitbucket.org/example-owner/example-repo')).toBeNull();
    expect(parseRepoUrl('https://gitlab.com/../example-group/example-repo')).toBeNull();
    expect(parseRepoUrl('https://gitlab.com/example-group')).toBeNull();
    expect(isRepoUrl('https://gitlab.com/example-group/example-repo')).toBe(true);
    expect(isRepoUrl('https://bitbucket.org/example-owner/example-repo')).toBe(false);
  });

  it('builds the https clone and browse URLs from the parsed host', () => {
    expect(repoBrowseUrl(parseRepoUrl('git@gitlab.com:example-group/example-repo')))
      .toBe('https://gitlab.com/example-group/example-repo');

    expect(repoCloneUrl(parseRepoUrl('git@gitlab.com:example-group/example-repo')))
      .toBe('https://gitlab.com/example-group/example-repo.git');
    expect(repoCloneUrl(parseRepoUrl('https://github.com/example-owner/example-repo')))
      .toBe('https://github.com/example-owner/example-repo.git');
  });

  // The GitHub-only wrapper still exists for the callers whose downstream is
  // genuinely GitHub-specific (the Eidoverse worlds repo push).
  it('parseGitHubUrl rejects a valid GitLab repo', () => {
    expect(parseGitHubUrl('https://gitlab.com/example-group/example-repo')).toBeNull();
    expect(isGitHubRepoUrl('https://gitlab.com/example-group/example-repo')).toBe(false);
  });
});
