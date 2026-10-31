/** Capped forge scope must not strand an exact delivered clean checkout. */
import { afterAll, afterEach, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { cp, lstat, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownFixtureWork } from '../lib/mockPathsDataRoot.js';
const fixture = vi.hoisted(() => ({ app: null, policies: [], owners: [], schedulePath: null, pr: null, detail: null, refs: {}, calls: [], remote: null }));
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('exact-delivery-state-') }));
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
  if (path.includes('/pulls?')) return fixture.detail?.openPrivateSource ? '[{"state":"open"}]' : '[]';
  if (fixture.detail?.privateSourceBase && path.includes('/pulls/42/files?')) return JSON.stringify([[{ filename: 'options.txt', status: 'modified' }]]);
  if (fixture.detail?.privateSourceBase && path.includes('/pulls/42/commits?')) return JSON.stringify([[{
    sha: fixture.pr.headRefOid, parents: [{ sha: fixture.detail.privateSourceBase }] }]]);
  if (path.includes('/git/ref/heads/')) return JSON.stringify({ object: { sha: fixture.refs[decodeURIComponent(path.split('/heads/')[1])] } });
  // No scenario here has a PR head that contains a different local tip.
  if (path.includes('/compare/')) return JSON.stringify({ status: 'diverged', behind_by: 1 });
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
const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
const { prepareInventoriedCheckoutRetirement, retireInventoriedCheckout } = await import('./heldCheckoutRecovery.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./branchReconcileOutcome.js');
const owned = ownFixtureWork();
const it = owned.tests(vitestIt);
let scratch;
beforeEach(async () => {
  await owned.prepare();
  scratch = null;
});
afterEach(({ task, signal }) => {
  return owned.cleanup(async () => {
    // CI's quiet setup replaces console methods, including on failed tests.
    const report = () => process.stderr.write(`⏱️ exact-delivery fixture: ${owned.summary()}\n`);
    const failed = Boolean(task.result?.errors?.length || signal.aborted);
    if (failed) report();
    try { await owned.drain(); }
    finally {
      if (failed || process.env.PORTOS_PROFILE_RETIREMENT_FIXTURE === '1') report();
      if (scratch) {
        try { await owned.run('scratch-removal', () => rm(scratch, { recursive: true, force: true, maxRetries: 3 })); }
        catch (error) { await owned.drain(); report(); throw error; }
      }
    }
  });
});
afterAll(() => owned.finish(cleanupTempDataRoots));

// Each describe's scenario-independent history (real repository, bare origin,
// delivered commits) is built once per variant and copied per case, the way
// heldCheckoutRecovery.test.js copies its pristine repository. Every case still
// owns its repository, origin and worktree registrations: the copy's worktrees
// are re-registered at their new paths and origin is re-pointed at the copy.
const seeds = new Map();
async function seededScratch(prefix, key, build) {
  const id = `${prefix}${key}`;
  if (!seeds.has(id)) {
    seeds.set(id, (async () => {
      const seed = join(await realpath(lazyTempDataRoot('exact-delivery-seeds-')), createHash('sha256').update(id).digest('hex').slice(0, 16));
      await mkdir(seed);
      const repo = join(seed, 'repo'); await materializeGitRepo(repo);
      const remote = join(seed, 'origin.git'); await execGit(['init', '--bare', remote], seed);
      await execGit(['remote', 'add', 'origin', remote], repo);
      return { seed, values: await build({ scratch: seed, repo, remote }) };
    })());
  }
  const { seed, values } = await seeds.get(id);
  scratch = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await cp(seed, scratch, { recursive: true });
  const repo = join(scratch, 'repo'); const remote = join(scratch, 'origin.git');
  // Re-link both halves of each worktree registration to the copy; `git worktree
  // repair` would follow the copied pointer and rewrite the seed instead.
  const admin = join(repo, '.git', 'worktrees');
  await Promise.all((await readdir(admin).catch(() => [])).map(async name => {
    const dotGit = resolve(scratch, relative(seed, (await readFile(join(admin, name, 'gitdir'), 'utf8')).trim()));
    await writeFile(join(admin, name, 'gitdir'), `${dotGit}\n`);
    await writeFile(dotGit, `gitdir: ${join(admin, name)}\n`);
  }));
  await execGit(['remote', 'set-url', 'origin', remote], repo);
  fixture.remote = remote;
  return { repo, remote, ...values };
}

