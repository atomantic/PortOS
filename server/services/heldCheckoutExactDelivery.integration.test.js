/** Capped forge scope must not strand an exact delivered clean checkout. */
import { afterAll, afterEach, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
  if (path.includes('/pulls?')) return '[]';
  if (path.includes('/git/ref/heads/')) return JSON.stringify({ object: { sha: fixture.refs[decodeURIComponent(path.split('/heads/')[1])] } });
  throw new Error('Historical capped scope must not be enumerated');
} }));
vi.mock('./branchCompletionPolicy.js', async original => ({ ...await original(), readBranchCompletionPolicies: async () => fixture.policies }));
vi.mock('./taskScheduleStore.js', () => ({
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
const { prepareInventoriedCheckoutRetirement, retireInventoriedCheckout, inspectCheckoutRetirementOwnership } = await import('./heldCheckoutRecovery.js');
const { _createInitializedCheckoutRecovery } = await import('./initializedCheckoutRecovery.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./taskSchedule.js');
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

describe('exact delivered head retirement with capped historical API (real Git)', () => {
  it.each(['exact', 'exact-initialized', 'named-sibling', 'named-sibling-unrelated', 'same-task-seeded', 'wrong-head', 'unpublished', 'wrong-base', 'wrong-target', 'wrong-merge-proof', 'missing-object', 'remote-change', 'dirty', 'active', 'supersession'])(
    'retains all existing retirement gates: %s', async scenario => {
      scratch = await realpath(await mkdtemp(join(tmpdir(), 'exact-delivery-')));
      const repo = join(scratch, 'repo'); await materializeGitRepo(repo);
      const remote = fixture.remote = join(scratch, 'origin.git'); await execGit(['init', '--bare', remote], scratch);
      await execGit(['remote', 'add', 'origin', remote], repo);
      const branch = 'delivery/candidate'; const path = join(repo, '.claude', 'worktrees', 'candidate');
      await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
      await writeFile(join(path, 'feature.txt'), 'delivered feature\n');
      await execGit(['add', 'feature.txt'], path); await execGit(['commit', '-m', 'delivered feature'], path);
      const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
      await execGit(['checkout', '-b', 'release', 'main'], repo);
      await execGit(['merge', '--no-ff', branch, '-m', 'merge delivered candidate'], repo);
      await execGit(['push', 'origin', 'main', 'release', branch], repo);
      const merge = (await execGit(['rev-parse', 'release'], repo)).stdout.trim();
      fixture.refs = { main: (await execGit(['rev-parse', 'main'], repo)).stdout.trim(), release: merge };
      fixture.pr = { url: 'https://github.com/example/repo/pull/42', state: 'MERGED', headRefName: branch,
        headRefOid: head, isCrossRepository: false, baseRefName: 'release', mergeCommit: { oid: merge } };
      fixture.detail = { head: { sha: head }, base: { ref: 'release' }, merged: true, merge_commit_sha: merge, commits: 401, changed_files: 501 };
      fixture.calls = []; fixture.owners = [];
      fixture.app = { id: 'app-exact', repoPath: repo };
      fixture.policies = [{ id: 'completed-original', status: 'completed', result: { success: true }, metadata: {
        workspacePath: repo, claimBranches: [branch], prCompletionPolicy: 'review-then-merge' } }];
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
      if (scenario === 'active') fixture.owners = [{ id: 'active-owner', status: 'running', metadata: {
        isWorktree: true, sourceWorkspace: repo, workspacePath: path, worktreeBranch: branch } }];
      await recordBranchReconcileOutcome(fixture.app.id, { status: 'incomplete', remaining: [{ ...release, reason: 'pr-completion-review-required' }] });
      const opts = { cosDir: join(scratch, 'cos'), readAgents: async () => fixture.owners };
      await mkdir(opts.cosDir);
      const initialized = _createInitializedCheckoutRecovery({
        ownership: input => inspectCheckoutRetirementOwnership(input, opts),
        native: async input => {
          if (input.command !== 'inspect') throw new Error('Unexpected native operation');
          const digest = bytes => createHash('sha256').update(bytes).digest('hex');
          return { fingerprint: digest(await readFile(join(path, 'feature.txt'))),
            administrationFingerprint: digest(await readFile(join(path, '.git'))) };
        },
      });
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
      const prepared = scenario === 'exact-initialized' ? await initialized.review(input)
        : await prepareInventoriedCheckoutRetirement(input, opts);
      if (['exact', 'exact-initialized', 'named-sibling', 'same-task-seeded', 'remote-change', 'dirty'].includes(scenario)) {
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { forge: { scopeProof: 'exact-delivered-head' },
          comparison: { disposition: 'integrated', exactMergedDelivery: true } } });
        expect(fixture.calls.some(args => args.includes('--paginate'))).toBe(false);
        if (scenario === 'remote-change') await execGit(['update-ref', `refs/heads/${branch}`, merge, head], remote);
        if (scenario === 'dirty') await writeFile(join(path, 'feature.txt'), 'wanted local edit\n');
        const confirmation = { appId: fixture.app.id, release,
          review: { prUrl: fixture.pr.url, digest: prepared.review.digest, acceptSuperseded: false } };
        const retired = scenario === 'exact-initialized' ? await initialized.retire(confirmation) : await retireInventoriedCheckout(confirmation, opts);
        if (['exact', 'exact-initialized', 'named-sibling', 'same-task-seeded'].includes(scenario)) {
          expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
          const outcome = await getBranchReconcileOutcome(fixture.app.id);
          expect(outcome.retired).toEqual(expect.arrayContaining([expect.objectContaining({ path, branch, head, branchDeleted: true })]));
          expect((await listWorktrees(repo)).filter(tree => resolve(tree.path) === resolve(path))).toEqual([]);
          if (retainedSibling) {
            expect(await readFile(join(retainedSibling, 'wanted-private.txt'), 'utf8')).toBe('retain this other original checkout\n');
            expect((await listWorktrees(repo)).find(tree => resolve(tree.path) === resolve(retainedSibling))).toBeDefined();
            expect(fixture.policies[0].result.success).toBe(false);
          }
          return;
        }
        expect(retired).toMatchObject({ ok: false, reason: scenario === 'dirty' ? 'worktree-dirty' : 'retirement-remote-head-changed' });
      } else expect(prepared).toMatchObject({ ok: false, reason: scenario === 'active' ? 'claim-owner-active'
        : scenario === 'named-sibling-unrelated' ? 'retirement-policy-not-legacy-completed'
          : scenario === 'missing-object' ? 'retirement-proof-fetch-failed'
          : scenario === 'wrong-target' ? 'retirement-merge-not-in-target'
          : scenario === 'wrong-merge-proof' ? 'retirement-pr-not-matching-merged' : 'retirement-original-scope-unavailable' });
      expect((await execGit(['rev-parse', 'HEAD'], path)).stdout.trim()).toBe(release.head);
      expect((await listWorktrees(repo)).filter(tree => resolve(tree.path) === resolve(path)))
        .toMatchObject([{ branch: `refs/heads/${branch}`, head: release.head }]);
      expect((await getBranchReconcileOutcome(fixture.app.id)).retired || []).toEqual([]);
      if (scenario === 'unpublished') expect(await readFile(join(path, 'wanted.txt'), 'utf8')).toContain('wanted work');
      if (scenario === 'dirty') expect(await readFile(join(path, 'feature.txt'), 'utf8')).toContain('wanted local edit');
    });
});

// Uniquely catches an older detached original whose commits were rewritten in
// its delivered PR: exact-SHA alias matching strands it despite all work landing.
describe('rewritten detached original retirement (real Git)', () => {
  it.each(['represented', 'unique-work', 'reverted', 'dirty', 'active', 'custom-driver', 'changed-after-review'])(
    'requires current complete delivery and preserves every existing gate: %s', async scenario => {
      scratch = await realpath(await mkdtemp(join(tmpdir(), 'detached-delivery-')));
      const repo = join(scratch, 'repo'); await materializeGitRepo(repo);
      const remote = fixture.remote = join(scratch, 'origin.git'); await execGit(['init', '--bare', remote], scratch);
      await execGit(['remote', 'add', 'origin', remote], repo);
      const branch = 'delivery/candidate'; const path = join(repo, '.claude', 'worktrees', 'original');
      await execGit(['worktree', 'add', '-b', 'original', path, 'main'], repo);
      await writeFile(join(path, 'feature.txt'), 'delivered feature\n');
      await execGit(['add', 'feature.txt'], path); await execGit(['commit', '-m', 'original feature'], path);
      const original = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
      await execGit(['switch', '--detach', original], path);
      await execGit(['switch', '-c', branch, 'main'], repo);
      await writeFile(join(repo, 'unrelated.txt'), 'later delivery context\n');
      await execGit(['add', 'unrelated.txt'], repo); await execGit(['commit', '-m', 'delivery context'], repo);
      await execGit(['cherry-pick', original], repo);
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
      if (scenario === 'unique-work') {
        await writeFile(join(path, 'wanted.txt'), 'undelivered original work\n');
        await execGit(['add', 'wanted.txt'], path); await execGit(['commit', '-m', 'wanted continuation'], path);
      }
      if (scenario === 'dirty') await writeFile(join(path, 'feature.txt'), 'wanted dirty edit\n');
      if (scenario === 'active') fixture.owners = [{ id: 'live', status: 'running', metadata: {
        isWorktree: true, sourceWorkspace: repo, workspacePath: path } }];
      if (scenario === 'custom-driver') await execGit(['config', 'merge.custom.driver', 'exit 0'], repo);
      const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
      const release = { branch: null, path, head, locked: false, lockReason: null };
      await recordBranchReconcileOutcome(fixture.app.id, { status: 'incomplete', remaining: [{ ...release, reason: 'worktree-unmanaged-location' }] });
      const opts = { cosDir: join(scratch, 'cos'), readAgents: async () => fixture.owners }; await mkdir(opts.cosDir);
      const prepared = await prepareInventoriedCheckoutRetirement({ appId: fixture.app.id, release, prUrl: fixture.pr.url }, opts);
      if (!['represented', 'dirty', 'changed-after-review'].includes(scenario)) {
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
    });
});
