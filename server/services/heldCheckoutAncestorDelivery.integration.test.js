/** A merged PR whose head was rewritten after the checkout's last push still
 * delivered every local commit when that head contains the local tip (#14022). */
import { afterAll, afterEach, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownFixtureWork } from '../lib/mockPathsDataRoot.js';
const fixture = vi.hoisted(() => ({ app: null, policies: [], schedulePath: null, pr: null, detail: null, refs: {}, calls: [], remote: null, compare: null }));
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('ancestor-delivery-state-') }));
vi.mock('./cos.js', () => ({}));
vi.mock('../lib/execGit.js', async original => {
  const actual = await original();
  return { ...actual,
    execGitSafe: (args, cwd, options) => owned.run('git', () => actual.execGitSafe(args, cwd, options)),
    execGit: (args, cwd, options) => owned.run('git', () => actual.execGit(
      args.includes('fetch') ? args.map(arg => arg === 'https://github.com/example/repo.git' ? fixture.remote : arg) : args, cwd, options)) };
});
vi.mock('./apps.js', () => ({ getAppById: async () => fixture.app }));
vi.mock('../lib/gitRemote.js', () => ({ getOriginInfo: async () => ({ host: 'github.com', fullName: 'example/repo', isGithub: true }) }));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({}) }));
vi.mock('./github.js', () => ({ execGh: async args => {
  fixture.calls.push(args);
  if (args[0] === 'pr') return JSON.stringify(fixture.pr);
  const path = args.at(-1);
  if (path === 'repos/example/repo') return JSON.stringify({ default_branch: 'main' });
  if (path === 'repos/example/repo/pulls/42') return JSON.stringify(fixture.detail);
  if (path.includes('/git/ref/heads/')) return JSON.stringify({ object: { sha: fixture.refs[decodeURIComponent(path.split('/heads/')[1])] } });
  if (path.includes('/compare/')) {
    const [tip, head] = path.split('/compare/')[1].split('?')[0].split('...');
    if (fixture.compare) return JSON.stringify(fixture.compare);
    const { execGit: git } = await import('../lib/execGit.js');
    const known = sha => git(['cat-file', '-e', `${sha}^{commit}`], fixture.remote).then(() => true, () => false);
    if (!await known(tip) || !await known(head)) throw Object.assign(new Error('gh failed'), { ghStderr: 'gh: Not Found (HTTP 404)' });
    const ahead = (await git(['merge-base', '--is-ancestor', tip, head], fixture.remote, { ignoreExitCode: true })).exitCode === 0;
    return JSON.stringify({ status: ahead ? 'ahead' : 'diverged', behind_by: ahead ? 0 : 1,
      base_commit: { sha: tip }, merge_base_commit: { sha: ahead ? tip : 'f'.repeat(40) } });
  }
  throw new Error('Historical capped scope must not be enumerated');
} }));
vi.mock('./branchCompletionPolicy.js', async original => ({ ...await original(), readBranchCompletionPolicies: async () => fixture.policies }));
vi.mock('./taskScheduleStore.js', async importOriginal => ({
  ...(await importOriginal()),
  loadSchedule: async () => JSON.parse(await readFile(fixture.schedulePath, 'utf8')),
  updateSchedule: async mutate => {
    const schedule = JSON.parse(await readFile(fixture.schedulePath, 'utf8'));
    const result = await mutate(schedule);
    if (result.changed) await writeFile(fixture.schedulePath, JSON.stringify(schedule));
    return result.result;
  },
}));
const { listWorktrees } = await import('./worktreeManager.js');
const { prepareInventoriedCheckoutRetirement, retireInventoriedCheckout } = await import('./heldCheckoutRecovery.js');
const { prepareReconcileRetirements } = await import('./branchReconcileRetirement.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./branchReconcileOutcome.js');
const owned = ownFixtureWork();
const it = owned.tests(vitestIt);
let scratch;
beforeEach(async () => { await owned.prepare(); scratch = null; });
afterEach(() => owned.cleanup(async () => {
  try { await owned.drain(); }
  finally { if (scratch) await owned.run('scratch-removal', () => rm(scratch, { recursive: true, force: true, maxRetries: 3 })); }
}));
afterAll(() => owned.finish(cleanupTempDataRoots));