describe('exact delivered head retirement with capped historical API (real Git)', () => {
  it.each(['exact', 'named-sibling', 'named-sibling-unrelated', 'same-task-seeded', 'precreation', 'precreation-dirty', 'precreation-untracked', 'precreation-active', 'precreation-uncertain', 'precreation-late', 'wrong-head', 'unpublished', 'wrong-base', 'wrong-target', 'wrong-merge-proof', 'missing-object', 'remote-change', 'dirty', 'active', 'supersession'])(
    'retains all existing retirement gates: %s', async scenario => {
      const branch = scenario.startsWith('precreation') ? 'claim/issue-42' : 'delivery/candidate';
      const { repo, remote, head, merge, main } = await seededScratch('exact-delivery-', branch, async ({ repo }) => {
        const path = join(repo, '.claude', 'worktrees', 'candidate');
        await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
        await writeFile(join(path, 'feature.txt'), 'delivered feature\n');
        await execGit(['add', 'feature.txt'], path); await execGit(['commit', '-m', 'delivered feature'], path);
        const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
        await execGit(['checkout', '-b', 'release', 'main'], repo);
        await execGit(['merge', '--no-ff', branch, '-m', 'merge delivered candidate'], repo);
        await execGit(['push', 'origin', 'main', 'release', branch], repo);
        const [merge, main] = (await execGit(['rev-parse', 'release', 'main'], repo)).stdout.trim().split(/\r?\n/);
        return { head, merge, main };
      });
      const path = join(repo, '.claude', 'worktrees', 'candidate');
      fixture.refs = { main, release: merge };
      fixture.pr = { url: 'https://github.com/example/repo/pull/42', state: 'MERGED', headRefName: branch,
        headRefOid: head, isCrossRepository: false, baseRefName: 'release', mergeCommit: { oid: merge } };
      fixture.detail = { head: { sha: head }, base: { ref: 'release' }, merged: true, merge_commit_sha: merge, commits: 401, changed_files: 501 };
      fixture.calls = []; fixture.owners = [];
      fixture.app = { id: 'app-exact', repoPath: repo };
      fixture.policies = [{ id: 'completed-original', status: 'completed', result: { success: true }, metadata: {
        workspacePath: repo, claimBranches: [branch], prCompletionPolicy: 'review-then-merge' } }];
      if (scenario.startsWith('precreation')) {
        const captured = await readCompletedCheckoutIdentity({ repoPath: repo, branch, path, head });
        const startedAt = new Date(Date.now() - 10_000).toISOString();
        const completedAt = new Date().toISOString();
        fixture.policies = [{ id: 'failed-before-creation', taskId: 'claim-task', status: 'completed',
          startedAt: '2000-01-01T00:00:00.000Z', completedAt: '2000-01-01T00:01:00.000Z',
          result: { success: false, executionSuccess: false, completionReason: 'paste-not-rendered',
            errorAnalysis: { category: 'startup-failure', origin: 'runner', completionReason: 'paste-not-rendered' } },
          metadata: { instanceId: 'fixture-instance', workspacePath: repo, isWorktree: false, configClaimFlow: true, claimBranch: branch,
            claimSelectionPending: true, claimPicksOwnBranch: false, prCompletionPolicy: 'merge-on-green' } },
        { id: 'completed-claim', taskId: 'claim-task', status: 'completed', startedAt, completedAt,
          result: { success: true, executionSuccess: true }, metadata: { instanceId: 'fixture-instance', workspacePath: repo,
            claimBranches: [branch], claimReleasedBranches: [], prCompletionPolicy: 'merge-on-green',
            completedCheckouts: [{ ...captured, version: 1, agentId: 'completed-claim', startedAt, capturedAt: completedAt }] } }];
        if (scenario === 'precreation-uncertain') fixture.policies[0].metadata.checkoutSeeds = [];
        if (scenario === 'precreation-late') fixture.policies[0].completedAt = new Date(Date.now() + 60_000).toISOString();
      }
      let retainedSibling = null;
      if (scenario.startsWith('named-sibling')) {
        retainedSibling = join(scratch, 'earlier-review');
        await execGit(['worktree', 'move', path, retainedSibling], repo);
        let capturedHead = head;
        if (scenario === 'named-sibling-unrelated') {
          const tree = (await execGit(['rev-parse', 'HEAD^{tree}'], retainedSibling)).stdout.trim();
          capturedHead = (await execGit(['commit-tree', tree, '-m', 'unrelated source history'], repo)).stdout.trim();
          await execGit(['reset', '--hard', capturedHead], retainedSibling);
        }
        const captured = await readCompletedCheckoutIdentity({ repoPath: repo, branch, path: retainedSibling, head: capturedHead });
        await execGit(['checkout', '--detach', capturedHead], retainedSibling);
        await execGit(['update-ref', `refs/heads/${branch}`, head, capturedHead], repo);
        await execGit(['worktree', 'add', path, branch], repo);
        await writeFile(join(retainedSibling, 'wanted-private.txt'), 'retain this other original checkout\n');
        fixture.policies = [{ id: 'earlier-review', taskId: 'old-review-task', status: 'completed',
          startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z',
          result: { success: false, executionSuccess: true, validationPassed: null }, metadata: {
            sourceWorkspace: repo, workspacePath: retainedSibling, worktreeBranch: branch,
            prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { url: fixture.pr.url, branch },
            completedCheckouts: [{ ...captured, version: 1, agentId: 'earlier-review',
              startedAt: '2026-01-01T00:00:00Z', capturedAt: '2026-01-01T00:00:01Z' }],
          } }];
      }
      if (scenario === 'same-task-seeded') {
        const captured = await readCompletedCheckoutIdentity({ repoPath: repo, branch, path, head });
        const identity = async target => {
          const stat = await lstat(target, { bigint: true });
          return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
        };
        const repository = await identity(repo), checkout = await identity(path);
        const makeOwner = (id, hour, unknown) => {
          const startedAt = `2026-01-01T0${hour}:00:00.000Z`;
          const seededAt = `2026-01-01T0${hour}:00:01.000Z`;
          const seed = { version: 1, agentId: id, startedAt, seededAt, repoPath: repo, branch, path,
            repository, checkout, incarnation: captured.incarnation };
          return { id, taskId: 'one-original-task', status: 'completed', startedAt,
            completedAt: `2026-01-01T0${hour}:01:00.000Z`,
            result: { success: false, executionSuccess: true, validationPassed: null, cleanupPending: true,
              taskOutcome: { recovery: { mode: 'cleanup' } } },
            metadata: { instanceId: 'fixture-instance', isWorktree: true, sourceWorkspace: repo,
              workspacePath: path, worktreeBranch: branch, prCompletionPolicy: 'review-then-merge',
              reviewLoopMergeTarget: { url: fixture.pr.url, branch }, checkoutSeeds: [seed],
              completionTaskDispatch: { taskId: 'one-original-task', taskType: 'internal', expected: [
                ['claimedBy', 'fixture-instance'], ['claimedAt', seededAt], ['lastSpawnedAt', seededAt], ['totalSpawnCount', 2]] },
              checkoutCapture: { status: unknown ? 'pending' : 'captured', unknown, targets: [] },
              completedCheckouts: unknown ? [] : [{ ...captured, version: 2, agentId: id, startedAt, seededAt,
                capturedAt: `2026-01-01T0${hour}:01:01.000Z` }] } };
        };
        fixture.policies = [makeOwner('unknown-original', 1, true), makeOwner('verified-successor', 2, false)];
      }
      fixture.schedulePath = join(scratch, 'schedule.json');
      await writeFile(fixture.schedulePath, JSON.stringify({ tasks: {}, executions: {} }));
      const release = { branch, path, head, locked: false, lockReason: null };
      if (scenario === 'unpublished') {
        await writeFile(join(path, 'wanted.txt'), 'unpublished wanted work\n');
        await execGit(['add', 'wanted.txt'], path); await execGit(['commit', '-m', 'unpublished continuation'], path);
        release.head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
      }
      if (scenario === 'wrong-head') fixture.detail.head.sha = fixture.pr.headRefOid = 'a'.repeat(40);
      if (scenario === 'wrong-base') fixture.detail.base.ref = 'main';
      if (scenario === 'wrong-target') fixture.refs.release = fixture.refs.main;
      if (scenario === 'wrong-merge-proof') fixture.detail.merge_commit_sha = fixture.refs.main;
      if (scenario === 'missing-object') fixture.pr.mergeCommit.oid = fixture.detail.merge_commit_sha = 'c'.repeat(40);
      if (['active', 'original-active', 'precreation-active'].includes(scenario)) fixture.owners = [{ id: 'active-owner', status: 'running', metadata: {
        isWorktree: true, sourceWorkspace: repo, workspacePath: path, worktreeBranch: branch } }];
      await recordBranchReconcileOutcome(fixture.app.id, { status: 'incomplete', remaining: [{ ...release, reason: 'pr-completion-review-required' }] });
      const opts = { cosDir: join(scratch, 'cos'), readAgents: async () => fixture.owners };
      await mkdir(opts.cosDir);
      const input = { appId: fixture.app.id, release, prUrl: fixture.pr.url,
        ...(scenario === 'supersession' && { kind: 'source-supersession' }) };
      if (scenario === 'same-task-seeded') {
        const original = structuredClone(fixture.policies);
        const mutations = [
          rows => { rows[0].metadata.instanceId = 'another-install'; },
          rows => { rows[0].completedAt = rows[1].completedAt; },
          rows => { rows[0].metadata.checkoutSeeds[0].checkout = { ...rows[0].metadata.checkoutSeeds[0].checkout, ino: '999999' }; },
          rows => { rows[1].metadata.completionTaskDispatch.expected[3][1] = 1; },
          rows => { rows[0].result.taskOutcome.recovery.mode = 'approval'; },
        ];
        for (const [mutationIndex, mutate] of mutations.entries()) {
          fixture.policies = structuredClone(original); mutate(fixture.policies);
          expect(await prepareInventoriedCheckoutRetirement(input, opts), `refusal mutation ${mutationIndex}`).toMatchObject({ ok: false,
            reason: 'retirement-policy-not-legacy-completed' });
          expect((await listWorktrees(repo)).some(tree => resolve(tree.path) === resolve(path))).toBe(true);
        }
        fixture.policies = original;
      }
      const prepared = await prepareInventoriedCheckoutRetirement(input, opts);
      if (['exact', 'named-sibling', 'same-task-seeded', 'precreation', 'precreation-dirty', 'precreation-untracked', 'remote-change', 'dirty'].includes(scenario)) {
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { forge: { scopeProof: 'exact-delivered-head' },
          comparison: { disposition: 'integrated', exactMergedDelivery: true } } });
        expect(fixture.calls.some(args => args.includes('--paginate'))).toBe(false);
        if (scenario === 'remote-change') await execGit(['update-ref', `refs/heads/${branch}`, merge, head], remote);
        if (['dirty', 'precreation-dirty'].includes(scenario)) await writeFile(join(path, 'feature.txt'), 'wanted local edit\n');
        if (scenario === 'precreation-untracked') await writeFile(join(path, 'wanted.txt'), 'wanted untracked work\n');
        const confirmation = { appId: fixture.app.id, release,
          review: { prUrl: fixture.pr.url, digest: prepared.review.digest, acceptSuperseded: false } };
        const retired = await retireInventoriedCheckout(confirmation, opts);
        if (['exact', 'named-sibling', 'same-task-seeded', 'precreation'].includes(scenario)) {
          expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
          const outcome = await getBranchReconcileOutcome(fixture.app.id);
          expect(outcome.retired).toEqual(expect.arrayContaining([expect.objectContaining({ path, branch, head, branchDeleted: true })]));
          expect((await listWorktrees(repo)).filter(tree => resolve(tree.path) === resolve(path))).toEqual([]);
          if (retainedSibling) {
            expect(await readFile(join(retainedSibling, 'wanted-private.txt'), 'utf8')).toBe('retain this other original checkout\n');
            expect((await listWorktrees(repo)).find(tree => resolve(tree.path) === resolve(retainedSibling))).toBeDefined();
            expect(fixture.policies[0].result.success).toBe(false);
          }
          if (scenario === 'precreation') expect(fixture.policies[0].result.success).toBe(false);
          return;
        }
        expect(retired).toMatchObject({ ok: false, reason: ['dirty', 'precreation-dirty', 'precreation-untracked'].includes(scenario) ? 'worktree-dirty' : 'retirement-remote-head-changed' });
      } else expect(prepared).toMatchObject({ ok: false, reason: ['active', 'precreation-active'].includes(scenario) ? 'claim-owner-active'
        : ['precreation-uncertain', 'precreation-late'].includes(scenario) ? 'retirement-policy-not-legacy-completed'
        : scenario === 'named-sibling-unrelated' ? 'retirement-policy-not-legacy-completed'
          : scenario === 'missing-object' ? 'retirement-proof-fetch-failed'
          : scenario === 'wrong-target' ? 'retirement-merge-not-in-target'
          : scenario === 'wrong-merge-proof' ? 'retirement-pr-not-matching-merged' : 'retirement-original-scope-unavailable' });
      expect((await execGit(['rev-parse', 'HEAD'], path)).stdout.trim()).toBe(release.head);
      expect((await listWorktrees(repo)).filter(tree => resolve(tree.path) === resolve(path)))
        .toMatchObject([{ branch: `refs/heads/${branch}`, head: release.head }]);
      expect((await getBranchReconcileOutcome(fixture.app.id)).retired || []).toEqual([]);
      if (scenario === 'unpublished') expect(await readFile(join(path, 'wanted.txt'), 'utf8')).toContain('wanted work');
      if (scenario === 'precreation-untracked') expect(await readFile(join(path, 'wanted.txt'), 'utf8')).toContain('wanted untracked work');
      if (['dirty', 'precreation-dirty'].includes(scenario)) expect(await readFile(join(path, 'feature.txt'), 'utf8')).toContain('wanted local edit');
    });
});

