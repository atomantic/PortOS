/**
 * Retirement of held checkouts through real Git (#12002, #16016): a release
 * binds to the exact inventory row. A merged checkout is removed in place, its
 * uncommitted files too when its PR merged at the exact head. Unmerged work,
 * live owners and manual handoffs stay, and nothing is copied.
 *
 * Each case here is one real-Git contract per outcome or destructive refusal.
 * The hold/retire permutations behind them are decided over inspected state in
 * branchRetirementDecision.test.js (#16153); add a new permutation there.
 */
import { describe, expect, it as unitIt, vi } from 'vitest';
// Load the factories before any import below resolves a mocked module.
import { mockBranchCompletionPolicy, mockExecGit, mockPaths, mockTaskScheduleStore, injected, retirementFaults, SYMLINKS } from './_heldCheckoutRecoveryMocks.js';
import { appendFile, lstat, mkdir, readlink, symlink, writeFile, readFile, utimes } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { execGit } from '../lib/execGit.js';
import { PATHS } from '../lib/paths.js';

vi.mock('../lib/paths.js', async importOriginal => mockPaths(await importOriginal()));
vi.mock('../lib/execGit.js', async importOriginal => mockExecGit(await importOriginal()));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ env: { ...process.env, GH_TOKEN: 'synthetic-account-token' } }) }));
vi.mock('./branchCompletionPolicy.js', async importOriginal => mockBranchCompletionPolicy(await importOriginal()));
vi.mock('./taskScheduleStore.js', async importOriginal => mockTaskScheduleStore(await importOriginal()));
// The forge has no PR for an operator release; a receipt's merged-PR read
// answers with `forge.delivery`.
const forge = vi.hoisted(() => ({ delivery: null }));
vi.mock('./forgeAuth.js', async importOriginal => ({ ...await importOriginal(), resolveForgeForRepo: async () => ({ cli: 'gh', env: null }) }));
vi.mock('./prProbe.js', async importOriginal => ({ ...await importOriginal(),
  isMergedPrHead: async () => false,
  probePrForBranch: async () => ({ readable: true, cli: 'gh', prState: null, prHead: null, prUrl: null }) }));
vi.mock('./mergedPrEvidence.js', () => ({ readMergedPrDelivery: async () => forge.delivery }));
vi.mock('./apps.js', () => ({ getAppById: async (id) => (injected.app?.id === id ? injected.app : null) }));
// lsof is absent on some CI hosts and fails closed there; no process sits in these checkouts.
vi.mock('../lib/processCwdProbe.js', () => ({ probeProcessCwdInside: async () => false, hasProcessCwdInside: async () => false }));

