import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { workflowJobs } from './lib/workflowJobs.js';
import { checkReleaseTag } from './verify-release-tag.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'v1.2.3';
const TESTED_TREE = 'a'.repeat(40);
const MAIN_TREE = 'b'.repeat(40);

// A fake GitHub: refs maps path -> {status, body}; anything absent is unanswerable.
const fakeApi = (routes) => (path) => routes[path] ?? null;
const tagRef = (object) => ({ status: 200, body: { ref: `refs/tags/${TAG}`, object } });
const commitRoute = (sha, tree) => ({ [`git/commits/${sha}`]: { status: 200, body: { tree: { sha: tree } } } });

describe('checkReleaseTag', () => {
  it('lets a missing tag through so the pinned target creates it', () => {
    const api = fakeApi({ [`git/ref/tags/${TAG}`]: { status: 404, body: null } });
    expect(checkReleaseTag({ tag: TAG, headTree: TESTED_TREE, api })).toMatchObject({ ok: true, exists: false });
  });

  it('accepts a lightweight tag on a different commit with the same tree', () => {
    const api = fakeApi({
      [`git/ref/tags/${TAG}`]: tagRef({ type: 'commit', sha: 'mainparent' }),
      ...commitRoute('mainparent', TESTED_TREE),
    });
    expect(checkReleaseTag({ tag: TAG, headTree: TESTED_TREE, api })).toMatchObject({ ok: true, exists: true });
  });

  it('peels an annotated tag before comparing trees', () => {
    const api = fakeApi({
      [`git/ref/tags/${TAG}`]: tagRef({ type: 'tag', sha: 'tagobj' }),
      'git/tags/tagobj': { status: 200, body: { object: { type: 'commit', sha: 'c1' } } },
      ...commitRoute('c1', TESTED_TREE),
    });
    expect(checkReleaseTag({ tag: TAG, headTree: TESTED_TREE, api }).ok).toBe(true);
  });

  it('fails a tag that landed on main after it advanced (different tree)', () => {
    const api = fakeApi({
      [`git/ref/tags/${TAG}`]: tagRef({ type: 'commit', sha: 'maintip' }),
      ...commitRoute('maintip', MAIN_TREE),
    });
    const result = checkReleaseTag({ tag: TAG, headTree: TESTED_TREE, api });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not the verified release tree');
  });

  it.each([
    ['the tag lookup is unavailable', {}],
    ['the tag lookup is a server error', { [`git/ref/tags/${TAG}`]: { status: 500, body: null } }],
    ['the answer is for a different ref', { [`git/ref/tags/${TAG}`]: { status: 200, body: { ref: 'refs/tags/v1.2.30', object: { type: 'commit', sha: 'x' } } } }],
    ['the tag points at a tree', { [`git/ref/tags/${TAG}`]: tagRef({ type: 'tree', sha: 'x' }) }],
    ['the commit cannot be read', { [`git/ref/tags/${TAG}`]: tagRef({ type: 'commit', sha: 'x' }) }],
    ['the annotated tag cannot be read', { [`git/ref/tags/${TAG}`]: tagRef({ type: 'tag', sha: 'x' }) }],
  ])('fails closed when %s', (_name, routes) => {
    expect(checkReleaseTag({ tag: TAG, headTree: TESTED_TREE, api: fakeApi(routes) }).ok).toBe(false);
  });

  it('fails closed when the release tree is unknown, before asking GitHub', () => {
    const api = () => { throw new Error('should not be called'); };
    expect(checkReleaseTag({ tag: TAG, headTree: null, api }).ok).toBe(false);
  });
});

describe('release.yml publication contract', () => {
  const yaml = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
  const release = workflowJobs(yaml).release;

  it('creates a new tag at the triggering SHA, never the default branch', () => {
    expect(release).toMatch(/uses: softprops\/action-gh-release@[0-9a-f]{40}[\s\S]*?target_commitish: \$\{\{ github\.sha \}\}/);
  });

  it('checks an existing tag before the release can be created', () => {
    const check = release.indexOf('node scripts/verify-release-tag.js');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(release.indexOf('softprops/action-gh-release'));
  });

  it('re-checks the tag after publication and keeps the existing permissions', () => {
    expect(release.lastIndexOf('node scripts/verify-release-tag.js')).toBeGreaterThan(release.indexOf('softprops/action-gh-release'));
    expect(yaml.match(/^permissions:\n {2}contents: write\n/m)).not.toBeNull();
    expect(yaml).not.toMatch(/--force|git push[^\n]*\btag\b|git tag /);
  });
});