// Uniquely catches an older detached original whose commits were rewritten in
// its delivered PR: exact-SHA alias matching strands it despite all work landing.
describe('rewritten detached original retirement (real Git)', () => {
  it.each(['represented', 'unique-work', 'reverted', 'dirty', 'active', 'custom-driver', 'changed-after-review',
    'original-owner', 'original-wrong-generation', 'original-undelivered', 'original-active', 'original-approval', 'original-validation'])(
    'requires current complete delivery and preserves every existing gate: %s', async scenario => {
      const branch = 'delivery/candidate'; const originalOwner = scenario.startsWith('original-');
      const { repo, original } = await seededScratch('detached-delivery-', originalOwner ? 'owner' : 'cherry-picked', async ({ repo }) => {
        const path = join(repo, '.claude', 'worktrees', 'original');
        await execGit(['worktree', 'add', '-b', 'original', path, 'main'], repo);
        await writeFile(join(path, 'feature.txt'), 'delivered feature\n');
        await execGit(['add', 'feature.txt'], path); await execGit(['commit', '-m', 'original feature'], path);
        const original = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
        await execGit(['switch', '--detach', original], path);
        await execGit(['switch', '-c', branch, originalOwner ? original : 'main'], repo);
        await writeFile(join(repo, 'unrelated.txt'), 'later delivery context\n');
        await execGit(['add', 'unrelated.txt'], repo); await execGit(['commit', '-m', 'delivery context'], repo);
        if (!originalOwner) await execGit(['cherry-pick', original], repo);
        return { original };
      });
      const path = join(repo, '.claude', 'worktrees', 'original');
      if (scenario === 'reverted') await execGit(['revert', '--no-edit', 'HEAD'], repo);
      const delivered = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
      expect(delivered).not.toBe(original);
      await execGit(['switch', 'main'], repo); await execGit(['merge', '--no-ff', branch, '-m', 'merge delivery'], repo);
      await execGit(['push', 'origin', 'main', branch], repo);
      const merge = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
      fixture.refs = { main: merge }; fixture.calls = []; fixture.owners = [];
      fixture.pr = { url: 'https://github.com/example/repo/pull/42', state: 'MERGED', headRefName: branch,
        headRefOid: delivered, isCrossRepository: false, baseRefName: 'main', mergeCommit: { oid: merge } };
      fixture.detail = { head: { sha: delivered }, base: { ref: 'main' }, merged: true, merge_commit_sha: merge,
        commits: 401, changed_files: 501 };
      fixture.app = { id: 'app-detached', repoPath: repo };
      fixture.policies = [{ id: 'completed-original', status: 'completed', result: { success: true }, metadata: {
        workspacePath: repo, claimBranches: [branch], prCompletionPolicy: 'review-then-merge' } }];
      if (scenario === 'same-task-seeded') {
        const captured = await readCompletedCheckoutIdentity({ repoPath: repo, branch, path, head });
        const identity = async target => {
          const stat = await lstat(target, { bigint: true });
          return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
        };
        const repository = await identity(repo), checkout = await identity(path);
        const makeOwner = (id, hour, unknown) => {
          const startedAt = `2026-01-01T0${hour}:00:00.000Z`;
          const seededAt = `2026-01-01T0${hour}:00:01.000Z`;
          const seed = { version: 1, agentId: id, startedAt, seededAt, repoPath: repo, branch, path,
            repository, checkout, incarnation: captured.incarnation };
          return { id, taskId: 'one-original-task', status: 'completed', startedAt,
            completedAt: `2026-01-01T0${hour}:01:00.000Z`,
            result: { success: false, executionSuccess: true, validationPassed: null, cleanupPending: true,
              taskOutcome: { recovery: { mode: 'cleanup' } } },
            metadata: { instanceId: 'fixture-instance', isWorktree: true, sourceWorkspace: repo,
              workspacePath: path, worktreeBranch: branch, prCompletionPolicy: 'review-then-merge',
              reviewLoopMergeTarget: { url: fixture.pr.url, branch }, checkoutSeeds: [seed],
              completionTaskDispatch: { taskId: 'one-original-task', taskType: 'internal', expected: [
                ['claimedBy', 'fixture-instance'], ['claimedAt', seededAt], ['lastSpawnedAt', seededAt], ['totalSpawnCount', 2]] },
              checkoutCapture: { status: unknown ? 'pending' : 'captured', unknown, targets: [] },
              completedCheckouts: unknown ? [] : [{ ...captured, version: 2, agentId: id, startedAt, seededAt,
                capturedAt: `2026-01-01T0${hour}:01:01.000Z` }] } };
        };
        fixture.policies = [makeOwner('unknown-original', 1, true), makeOwner('verified-successor', 2, false)];
      }
      fixture.schedulePath = join(scratch, 'schedule.json');
      await writeFile(fixture.schedulePath, JSON.stringify({ tasks: {}, executions: {} }));
      if (scenario === 'unique-work' || scenario === 'original-undelivered') {
        await writeFile(join(path, 'wanted.txt'), 'undelivered original work\n');
        await execGit(['add', 'wanted.txt'], path); await execGit(['commit', '-m', 'wanted continuation'], path);
      }
      if (scenario === 'dirty') await writeFile(join(path, 'feature.txt'), 'wanted dirty edit\n');
      if (scenario === 'active' || scenario === 'original-active') fixture.owners = [{ id: 'live', status: 'running', metadata: {
        isWorktree: true, sourceWorkspace: repo, workspacePath: path } }];
      if (scenario === 'custom-driver') await execGit(['config', 'merge.custom.driver', 'exit 0'], repo);
      const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
      if (originalOwner) {
        await execGit(['switch', '-C', 'captured-original', head], path);
        const capture = await readCompletedCheckoutIdentity({ repoPath: repo, branch: 'captured-original', path, head });
        expect(capture).not.toBeNull();
        capture.branch = branch;
        await execGit(['switch', '--detach', head], path);
        const makeOwner = (id, hour, workspacePath, resumedFromAgentId = null) => ({ id,
          taskId: 'same-original-task', status: 'completed', startedAt: `2026-01-01T0${hour}:00:00Z`,
          completedAt: `2026-01-01T0${hour}:02:00Z`, result: { success: false, executionSuccess: true,
            validationPassed: null, taskOutcome: { status: 'blocked', reason: 'CI was incomplete at execution end' } },
          metadata: { instanceId: 'fixture-instance', isWorktree: true, sourceWorkspace: repo, workspacePath,
            worktreeBranch: branch, prCompletionPolicy: 'review-then-merge', resumedFromAgentId,
            reviewLoopMergeTarget: { url: fixture.pr.url, branch },
            completedCheckouts: [{ ...capture, version: 1, agentId: id, path: workspacePath,
              startedAt: `2026-01-01T0${hour}:00:00Z`, capturedAt: `2026-01-01T0${hour}:01:00Z` }] } });
        const older = makeOwner('original-parent', 1, join(repo, '.claude', 'worktrees', 'old-original'));
        const current = makeOwner('original-current', 2, path, older.id);
        if (scenario === 'original-wrong-generation') older.metadata.completedCheckouts[0].incarnation = {
          ...capture.incarnation, pointer: { ...capture.incarnation.pointer, ino: '999999999' } };
        if (scenario === 'original-approval') current.result.taskOutcome.recovery = { mode: 'approval' };
        if (scenario === 'original-validation') current.result.validationPassed = false;
        fixture.policies = [older, current];
      }
      const release = { branch: null, path, head, locked: false, lockReason: null };
      await recordBranchReconcileOutcome(fixture.app.id, { status: 'incomplete', remaining: [{ ...release, reason: 'worktree-unmanaged-location' }] });
      const opts = { cosDir: join(scratch, 'cos'), readAgents: async () => fixture.owners }; await mkdir(opts.cosDir);
      const prepared = await prepareInventoriedCheckoutRetirement({ appId: fixture.app.id, release, prUrl: fixture.pr.url }, opts);
      if (!['represented', 'dirty', 'changed-after-review', 'original-owner'].includes(scenario)) {
        expect(prepared.ok, JSON.stringify(prepared)).toBe(false);
        expect((await listWorktrees(repo)).some(row => resolve(row.path) === resolve(path))).toBe(true);
        return;
      }
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: {
        comparison: { disposition: 'integrated', exactMergedDelivery: false, representedDetachedDelivery: true },
        forge: { detachedRepresentation: { sourceHead: original, deliveredHead: delivered } },
      } });
      if (scenario === 'changed-after-review') await writeFile(join(path, 'feature.txt'), 'new local work after review\n');
      const retired = await retireInventoriedCheckout({ appId: fixture.app.id, release,
        review: { prUrl: fixture.pr.url, digest: prepared.review.digest, acceptSuperseded: false } }, opts);
      if (['dirty', 'changed-after-review'].includes(scenario)) {
        expect(retired.ok).toBe(false);
        expect((await listWorktrees(repo)).some(row => resolve(row.path) === resolve(path))).toBe(true);
        return;
      }
      expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: false });
      expect((await listWorktrees(repo)).some(row => resolve(row.path) === resolve(path))).toBe(false);
      const outcome = await getBranchReconcileOutcome(fixture.app.id);
      expect(outcome.remaining.some(row => row.path === path)).toBe(false);
      expect(outcome.retired).toEqual(expect.arrayContaining([expect.objectContaining({ path, head, checkoutOnly: true, branchDeleted: false })]));
      expect((await execGit(['rev-parse', branch], repo)).stdout.trim()).toBe(delivered);
      if (originalOwner) expect(fixture.policies.map(agent => agent.result)).toEqual([
        expect.objectContaining({ success: false, taskOutcome: { status: 'blocked', reason: 'CI was incomplete at execution end' } }),
        expect.objectContaining({ success: false, taskOutcome: { status: 'blocked', reason: 'CI was incomplete at execution end' } }),
      ]);
    });
});