import { describeHeldCheckoutRecovery, it, beforeEach, scratch, repo, external, noOwners, heldCheckout, mergedCheckout, registered, lockText, retire, makeClean } from './_heldCheckoutRecoveryFixture.js';
const { retireInventoriedCheckout, retirePendingMergeCheckout, retireCompletedCheckouts } = await import('./heldCheckoutRecovery.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome, getBranchReconcileInventory } = await import('./branchReconcileOutcome.js');

describeHeldCheckoutRecovery(() => {
  beforeEach(() => {
    forge.delivery = null;
  });

  it('retires a pending-merge receipt checkout with an initialized submodule at its exact merged head, uncommitted files included', async () => {
    const branch = 'feature/submodule-delivery';
    const path = join(external, 'submodule-delivery');
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    const base = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    await execGit(['update-index', '--add', '--cacheinfo', `160000,${base},vendor`], path);
    await writeFile(join(path, '.gitmodules'), '[submodule "vendor"]\n\tpath = vendor\n\turl = ./fixture-vendor\n');
    await execGit(['add', '.gitmodules'], path);
    await execGit(['commit', '-m', 'feat: vendored submodule'], path);
    await execGit(['clone', '--no-hardlinks', repo, join(path, 'vendor')], repo);
    await execGit(['checkout', '--detach', base], join(path, 'vendor'));
    await execGit(['submodule', 'absorbgitdirs', 'vendor'], path);
    await writeFile(join(path, 'scratch.txt'), 'uncommitted after merge\n');
    const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    const release = { path: (await execGit(['rev-parse', '--show-toplevel'], path)).stdout.trim(), head, branch, locked: false, lockReason: null };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'pending-merge-queued' }] });
    // Not on local main: only the receipt PR's exact-head merge makes it disposable.
    forge.delivery = { prHead: head };
    expect(await retirePendingMergeCheckout({ repoPath: repo, release, prUrl: 'https://github.com/example/repo/pull/42', expectedHeadSha: head },
      { readAgents: noOwners })).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(release.path)).toBe(false);
    expect(await registered(release.path)).toBe(false);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({ path: release.path, branch,
      head, branchDeleted: true, archiveDir: null }));
  });

  it('settles a checkout the early reaper retired before the next scan', async () => {
    const branch = 'feature/merged-receipt';
    const path = join(repo, '.claude', 'worktrees', 'merged-receipt');
    await mkdir(dirname(path), { recursive: true });
    await execGit(['worktree', 'add', '-b', branch, path, 'main'], repo);
    await writeFile(join(path, '.gitignore'), 'ignored.txt\n');
    await execGit(['add', '.gitignore'], path);
    await execGit(['commit', '-m', 'fixture ignore rule'], path);
    await execGit(['merge', '--ff-only', branch], repo);
    // Merged by ancestry, so the checkout must also be idle to read as done (#16625).
    const gitDir = (await execGit(['rev-parse', '--absolute-git-dir'], path)).stdout.trim();
    const then = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const stamp of [join(gitDir, 'index'), join(gitDir, 'logs', 'HEAD'), path]) await utimes(stamp, then, then);
    const holder = (await (await import('./worktreeManager.js')).listWorktrees(repo)).find(tree => tree.branch === `refs/heads/${branch}`);
    const release = { branch, path: holder.path, head: holder.head, locked: false, lockReason: null };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'checkout-retained' }] });
    const result = await (await import('./worktreeManager.js')).reapMergedWorktrees(repo, {
      appId: 'app-1', activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: noOwners },
    });
    expect(result.reaped).toEqual([expect.objectContaining({ branch, branchDeleted: true })]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    const first = await getBranchReconcileOutcome('app-1');
    expect(first.retired).toEqual([expect.objectContaining({ branch, path: holder.path, head: holder.head, branchDeleted: true, archiveDir: null })]);
    await recordBranchReconcileOutcome('app-1', { status: 'complete', remaining: [] });
    const next = await getBranchReconcileOutcome('app-1');
    expect(next.remaining).toEqual([]);
    expect(next.retired).toEqual(first.retired);
  });

  it('settles a normally retired branch-only row while retaining unrelated unexplained disappearance', async () => {
    const branch = 'feature/merged-branch-only';
    await execGit(['branch', branch, 'main'], repo);
    // A commit of its own, fast-forwarded onto main: merged work, not a new branch (#16625).
    const tree = (await execGit(['rev-parse', 'main^{tree}'], repo)).stdout.trim();
    const work = (await execGit(['commit-tree', tree, '-p', branch, '-m', 'feat: branch-only work'], repo)).stdout.trim();
    await execGit(['update-ref', '-m', 'commit: branch-only work', `refs/heads/${branch}`, work], repo);
    await execGit(['merge', '--ff-only', branch], repo);
    const head = (await execGit(['rev-parse', branch], repo)).stdout.trim();
    const vanished = { branch: 'feature/unexplained-disappearance', head, reason: 'branch-held' };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ branch, head, reason: 'branch-held' }, vanished] });
    const result = await (await import('./branchReconcile.js')).cleanupMerged(repo, 'main', [{ branch }], {
      appId: 'app-1', activeAgentIds: new Set(), claimOwners: { agents: [], readAgents: noOwners },
    });
    expect(result).toMatchObject({ cleaned: [branch], skipped: [] });
    const first = await getBranchReconcileOutcome('app-1');
    expect(first.retired).toEqual([expect.objectContaining({ branch, head, branchDeleted: true, archiveDir: null })]);
    expect(first.remaining).toEqual([vanished]);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/portos/completed/${head}`], repo)).stdout.trim()).toBe(head);
    expect(existsSync(join(PATHS.cos, 'branch-retirement-archives'))).toBe(false);
  });

  it('removes a squash-merged branch with its checkout and drops it from the persisted inventory', async () => {
    const { path, release } = await heldCheckout('branch-held', { branch: 'feature/held', beforeLock: async (tree) => {
      await writeFile(join(tree, 'feature.txt'), 'feature\n');
      await execGit(['add', 'feature.txt'], tree);
      await execGit(['commit', '-m', 'feat: synthetic feature'], tree);
      await execGit(['merge', '--squash', 'feature/held'], repo);
      await execGit(['commit', '-m', 'feat: synthetic feature (squash)'], repo);
    } });
    // A row persisted before the fingerprint was retired still carries it; it is read-compat only.
    const delayed = { ...release, checkoutIdentity: 'a'.repeat(64), observedAt: new Date().toISOString(), reason: 'retirement-pending' };
    await recordBranchReconcileOutcome('app-1', {
      status: 'incomplete', reason: 'holds-remaining', nextAction: 'Recover held checkouts.',
      remaining: [{ ...delayed, managed: false, reason: 'worktree-locked' }, { branch: 'other', reason: 'actionable' }],
    });
    await makeClean(path);
    // The release may carry a legacy fingerprint (even one that differs from the stored row's); it is accepted and ignored.
    const result = await retireInventoriedCheckout({ appId: 'app-1', release: { ...release, checkoutIdentity: '0'.repeat(64) } }, { readAgents: noOwners });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, branchDeleted: true });
    expect(existsSync(path)).toBe(false);
    expect((await execGit(['branch', '--list', 'feature/held'], repo)).stdout.trim()).toBe('');
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.remaining).toEqual([{ branch: 'other', reason: 'actionable' }]);
    expect(outcome.retired[0]).toMatchObject({ path: release.path, branch: 'feature/held', branchDeleted: true, archiveDir: null });
    expect(outcome.retired[0]).not.toHaveProperty('checkoutIdentity');
    await recordBranchReconcileOutcome('app-1', { status: 'running', remaining: [delayed] });
    expect((await getBranchReconcileInventory('app-1')).remaining).toEqual([]);
    await execGit(['worktree', 'add', '-b', release.branch, path, release.head], repo);
    await recordBranchReconcileOutcome('app-1', { status: 'running', remaining: [delayed] });
    expect((await getBranchReconcileInventory('app-1')).remaining).toEqual([delayed]);
  });

  it('treats a changed lock since the inventory as an ownership change', async () => {
    const { path, release } = await heldCheckout('changed-lock');
    await execGit(['worktree', 'unlock', path], repo);
    await execGit(['worktree', 'lock', '--reason', 'new owner took over', path], repo);
    expect(await retire(release)).toEqual({ ok: false, reason: 'checkout-lock-changed' });
    expect(await lockText(path)).toBe('new owner took over');
    expect(existsSync(join(path, 'ignored.txt'))).toBe(true);
  });

  it('treats a moved HEAD since the inventory as an ownership change, and keeps its unmerged commit', async () => {
    const { path, release } = await heldCheckout('moved-head');
    await writeFile(join(path, 'next.txt'), 'more\n');
    await execGit(['add', 'next.txt'], path);
    await execGit(['commit', '-m', 'chore: synthetic owner commit'], path);
    expect(await retire(release)).toEqual({ ok: false, reason: 'checkout-head-changed' });
    const head = (await execGit(['rev-parse', 'HEAD'], path)).stdout.trim();
    expect(await retire({ ...release, head })).toEqual({ ok: false, reason: 'not-merged-on-recheck' });
    expect(await lockText(path)).toBe(release.lockReason);
    expect(await readFile(join(path, 'untracked.txt'), 'utf8')).toBe('untracked work\n');
  });

  it('keeps the checkout, its content and its original lock when an owner appears before removal', async () => {
    const { path, release } = await heldCheckout('owner-arrives', { lockReason: 'handoff pending' });
    let reads = 0;
    // Clear at admission; a live run occupies the checkout by the removal recheck.
    const readAgents = async () => (++reads === 1 ? [] : [{ id: 'agent-live', status: 'running', workspacePath: release.path }]);
    await makeClean(path);
    expect(await retire(release, { readAgents })).toEqual({ ok: false, reason: 'claim-owner-active' });
    expect(await registered(release.path)).toBe(true);
    expect(await lockText(release.path)).toBe('handoff pending');
    expect(existsSync(join(path, 'initial.txt'))).toBe(true);
  });

  it('keeps a clean checkout that becomes dirty before removal', async () => {
    const { path, release } = await heldCheckout('rewritten');
    await makeClean(path);
    injected.onUnlockedStatus = async () => {
      injected.onUnlockedStatus = null;
      await writeFile(join(path, 'late.txt'), 'late work\n');
    };
    expect(await retire(release)).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(await readFile(join(path, 'late.txt'), 'utf8')).toBe('late work\n');
    expect(await lockText(release.path)).toBe('synthetic external owner');
  });

  // A merged checkout holding an ignored link to an outside directory.
  async function linkedCheckout(name) {
    const checkout = await mergedCheckout(name);
    await appendFile(join(repo, '.git', 'info', 'exclude'), 'linked-dir\n');
    const outside = join(scratch, `outside-${name}`);
    await mkdir(outside);
    await writeFile(join(outside, 'wanted.txt'), 'outside bytes\n');
    const link = join(checkout.path, 'linked-dir');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    return { ...checkout, outside, link, target: await readlink(link) };
  }

  it.skipIf(!SYMLINKS)('never follows a directory link while retiring, and restores it when Git refuses removal', async () => {
    const c = await linkedCheckout('linked');
    // Git for Windows can enumerate a junction's descendants as ordinary files.
    injected.onOtherFiles = output => output.split('\0').map(entry => (entry === 'linked-dir' ? 'linked-dir/wanted.txt' : entry)).join('\0');
    let linkGoneAtRemoval = null;
    retirementFaults.onRemove = async () => {
      retirementFaults.onRemove = null;
      linkGoneAtRemoval = !(await lstat(c.link).catch(() => null));
      throw new Error('synthetic Git removal refusal');
    };
    expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, { readAgents: noOwners })).toMatchObject({ ok: false });
    expect(linkGoneAtRemoval).toBe(true);
    expect(await readlink(c.link)).toBe(c.target);
    expect(await registered(c.path)).toBe(true);
    expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, { readAgents: noOwners })).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(await readFile(join(c.outside, 'wanted.txt'), 'utf8')).toBe('outside bytes\n');
  });
});

describe('automatic retirement of completed local work', () => {
  const app = { id: 'example', repoPath: '/example/repo' };
  const head = 'a'.repeat(40);
  const branch = { branch: 'claim/issue-42', tip: head, worktreePath: '/example/checkout', isMerged: false,
    rule: 'completion-policy', completionPolicyReason: 'pr-completion-review-required' };
  const tree = { branch: branch.branch, path: branch.worktreePath, head, managed: true, locked: false, lockReason: null };
  const scan = (b = {}, t = {}) => ({ wip: [{ ...branch, ...b }], worktreeInventory: [{ ...tree, ...t }] });
  const release = { branch: tree.branch, path: tree.path, head, locked: false, lockReason: null };
  const deps = (extra = {}) => ({ retire: vi.fn(async () => ({ ok: true, branchDeleted: true })), readForgeDelivery: vi.fn(async () => 'none'),
    retireReleaseCandidates: vi.fn(async () => ({ retired: [], held: [] })), ...extra });

  unitIt('retires a clean checkout whose commits are all on the default branch, binding the observed row', async () => {
    const d = deps();
    const observation = { observedAt: '2026-10-23T00:00:00Z' };
    // A fingerprint persisted by an older version is not carried into the release.
    expect(await retireCompletedCheckouts(app, scan({ isMerged: true }, { ...observation, checkoutIdentity: 'legacy-checkout' }), d))
      .toEqual({ held: [], retired: [{ ...observation, ...release }] });
    // The forge answer read for the pass is handed on, so the service does not ask again.
    expect(d.retire).toHaveBeenCalledWith({ appId: app.id, release: { ...observation, ...release } }, { beforeMutation: expect.any(Function), delivery: 'none' });
  });

  unitIt('retires a dirty or squash-merged checkout only when its PR merged at the exact head', async () => {
    const d = deps({ readForgeDelivery: vi.fn(async () => 'exact') });
    expect(await retireCompletedCheckouts(app, scan({ worktreeDirty: true }), d)).toMatchObject({ retired: [release] });
    expect(d.readForgeDelivery).toHaveBeenCalledWith(app.repoPath, branch.branch, head);
    expect(d.retire).toHaveBeenCalledWith({ appId: app.id, release }, { beforeMutation: expect.any(Function), delivery: 'exact' });
    const contained = deps({ readForgeDelivery: vi.fn(async () => 'contained') });
    expect(await retireCompletedCheckouts(app, scan(), contained)).toMatchObject({ retired: [release] });
    expect(contained.retire).toHaveBeenCalledWith({ appId: app.id, release }, { beforeMutation: expect.any(Function), delivery: 'contained' });
    for (const [delivery, b] of [['none', {}], ['none', { worktreeDirty: true }], ['none', { isMerged: true, worktreeDirty: true }],
      ['contained', { worktreeDirty: true }], [null, {}]]) {
      const held = deps({ readForgeDelivery: vi.fn(async () => delivery) });
      expect(await retireCompletedCheckouts(app, scan(b), held)).toEqual({ held: [], retired: [] });
      expect(held.retire).not.toHaveBeenCalled();
    }
  });

  unitIt.each([
    [{ liveOwnerReason: 'claim-owner-active' }, {}],
    [{ completionPolicyReason: 'pr-completion-human-handoff' }, {}],
    [{ rule: 'draft', openPr: { isDraft: true, headRefOid: 'c'.repeat(40) } }, {}],
    [{ openPr: { isDraft: false, headRefOid: head } }, {}],
    [{ openPr: { isDraft: false, headRefOid: null } }, {}],
    [{ worktreeStatusUnavailable: true }, {}],
    [{}, { locked: true }], [{}, { managed: false }], [{}, { head: 'b'.repeat(40) }],
  ])('never retires an unsafe or intentionally held candidate: %j %j', async (b, t) => {
    const d = deps({ readForgeDelivery: vi.fn(async () => 'exact') });
    for (const isMerged of [false, true]) {
      expect(await retireCompletedCheckouts(app, scan({ isMerged, ...b }, t), d)).toEqual({ held: [], retired: [] });
    }
    expect(d.retire).not.toHaveBeenCalled();
  });

  unitIt('retires a merged checkout left idle behind its open PR, and keeps one still in use', async () => {
    const behind = { isMerged: true, openPr: { isDraft: false, headRefOid: 'c'.repeat(40) } };
    const d = deps({ checkoutIdleMs: vi.fn(async () => 2 * 60 * 60 * 1000) });
    expect(await retireCompletedCheckouts(app, scan(behind), d)).toMatchObject({ retired: [release], held: [] });
    expect(d.checkoutIdleMs).toHaveBeenCalledWith(tree.path);
    expect(d.readForgeDelivery).not.toHaveBeenCalled();
    for (const idle of [5 * 60 * 1000, null]) {
      const busy = deps({ checkoutIdleMs: vi.fn(async () => idle) });
      expect(await retireCompletedCheckouts(app, scan(behind), busy)).toEqual({ held: [], retired: [] });
      expect(busy.retire).not.toHaveBeenCalled();
    }
  });

  unitIt('keeps a refused or failed retirement held with its reason, never a raw error', async () => {
    const merged = scan({ isMerged: true });
    expect(await retireCompletedCheckouts(app, merged, deps({ retire: vi.fn(async () => ({ ok: false, reason: 'pr-completion-human-handoff' })) })))
      .toEqual({ retired: [], held: [{ ...release, reason: 'pr-completion-human-handoff' }] });
    expect((await retireCompletedCheckouts(app, merged, deps({ retire: vi.fn(async () => ({ ok: true, branchDeleted: false, branchRetainedReason: 'branch-has-new-holder' })) }))).held[0].reason)
      .toBe('branch-has-new-holder');
    expect((await retireCompletedCheckouts(app, merged, deps({ retire: vi.fn(async () => { throw new Error('daemon-stopped'); }) }))).held[0].reason).toBe('daemon-stopped');
    expect((await retireCompletedCheckouts(app, merged, deps({ retire: vi.fn(async () => { throw new Error('private diagnostic'); }) }))).held[0].reason)
      .toBe('retirement-outcome-uncertain');
  });

  unitIt('folds release-candidate results into the pass', async () => {
    const candidate = { branch: 'codex/release-agent-x', path: '/example/release', head, locked: true, lockReason: 'Active release candidate codex/release-agent-x' };
    const d = deps({ retireReleaseCandidates: vi.fn(async () => ({ retired: [candidate], held: [{ ...candidate, reason: 'worktree-dirty' }] })) });
    expect(await retireCompletedCheckouts(app, { wip: [], worktreeInventory: [] }, d)).toEqual({ retired: [candidate], held: [{ ...candidate, reason: 'worktree-dirty' }] });
    expect(d.retireReleaseCandidates).toHaveBeenCalledWith(app, { wip: [], worktreeInventory: [] }, d);
  });
});