const commit = async (cwd, file, text) => {
  await writeFile(join(cwd, file), text);
  await execGit(['add', file], cwd); await execGit(['commit', '-m', `add ${file}`], cwd);
  return (await execGit(['rev-parse', 'HEAD'], cwd)).stdout.trim();
};

// Shaped like a claim run that pushed its PR and reported it incomplete; the
// PR head was later rewritten on the forge and merged by a separate push.
const claimOwner = (id, branch, repo, extra = {}) => ({ id, taskId: 'claim-task', status: 'completed',
  startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z',
  result: { success: false, executionSuccess: true, validationPassed: null, ...extra.result },
  metadata: { instanceId: 'fixture-instance', workspacePath: repo, sourceWorkspace: repo, isWorktree: false, configClaimFlow: true,
    claimBranch: branch, claimBranches: [branch], claimReleasedBranches: [], prCompletionPolicy: 'review-then-merge',
    completedCheckouts: [], ...extra.metadata } });

describe('merged PR head containing the local tip (real Git)', () => {
  it.each(['ancestor', 'scheduled', 'exact', 'local-commit', 'forge-misreports', 'not-merged', 'cross-repository',
    'leave-open', 'approval', 'unfetchable'])('%s', async scenario => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'ancestor-delivery-')));
    const repo = join(scratch, 'repo'); await materializeGitRepo(repo);
    const remote = fixture.remote = join(scratch, 'origin.git'); await execGit(['init', '--bare', remote], scratch);
    await execGit(['remote', 'add', 'origin', remote], repo);
    const branch = 'claim/issue-42';
    const path = join(repo, '.claude', 'worktrees', 'claim-issue-42');
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    await commit(path, 'first.txt', 'first local commit\n');
    let tip = await commit(path, 'second.txt', 'second local commit\n');
    await execGit(['push', 'origin', 'main', branch], repo);

    // The forge-side rewrite: a later push extends the PR head, which merges.
    const other = join(scratch, 'other');
    await execGit(['clone', '--branch', branch, remote, other], scratch);
    for (const [key, value] of [['user.email', 'fixture@example.com'], ['user.name', 'Fixture']]) await execGit(['config', key, value], other);
    const prHead = scenario === 'exact' ? tip : await commit(other, 'review-fix.txt', 'review follow-up\n');
    await execGit(['switch', 'main'], other);
    await execGit(['merge', '--no-ff', branch, '-m', 'merge pull request 42'], other);
    await execGit(['push', 'origin', 'main', branch], other);
    const merge = (await execGit(['rev-parse', 'HEAD'], other)).stdout.trim();
    if (scenario === 'exact') await execGit(['fetch', 'origin', 'main'], repo);

    if (['local-commit', 'forge-misreports'].includes(scenario)) tip = await commit(path, 'unshipped.txt', 'wanted local work\n');
    if (scenario === 'forge-misreports') fixture.compare = { status: 'ahead', behind_by: 0, base_commit: { sha: tip }, merge_base_commit: { sha: tip } };
    else fixture.compare = null;
    fixture.refs = { main: merge };
    fixture.calls = [];
    fixture.pr = { url: 'https://github.com/example/repo/pull/42', state: scenario === 'not-merged' ? 'OPEN' : 'MERGED', headRefName: branch,
      headRefOid: prHead, isCrossRepository: scenario === 'cross-repository', baseRefName: 'main', mergeCommit: { oid: merge } };
    fixture.detail = { head: { sha: prHead }, base: { ref: 'main' }, merged: true, merge_commit_sha: merge, commits: 401, changed_files: 501 };
    if (scenario === 'unfetchable') {
      // The forge vouches for a head nobody can fetch; nothing local proves it.
      fixture.pr.headRefOid = fixture.detail.head.sha = 'b'.repeat(40);
      fixture.compare = { status: 'ahead', behind_by: 0, base_commit: { sha: tip }, merge_base_commit: { sha: tip } };
      await execGit(['push', 'origin', '--delete', branch], other);
    }
    fixture.app = { id: 'app-ancestor', repoPath: repo };
    fixture.policies = scenario === 'exact'
      ? [claimOwner('exact-owner', branch, repo, { result: { success: true } })]
      : [claimOwner('first-run', branch, repo), { ...claimOwner('second-run', branch, repo), id: 'second-run',
        startedAt: '2026-01-01T01:00:00.000Z', completedAt: '2026-01-01T01:01:00.000Z' }];
    if (scenario === 'leave-open') fixture.policies[1].metadata.prCompletionPolicy = 'leave-open';
    if (scenario === 'approval') fixture.policies[1].result.taskOutcome = { recovery: { mode: 'approval' } };
    fixture.schedulePath = join(scratch, 'schedule.json');
    await writeFile(fixture.schedulePath, JSON.stringify({ tasks: {}, executions: {} }));
    const release = { branch, path, head: tip, locked: false, lockReason: null };
    await recordBranchReconcileOutcome(fixture.app.id, { status: 'incomplete', remaining: [{ ...release, reason: 'pr-completion-review-required' }] });
    const opts = { cosDir: join(scratch, 'cos'), readAgents: async () => [] };
    await mkdir(opts.cosDir);
    const input = { appId: fixture.app.id, release, prUrl: fixture.pr.url };
    const retained = async () => {
      expect((await listWorktrees(repo)).filter(tree => resolve(tree.path) === resolve(path)))
        .toMatchObject([{ branch: `refs/heads/${branch}`, head: tip }]);
      expect((await getBranchReconcileOutcome(fixture.app.id)).retired || []).toEqual([]);
    };
    const removed = async () => {
      expect((await listWorktrees(repo)).filter(tree => resolve(tree.path) === resolve(path))).toEqual([]);
      expect((await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
      expect(fixture.policies.every(agent => agent.result.success !== true || scenario === 'exact')).toBe(true);
    };

    if (scenario === 'scheduled') {
      const result = { wip: [{ branch, tip, worktreePath: path, isMerged: false, rule: 'completion-policy',
        completionPolicyReason: 'pr-completion-review-required' }],
      worktreeInventory: [{ branch, path, head: tip, managed: true, locked: false, lockReason: null }] };
      const outcome = await prepareReconcileRetirements(fixture.app, result, { readPr: async () => fixture.pr.url,
        prepare: request => prepareInventoriedCheckoutRetirement(request, opts),
        retire: request => retireInventoriedCheckout(request, opts) });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ candidates: [], held: [], retired: [expect.objectContaining({ head: tip })] });
      return removed();
    }

    const prepared = await prepareInventoriedCheckoutRetirement(input, opts);
    if (scenario === 'exact') {
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { forge: { scopeProof: 'exact-delivered-head' },
        comparison: { disposition: 'integrated', exactMergedDelivery: true } } });
      expect(fixture.calls.some(args => args.at(-1).includes('/compare/'))).toBe(false);
      return;
    }
    if (scenario === 'ancestor') {
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: {
        forge: { scopeProof: 'ancestor-of-delivered-head', deliveredAncestorHead: tip, prHead },
        comparison: { disposition: 'integrated', exactMergedDelivery: false, ancestorOfDeliveredHead: true, difference: '' },
        policy: { reason: null, policies: [
          { id: 'first-run', success: false, deliveredAncestor: { tip, prHead } },
          { id: 'second-run', success: false, deliveredAncestor: { tip, prHead } }] } } });
      expect(fixture.calls.some(args => args.includes('--paginate'))).toBe(false);
      const retired = await retireInventoriedCheckout({ ...input, review: { prUrl: fixture.pr.url, digest: prepared.review.digest, acceptSuperseded: false } }, opts);
      expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
      expect(retired.archiveDir).toBeUndefined();
      expect((await getBranchReconcileOutcome(fixture.app.id)).retired).toEqual([expect.objectContaining({ path, branch, head: tip, branchDeleted: true })]);
      return removed();
    }
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: false, reason: {
      'local-commit': 'retirement-original-scope-unavailable',
      'forge-misreports': 'retirement-local-commit-undelivered',
      'not-merged': 'retirement-pr-not-matching-merged',
      'cross-repository': 'retirement-pr-not-matching-merged',
      'leave-open': 'pr-completion-human-handoff',
      approval: 'retirement-policy-not-legacy-completed',
      unfetchable: 'retirement-proof-fetch-failed',
    }[scenario] });
    if (scenario === 'local-commit') expect(fixture.calls.some(args => args.at(-1).includes('/compare/'))).toBe(true);
    await retained();
    expect(await readFile(join(path, 'second.txt'), 'utf8')).toBe('second local commit\n');
  });
});