// A completed retry may deliberately replace a small captured draft. Its exact
// source remains recoverable without keeping a checkout or archiving a repository.
describe('bounded source preservation retirement (real Git)', () => {
  it.each(['preserved', 'wrong-generation', 'active-owner', 'wrong-ref', 'symbolic-ref', 'changed-ref', 'deleted-ref', 'over-budget',
    'private-prototype', 'private-open', 'private-remote-changed', 'private-changed-ref', 'private-deleted-ref', 'private-large-source',
    'private-active', 'private-content-over-budget', 'private-extra-root', 'private-extra-ref-change', 'private-missing-source-object',
    'private-noncommit-root', 'private-ancestor-history'])(
    'binds exact retained source and existing safety gates: %s', async scenario => {
      const { repo, base } = await seededScratch('retained-source-', 'base', async ({ repo }) => {
        await writeFile(join(repo, 'options.txt'), 'base\n');
        await execGit(['add', 'options.txt'], repo); await execGit(['commit', '-m', 'shared base'], repo);
        return { base: (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim() };
      });
      const branch = 'delivery/candidate', originalPath = join(scratch, 'original'), path = join(scratch, 'resumed');
      await execGit(['worktree', 'add', '-b', branch, originalPath, 'main'], repo);
      const originalBytes = ['over-budget', 'private-large-source'].includes(scenario) ? `${'bounded draft evidence '.repeat(4000)}\n`
        : scenario === 'private-ancestor-history' ? `${'bounded draft evidence '.repeat(1700)}\n` : 'original captured draft\n';
      await writeFile(join(originalPath, 'options.txt'), originalBytes);
      await execGit(['add', 'options.txt'], originalPath); await execGit(['commit', '-m', 'captured draft'], originalPath);
      if (scenario === 'private-ancestor-history') {
        await writeFile(join(originalPath, 'later.txt'), 'small follow-up\n');
        await execGit(['add', 'later.txt'], originalPath); await execGit(['commit', '-m', 'later draft'], originalPath);
      }
      const sourceHead = (await execGit(['rev-parse', 'HEAD'], originalPath)).stdout.trim();
      const capturedSource = await readCompletedCheckoutIdentity({ repoPath: repo, branch, path: originalPath, head: sourceHead });
      await execGit(['worktree', 'move', originalPath, path], repo);
      await execGit(['reset', '--hard', base], path);
      await writeFile(join(path, 'options.txt'), 'delivered replacement\n');
      await execGit(['add', 'options.txt'], path); await execGit(['commit', '-m', 'delivered revision'], path);
      const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
      const capturedCurrent = await readCompletedCheckoutIdentity({ repoPath: repo, branch, path, head });
      await execGit(['merge', '--no-ff', branch, '-m', 'merge delivery'], repo);
      const merge = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
      await execGit(['push', 'origin', 'main', branch], repo);
      fixture.refs = { main: merge }; fixture.calls = []; fixture.owners = [];
      fixture.pr = { url: 'https://github.com/example/repo/pull/42', state: 'MERGED', headRefName: branch,
        headRefOid: head, isCrossRepository: false, baseRefName: 'main', mergeCommit: { oid: merge } };
      fixture.detail = { head: { sha: head }, base: { ref: 'main' }, merged: true, merge_commit_sha: merge, commits: 401, changed_files: 501 };
      fixture.app = { id: 'app-retained-source', repoPath: repo };
      const owner = (id, hour, capture, resumedFromAgentId = null) => ({ id, taskId: 'one-resumed-task', status: 'completed',
        startedAt: `2026-01-01T0${hour}:00:00Z`, completedAt: `2026-01-01T0${hour}:02:00Z`,
        result: { success: false, executionSuccess: true, validationPassed: null,
          ...(resumedFromAgentId ? { cleanupPending: true, taskOutcome: { recovery: { mode: 'cleanup' } } }
            : { taskOutcome: { status: 'blocked', reason: 'earlier draft was not delivered' } }) },
        metadata: { instanceId: 'fixture-instance', isWorktree: true, sourceWorkspace: repo, workspacePath: capture.path,
          worktreeBranch: branch, prCompletionPolicy: 'review-then-merge', resumedFromAgentId,
          reviewLoopMergeTarget: { url: fixture.pr.url, branch },
          completedCheckouts: [{ ...capture, version: 1, agentId: id,
            startedAt: `2026-01-01T0${hour}:00:00Z`, capturedAt: `2026-01-01T0${hour}:01:00Z` }] } });
      const earlier = owner('earlier-draft', 1, capturedSource), current = owner('delivered-current', 2, capturedCurrent, earlier.id);
      if (scenario === 'wrong-generation') earlier.metadata.completedCheckouts[0].incarnation = {
        ...capturedSource.incarnation, pointer: { ...capturedSource.incarnation.pointer, ino: '999999999' } };
      fixture.policies = [earlier, current];
      if (scenario === 'active-owner') fixture.owners = [{ id: 'live', status: 'running', metadata: {
        isWorktree: true, sourceWorkspace: repo, workspacePath: path } }];
      const retainedRef = `refs/portos/retained-checkout-source/${sourceHead}`;
      if (scenario === 'wrong-ref') await execGit(['update-ref', retainedRef, head], repo);
      if (scenario === 'symbolic-ref') await execGit(['symbolic-ref', retainedRef, 'refs/heads/unrelated-missing-source'], repo);
      fixture.schedulePath = join(scratch, 'schedule.json');
      await writeFile(fixture.schedulePath, JSON.stringify({ tasks: {}, executions: {} }));
      const privatePrototype = scenario.startsWith('private-');
      const release = { branch, path, head, locked: false, lockReason: null };
      const evidenceBytes = Buffer.from('small private prototype evidence\n');
      let extraRootHead;
      if (privatePrototype) {
        await execGit(['worktree', 'move', path, join(scratch, 'delivered-copy')], repo);
        release.branch = 'private/prototype'; release.head = sourceHead;
        await execGit(['worktree', 'add', '-b', release.branch, path, sourceHead], repo);
        if (scenario === 'private-ancestor-history') {
          const parent = (await execGit(['rev-parse', `${sourceHead}^`], repo)).stdout.trim();
          const gitdir = (await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim();
          await writeFile(join(gitdir, 'ORIG_HEAD'), `${parent}\n`);
        }
        fixture.policies = []; fixture.detail.privateSourceBase = base; fixture.detail.commits = 1; fixture.detail.changed_files = 1;
        if (scenario === 'private-open') fixture.detail.openPrivateSource = true;
        if (scenario === 'private-remote-changed') await execGit(['push', 'origin', `${head}:refs/heads/${release.branch}`], repo);
        if (scenario === 'private-active') fixture.owners = [{ id: 'live', status: 'running', metadata: {
          isWorktree: true, sourceWorkspace: repo, workspacePath: path } }];
        await writeFile(join(repo, '.git', 'info', 'exclude'), 'private-evidence.txt\n');
        await writeFile(join(path, 'private-evidence.txt'), scenario === 'private-content-over-budget'
          ? Buffer.alloc(64 * 1024 + 1) : evidenceBytes);
        if (['private-extra-root', 'private-extra-ref-change', 'private-large-source', 'private-noncommit-root'].includes(scenario)) {
          extraRootHead = scenario === 'private-noncommit-root'
            ? (await execGit(['rev-parse', `${sourceHead}:options.txt`], repo)).stdout.trim()
            : (await execGit(['commit-tree', `${sourceHead}^{tree}`, '-p', base, '-m', 'preserve exact private source metadata'], repo)).stdout.trim();
          const gitdir = (await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim();
          await writeFile(join(gitdir, 'ORIG_HEAD'), `${extraRootHead}\n`);
        }
        if (scenario === 'private-missing-source-object') {
          const blob = (await execGit(['rev-parse', `${sourceHead}:options.txt`], repo)).stdout.trim();
          await rm(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
        }
      }
      const kind = privatePrototype ? 'preserved-supersession' : undefined;
      await recordBranchReconcileOutcome(fixture.app.id, { status: 'incomplete', remaining: [{ ...release, reason: 'worktree-unmanaged-location' }] });
      const opts = { cosDir: join(scratch, 'cos'), readAgents: async () => fixture.owners }; await mkdir(opts.cosDir);
      const prepared = await prepareInventoriedCheckoutRetirement({ appId: fixture.app.id, release, prUrl: fixture.pr.url, kind }, opts);
      if (!['preserved', 'changed-ref', 'deleted-ref', 'private-prototype', 'private-changed-ref', 'private-deleted-ref', 'private-extra-root', 'private-extra-ref-change', 'private-ancestor-history', 'private-large-source'].includes(scenario)) {
        expect(prepared.ok, JSON.stringify(prepared)).toBe(false);
        expect((await listWorktrees(repo)).some(row => resolve(row.path) === path)).toBe(true);
        return;
      }
      if (privatePrototype) expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: {
        kind, preservedSource: { kind: 'private-retained-source', head: sourceHead, privateProof: {
          version: 2, retainedRef, retainedHead: sourceHead,
          sourceTree: (await execGit(['rev-parse', `${sourceHead}^{tree}`], repo)).stdout.trim() } } } });
      else expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { policy: { policies: expect.arrayContaining([
        expect.objectContaining({ id: earlier.id, success: false, resumedCleanup: { sourcePreservation: {
          sourceHead, base, retainedRef, retainedHead: sourceHead, sourceCommits: 1,
          deltaBytes: expect.any(Number), deltaSha256: expect.stringMatching(/^[a-f0-9]{64}$/), targetHead: merge },
          successorAgentId: current.id, taskId: current.taskId, checkoutIncarnation: capturedCurrent.incarnation } }),
        expect.objectContaining({ id: current.id, success: false }),
      ]) } } });
      const replay = await prepareInventoriedCheckoutRetirement({ appId: fixture.app.id, release, prUrl: fixture.pr.url, kind }, opts);
      expect(replay.review.digest).toBe(prepared.review.digest);
      if (['changed-ref', 'private-changed-ref'].includes(scenario)) await execGit(['update-ref', retainedRef, head, sourceHead], repo);
      if (scenario === 'private-extra-ref-change') await execGit(['update-ref', `refs/portos/retained-checkout-source/${extraRootHead}`, head, extraRootHead], repo);
      if (['deleted-ref', 'private-deleted-ref'].includes(scenario)) await execGit(['update-ref', '-d', retainedRef, sourceHead], repo);
      const retired = await retireInventoriedCheckout({ appId: fixture.app.id, release,
        review: { prUrl: fixture.pr.url, digest: prepared.review.digest, kind, acceptSuperseded: privatePrototype } }, opts);
      const retiredExpected = ['preserved', 'private-prototype', 'private-extra-root', 'private-ancestor-history', 'private-large-source'].includes(scenario);
      expect(retired.ok, JSON.stringify(retired)).toBe(retiredExpected);
      expect((await listWorktrees(repo)).some(row => resolve(row.path) === path)).toBe(!retiredExpected);
      if (['deleted-ref', 'private-deleted-ref'].includes(scenario)) expect((await execGit(['show-ref', '--verify', '--quiet', retainedRef], repo,
        { ignoreExitCode: true })).exitCode).toBe(1);
      if (retiredExpected) {
        expect((await execGit(['show-ref', '--verify', '--hash', retainedRef], repo)).stdout.trim()).toBe(sourceHead);
        expect((await execGit(['show', `${retainedRef}:options.txt`], repo)).stdout).toBe(originalBytes);
        expect(earlier.result).toMatchObject({ success: false, taskOutcome: { status: 'blocked' } });
        if (privatePrototype) {
          expect(retired.branchDeleted).toBe(true);
          expect((await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${release.branch}`], repo,
            { ignoreExitCode: true })).exitCode).toBe(1);
          const saved = (await getBranchReconcileOutcome(fixture.app.id)).supersededSourceEvidence[prepared.review.digest];
          const evidence = saved.proof.source.files.find(file => file.scope === 'content' && file.path === 'private-evidence.txt');
          expect(Buffer.from(evidence.data, 'base64')).toEqual(evidenceBytes);
          if (scenario === 'private-ancestor-history') {
            const parent = (await execGit(['rev-parse', `${sourceHead}^`], repo)).stdout.trim();
            expect((await execGit(['show', `${parent}:options.txt`], repo)).stdout).toBe(originalBytes);
            expect(saved.proof.source.privateRecoveryProofs).toContainEqual(expect.objectContaining({
              sourceHead: parent, retainedRef, retainedHead: sourceHead, sourceReachableFrom: sourceHead, deltaBytes: 0,
            }));
          }
          if (extraRootHead) {
            const rootProof = saved.proof.source.privateRecoveryProofs.find(proof => proof.sourceHead === extraRootHead);
            expect(rootProof).toMatchObject({ retainedHead: extraRootHead });
            expect((await execGit(['show', `${rootProof.retainedRef}:options.txt`], repo)).stdout).toBe(originalBytes);
            expect((await execGit(['show-ref', '--verify', '--hash', rootProof.retainedRef], repo)).stdout.trim()).toBe(extraRootHead);
          }
        }
      }
    });
});
