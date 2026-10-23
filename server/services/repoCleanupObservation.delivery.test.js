import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { inspectOpenDeliveryRepair } from './repoCleanupObservation.js';

const forge = vi.hoisted(() => ({ view: null, calls: [], afterAncestry: null }));
vi.mock('./github.js', () => ({ execGh: vi.fn(async () => JSON.stringify(forge.view)) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({}) }));
vi.mock('../lib/execGit.js', async original => {
  const actual = await original();
  return { ...actual, execGit: async (args, cwd, options) => {
    forge.calls.push({ args, options });
    const answer = await actual.execGit(args, cwd, options);
    if (args[0] === 'merge-base' && forge.afterAncestry) {
      const hook = forge.afterAncestry;
      forge.afterAncestry = null;
      await hook();
    }
    return answer;
  } };
});

describe('open delivery relationship from exact local Git history', () => {
  let root;
  let base;
  let one;
  let two;
  let other;
  const branch = 'fix/work';
  const inspect = () => inspectOpenDeliveryRepair(root, branch, 'https://github.com/example/repo/pull/7');
  const commit = async text => {
    await writeFile(join(root, 'work.txt'), text);
    await execGit(['add', 'work.txt'], root);
    await execGit(['commit', '-m', text], root);
    return (await execGit(['rev-parse', 'HEAD'], root)).stdout.trim();
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'portos-delivery-ancestry-'));
    await materializeGitRepo(root);
    await execGit(['remote', 'add', 'origin', 'https://github.com/example/repo.git'], root);
    base = (await execGit(['rev-parse', 'HEAD'], root)).stdout.trim();
    await execGit(['checkout', '-b', branch], root);
    one = await commit('local one');
    two = await commit('local two');
    await execGit(['checkout', '-b', 'fixture/diverged', base], root);
    other = await commit('other history');
    await execGit(['checkout', 'main'], root);
    forge.view = { number: 7, state: 'OPEN', isDraft: false, isCrossRepository: false,
      headRefName: branch, headRefOid: two, mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [] };
    forge.calls = [];
    forge.afterAncestry = null;
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

  it.each(['local-ahead', 'local-behind', 'diverged', 'equal'])('reports %s without changing refs or authorizing delivery', async relation => {
    const local = relation === 'local-behind' ? one : two;
    const published = relation === 'local-ahead' ? one : relation === 'diverged' ? other : two;
    await execGit(['update-ref', `refs/heads/${branch}`, local], root);
    forge.view.headRefOid = published;
    // Even failed checks on a mismatching published head cannot authorize
    // repair of a different local head or overwrite its unpublished commits.
    forge.view.statusCheckRollup = [{ name: 'CI', conclusion: 'FAILURE' }];
    const before = (await execGit(['show-ref'], root)).stdout;
    forge.calls = [];
    const result = await inspect();
    expect(result).toMatchObject({ ancestry: { relation, localHead: local, publishedHead: published } });
    if (relation === 'equal') expect(result).toMatchObject({ actionable: true, headSha: two });
    else {
      expect(result.reason).toBe(`delivery-${relation}`);
      expect(result.actionable).not.toBe(true);
      expect(result.headSha).toBeUndefined();
    }
    expect(forge.calls.some(({ args }) => ['fetch', 'push', 'reset', 'update-ref', 'checkout'].includes(args[0]))).toBe(false);
    expect((await execGit(['show-ref'], root)).stdout).toBe(before);
  });

  it('retains unknown for an unavailable published object without fetching it', async () => {
    forge.view.headRefOid = 'a'.repeat(40);
    expect(await inspect()).toMatchObject({ reason: 'delivery-head-unverified' });
    expect(forge.calls.some(({ args }) => args[0] === 'fetch')).toBe(false);
    expect(forge.calls.filter(({ args }) => ['cat-file', 'merge-base'].includes(args[0])))
      .toEqual(expect.arrayContaining([expect.objectContaining({ options: expect.objectContaining({
        env: expect.objectContaining({ GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' }),
      }) })]));
  });

  it('rejects a changed local ref after observing ancestry', async () => {
    forge.view.headRefOid = one;
    forge.afterAncestry = () => execGit(['update-ref', `refs/heads/${branch}`, base], root);
    expect(await inspect()).toMatchObject({ reason: 'delivery-head-unverified' });
  });

  it('does not infer divergence from a shallow history boundary', async () => {
    forge.view.headRefOid = other;
    await writeFile(join(root, '.git', 'shallow'), `${two}\n${other}\n`);
    const result = await inspect();
    expect(result).toMatchObject({ reason: 'delivery-head-unverified' });
    expect(result.ancestry).toBeUndefined();
    expect(result.headSha).toBeUndefined();
  });

  it.each(['foreign branch', 'cross-repository', 'no local branch'])('does not adopt %s from PR metadata', async kind => {
    if (kind === 'foreign branch') forge.view.headRefName = 'fix/another-machine';
    if (kind === 'cross-repository') forge.view.isCrossRepository = true;
    if (kind === 'no local branch') await execGit(['update-ref', '-d', `refs/heads/${branch}`], root);
    expect(await inspect()).toMatchObject({ reason: 'delivery-head-unverified' });
  });
});
