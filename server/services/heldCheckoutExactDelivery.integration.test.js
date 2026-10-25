/** Capped forge scope must not strand an exact delivered clean checkout. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { materializeGitRepo } from '../lib/gitTestRepo.js';
import { execGit } from '../lib/execGit.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
const fixture = vi.hoisted(() => ({ app: null, policies: [], owners: [], schedulePath: null, pr: null, detail: null, refs: {}, calls: [], remote: null }));
vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('exact-delivery-state-') }));
vi.mock('./cos.js', () => ({}));
vi.mock('../lib/execGit.js', async original => {
  const actual = await original();
  return { ...actual, execGit: (args, cwd, options) => actual.execGit(
    args.includes('fetch') ? args.map(arg => arg === 'https://github.com/example/repo.git' ? fixture.remote : arg) : args, cwd, options) };
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
const { prepareInventoriedCheckoutRetirement, retireInventoriedCheckout, inspectCheckoutRetirementOwnership } = await import('./heldCheckoutRecovery.js');
const { _createInitializedCheckoutRecovery } = await import('./initializedCheckoutRecovery.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./taskSchedule.js');
afterAll(cleanupTempDataRoots);
let scratch;
afterEach(async () => { if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); });

describe('exact delivered head retirement with capped historical API (real Git)', () => {
  it.each(['exact', 'exact-initialized', 'wrong-head', 'unpublished', 'wrong-base', 'wrong-target', 'wrong-merge-proof', 'missing-object', 'remote-change', 'dirty', 'active', 'supersession'])(
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
      const prepared = scenario === 'exact-initialized' ? await initialized.review(input)
        : await prepareInventoriedCheckoutRetirement(input, opts);
      if (['exact', 'exact-initialized', 'remote-change', 'dirty'].includes(scenario)) {
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { forge: { scopeProof: 'exact-delivered-head' },
          comparison: { disposition: 'integrated', exactMergedDelivery: true } } });
        expect(fixture.calls.some(args => args.includes('--paginate'))).toBe(false);
        if (scenario === 'remote-change') await execGit(['update-ref', `refs/heads/${branch}`, merge, head], remote);
        if (scenario === 'dirty') await writeFile(join(path, 'feature.txt'), 'wanted local edit\n');
        const confirmation = { appId: fixture.app.id, release,
          review: { prUrl: fixture.pr.url, digest: prepared.review.digest, acceptSuperseded: false } };
        const retired = scenario === 'exact-initialized' ? await initialized.retire(confirmation) : await retireInventoriedCheckout(confirmation, opts);
        if (scenario === 'exact' || scenario === 'exact-initialized') {
          expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
          const outcome = await getBranchReconcileOutcome(fixture.app.id);
          expect(outcome.retired).toEqual(expect.arrayContaining([expect.objectContaining({ path, branch, head, branchDeleted: true })]));
          expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout).not.toContain(path);
          return;
        }
        expect(retired).toMatchObject({ ok: false, reason: scenario === 'dirty' ? 'worktree-dirty' : 'retirement-remote-head-changed' });
      } else expect(prepared).toMatchObject({ ok: false, reason: scenario === 'active' ? 'claim-owner-active'
        : scenario === 'missing-object' ? 'retirement-proof-fetch-failed'
          : scenario === 'wrong-target' ? 'retirement-merge-not-in-target'
          : scenario === 'wrong-merge-proof' ? 'retirement-pr-not-matching-merged' : 'retirement-original-scope-unavailable' });
      expect((await execGit(['rev-parse', 'HEAD'], path)).stdout.trim()).toBe(release.head);
      expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout).toContain(path);
      expect((await getBranchReconcileOutcome(fixture.app.id)).retired || []).toEqual([]);
      if (scenario === 'unpublished') expect(await readFile(join(path, 'wanted.txt'), 'utf8')).toContain('wanted work');
      if (scenario === 'dirty') expect(await readFile(join(path, 'feature.txt'), 'utf8')).toContain('wanted local edit');
    });
});
