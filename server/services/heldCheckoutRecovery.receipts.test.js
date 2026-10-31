/**
 * Scoped retirement of held checkouts through real Git (#12002, #13519): a
 * release binds to the exact inventory row. A merged checkout is removed in
 * place (dirty only when its PR merged at the exact head). Dirty unmerged and
 * live-owner checkouts stay, and retirement never copies the checkout. Archives
 * in the historical format remain readable.
 *
 * This file: captured delivery owners, many-file capacity, merged receipts, orphan
 * recovery, release targets and legacy-owner review.
 * The suite is split across heldCheckoutRecovery{,.receipts,.siblings}.test.js
 * so Vitest can run the slow real-Git cases in parallel; the shared mocks,
 * per-case repository and builders live in _heldCheckoutRecoveryMocks.js and
 * _heldCheckoutRecoveryFixture.js.
 */
import { describe, expect, vi } from 'vitest';
// Load the factories before any import below resolves a mocked module.
import { mockBranchCompletionPolicy, mockClaimOwnershipState, mockExecGit, mockPaths, mockTaskScheduleStore, injected, owned } from './_heldCheckoutRecoveryMocks.js';
import { mkdir, rm, rename, writeFile, readFile, readdir, utimes, truncate, chmod } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { execGit } from '../lib/execGit.js';

// Mock factories and their shared state live beside this file so the three
// split suites intercept exactly the same boundaries.
vi.mock('../lib/paths.js', async importOriginal => mockPaths(await importOriginal()));
vi.mock('./cosClaimOwnershipState.js', async importOriginal => mockClaimOwnershipState(await importOriginal()));
vi.mock('../lib/execGit.js', async importOriginal => mockExecGit(await importOriginal()));
vi.mock('./forgeExecOptions.js', () => ({ resolveForgeExecOptions: async () => ({ env: { ...process.env, GH_TOKEN: 'synthetic-account-token' } }) }));
vi.mock('./branchCompletionPolicy.js', async importOriginal => mockBranchCompletionPolicy(await importOriginal()));
vi.mock('./taskScheduleStore.js', async importOriginal => mockTaskScheduleStore(await importOriginal()));
vi.mock('./apps.js', () => ({ getAppById: async (id) => (injected.app?.id === id ? injected.app : null) }));

import { describeHeldCheckoutRecovery, setReceiptWork, it, beforeEach, scratch, repo, external, cosDir, receiptWork, noOwners, heldCheckout, registered, lockText, archives, addProofOrigin, reviewedCheckout, receiptCheckout } from './_heldCheckoutRecoveryFixture.js';
const { retireInventoriedCheckout, retirePendingMergeCheckout } = await import('./heldCheckoutRecovery.js');
const { sha256File } = await import('../lib/fileUtils.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome } = await import('./branchReconcileOutcome.js');

describeHeldCheckoutRecovery(() => {
  it.each(['delivered', 'recreated-after-removal', 'different-generation', 'unmerged-original', 'unreadable-original', 'unrelated-capture',
    'human-handoff', 'failed-validation', 'batch-with-target', 'batch-without-target', 'failed-execution', 'batch-unmerged-current'])(
    'binds a later merged delivery to its captured owner without rewriting history: %s', async scenario => {
      const c = await reviewedCheckout(`continued-${scenario}`, { normalMerge: true });
      const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
      const captured = await readCompletedCheckoutIdentity({ repoPath: repo, ...c.release, allowLocked: true });
      expect(captured).not.toBeNull();
      // Persisted JSON object key order is not part of physical generation.
      captured.incarnation = { gitdir: { ...captured.incarnation.gitdir }, pointer: { ...captured.incarnation.pointer } };
      const oldHead = c.release.head;
      const oldUrl = 'https://github.com/example/repo/pull/41';
      const agent = { id: 'agent-continued', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:03:00.000Z', result: { success: true }, metadata: {
          sourceWorkspace: repo, workspacePath: captured.path, worktreeBranch: c.release.branch,
          prCompletionPolicy: scenario === 'human-handoff' ? 'leave-open' : 'review-then-merge',
          reviewLoopMergeTarget: { branch: c.release.branch, url: oldUrl },
          completedCheckouts: [{ version: 1, agentId: 'agent-continued', startedAt: '2026-01-01T00:00:00.000Z',
            capturedAt: '2026-01-01T00:02:00.000Z', ...captured }],
        } };
      let unfinished;
      if (['batch-with-target', 'batch-without-target', 'failed-execution', 'failed-validation', 'batch-unmerged-current'].includes(scenario)) {
        agent.result = { success: false, executionSuccess: scenario !== 'failed-execution',
          taskOutcome: { status: 'incomplete', reason: 'Another claim remains unfinished' } };
        agent.metadata.sourceWorkspace = null;
        agent.metadata.workspacePath = repo;
        agent.metadata.claimBranches = [c.release.branch];
        delete agent.metadata.worktreeBranch;
        agent.metadata.reviewLoopMergeTarget = scenario === 'batch-with-target' ? { branch: c.release.branch, url: c.forge.prUrl } : null;
      }
      if (scenario === 'batch-without-target') {
        unfinished = await heldCheckout('batch-unfinished', { branch: 'feature/batch-unfinished', beforeLock: async tree => {
          await writeFile(join(tree, 'pending.txt'), 'unfinished unique work\n');
          await execGit(['add', 'pending.txt'], tree);
          await execGit(['commit', '-m', 'unfinished claim'], tree);
        } });
        const pendingCapture = await readCompletedCheckoutIdentity({ repoPath: repo, ...unfinished.release, allowLocked: true });
        agent.metadata.claimBranches.push(unfinished.release.branch);
        agent.metadata.completedCheckouts.push({ version: 1, agentId: agent.id, startedAt: agent.startedAt,
          capturedAt: '2026-01-01T00:02:00.000Z', ...pendingCapture });
      }
      if (scenario === 'failed-validation') agent.result.validationPassed = false;
      if (scenario === 'different-generation') agent.metadata.completedCheckouts[0].incarnation.gitdir.ino += '0';
      if (scenario === 'unrelated-capture') {
        const tree = (await execGit(['rev-parse', `${oldHead}^{tree}`], repo)).stdout.trim();
        agent.metadata.completedCheckouts[0].head = (await execGit(['commit-tree', tree, '-m', 'unrelated captured history'], repo)).stdout.trim();
      }
      injected.policies = [agent];
      await writeFile(join(c.path, 'continued.txt'), 'later delivered change\n');
      await execGit(['add', 'continued.txt'], c.path);
      await execGit(['commit', '-m', 'later delivery on the same checkout'], c.path);
      c.release.head = (await execGit(['rev-parse', 'HEAD'], c.path)).stdout.trim();
      await execGit(['merge', '--ff-only', c.release.branch], repo);
      if (scenario === 'unrelated-capture') {
        const unrelated = agent.metadata.completedCheckouts[0].head;
        // Virtual replacement history must not turn missing delivery into proof.
        await execGit(['replace', '--graft', unrelated, oldHead], repo);
        await execGit(['replace', '--graft', c.release.head, unrelated], repo);
      }
      Object.assign(c.forge, { prHead: c.release.head, mergeCommit: c.release.head, defaultHead: c.release.head,
        changedPaths: ['continued.txt', 'feature.txt'] });
      if (scenario === 'batch-unmerged-current') {
        const tree = (await execGit(['rev-parse', `${oldHead}^{tree}`], repo)).stdout.trim();
        c.forge.mergeCommit = (await execGit(['commit-tree', tree, '-m', 'unintegrated delivery'], repo)).stdout.trim();
      }
      c.opts.readHistoricalMerge = async () => scenario === 'unreadable-original' ? null : ({ url: oldUrl,
        state: scenario === 'unmerged-original' ? 'OPEN' : 'MERGED', isCrossRepository: false,
        headRefName: c.release.branch, headRefOid: oldHead, mergeCommit: { oid: oldHead }, baseRefName: 'main' });
      if (scenario === 'recreated-after-removal') c.opts.readForge = async () => {
        if (!existsSync(c.path)) {
          await mkdir(c.path);
          await writeFile(join(c.path, 'new-owner.txt'), 'unrelated new work\n');
        }
        return c.forge;
      };
      await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
      const original = structuredClone(agent);
      const prepared = await c.prepare();
      if (!['delivered', 'recreated-after-removal', 'batch-with-target', 'batch-without-target'].includes(scenario)) {
        expect(prepared).toMatchObject({ ok: false, reason: scenario === 'human-handoff'
          ? 'pr-completion-human-handoff' : 'retirement-policy-not-legacy-completed' });
        expect(await registered(c.path)).toBe(true);
        expect(await archives()).toEqual([]);
      } else {
        expect(prepared).toMatchObject({ ok: true, review: { policy: { policies: [{ continuedDelivery: {
          originalPrUrl: agent.metadata.reviewLoopMergeTarget?.url ?? null, capturedHead: oldHead, tip: c.release.head,
        } }] } } });
        const retired = await c.confirm(prepared.review);
        expect(retired).toMatchObject({ ok: true, branchDeleted: scenario !== 'recreated-after-removal' });
        if (scenario === 'recreated-after-removal') {
          expect(retired.branchRetainedReason).toBe('retirement-evidence-changed');
          expect(await readFile(join(c.path, 'new-owner.txt'), 'utf8')).toBe('unrelated new work\n');
          expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
        }
        expect(retired.archiveDir).toBeUndefined();
        expect(await archives()).toEqual([]);
        if (scenario !== 'recreated-after-removal') expect(await registered(c.path)).toBe(false);
        expect((await c.prepare()).ok).toBe(false);
        if (unfinished) {
          expect(await registered(unfinished.path)).toBe(true);
          expect(await lockText(unfinished.path)).toBe(unfinished.release.lockReason);
          expect(await readFile(join(unfinished.path, 'pending.txt'), 'utf8')).toBe('unfinished unique work\n');
          expect((await execGit(['rev-parse', unfinished.release.branch], repo)).stdout.trim()).toBe(unfinished.release.head);
        }
      }
      expect(agent).toEqual(original);
    });

  it('preserves the checkout when escaped review evidence exceeds the recovery manifest limit', async () => {
    const c = await reviewedCheckout('manifest-byte-limit', {
      superseded: true, featurePath: 'tabs.txt', featureBody: '\t'.repeat(4 * 1024 * 1024 - 512) + '\n',
    });
    await execGit(['rm', 'tabs.txt'], repo);
    await execGit(['commit', '-m', 'remove superseded feature'], repo);
    c.forge.defaultHead = (await execGit(['rev-parse', 'main'], repo)).stdout.trim();
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(Buffer.byteLength(prepared.review.comparison.localPatch)).toBeLessThan(4 * 1024 * 1024);
    expect(Buffer.byteLength(prepared.review.comparison.difference)).toBeLessThan(4 * 1024 * 1024);
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(await registered(c.path)).toBe(false);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${c.release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    expect(await archives()).toEqual([]);
  });

  it('removes a merged clean checkout once and does not create an archive', async () => {
    const c = await reviewedCheckout('bounded-interruption', { normalMerge: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect((await c.confirm(prepared.review)).ok).toBe(false);
    expect(await archives()).toEqual([]);
  });

  it('refuses combined content and administration bytes before preview or teardown while each snapshot fits', async () => {
    const c = await reviewedCheckout('combined-byte-limit', { normalMerge: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    const bytes = 22 * 1024 * 1024;
    const files = [];
    // Untracked (not ignored) content is local work; ignored output is not bound.
    for (const [root, name] of [[c.path, 'untracked-files'], [c.admin, 'private-files']]) {
      const directory = join(root, name);
      await mkdir(directory);
      for (let i = 0; i < 6; i++) {
        const file = join(directory, `item-${i}`);
        await writeFile(file, 'retained bytes\n');
        await truncate(file, bytes);
        files.push(file);
      }
    }
    const hashes = await Promise.all(files.map(sha256File));
    const before = await getBranchReconcileOutcome('app-1');
    const refusal = { ok: false, reason: 'retirement-archive-limit-exceeded', nextAction: expect.any(String), archiveLimit: {
      scope: 'combined', kind: 'total', limitBytes: 250 * 1024 * 1024, observedBytes: expect.any(Number),
    } };
    const preview = await c.prepare();
    expect(preview).toEqual(refusal);
    expect(preview.archiveLimit.observedBytes).toBeGreaterThanOrEqual(12 * bytes);
    expect(preview.archiveLimit.observedBytes).toBeLessThan(12 * bytes + 1024 * 1024);
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: false, reason: 'worktree-dirty' });
    expect(await Promise.all(files.map(sha256File))).toEqual(hashes);
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
    expect(await getBranchReconcileOutcome('app-1')).toEqual(before);
    const removed = await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, {
      ...c.opts, settleMergedReviewObligation: true,
    });
    expect(removed).toMatchObject({ ok: false, reason: 'worktree-dirty' });
    expect(removed.archiveDir).toBeUndefined();
    expect(await Promise.all(files.map(sha256File))).toEqual(hashes);
    expect(await registered(c.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  describe('many-file integrated retirement', () => {
    let c;
    let prepared;
    let retired;
    // Retain main's separate fixture/retirement/proof phases and their existing
    // 30-second budgets while exercising more than 1,000 files in both snapshots.
    beforeEach(async () => {
      c = await owned.run('many-file-checkout', () => reviewedCheckout('file-count-admitted', { normalMerge: true }));
      const directory = join(c.path, 'private-files');
      await mkdir(directory);
      await owned.run('payload-writes', () => Promise.all(Array.from({ length: 1050 }, (_, i) => owned.run('file-write', () => writeFile(join(directory, `item-${i}`), 'retained ignored bytes\n')))));
      if (process.platform !== 'win32') await chmod(join(directory, 'item-1049'), 0o755);
      const privateDir = join(c.admin, 'private-files');
      await mkdir(privateDir);
      await owned.run('admin-writes', () => Promise.all(Array.from({ length: 60 }, (_, i) => owned.run('file-write', () => writeFile(join(privateDir, `item-${i}`), 'private recovery bytes\n')))));
      prepared = await owned.run('many-file-preview', () => c.prepare());
      expect(prepared.ok).toBe(true);
    });

    beforeEach(async () => {
      retired = await owned.run('many-file-confirm', () => c.confirm(prepared.review));
    });

    it('retires a merged checkout holding more than 1000 ignored files', async () => {
      expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true });
      expect(existsSync(c.path)).toBe(false);
      expect(await registered(c.path)).toBe(false);
      expect(await archives()).toEqual([]);
    });
  });


  it.each([
    { scope: 'content', kind: 'file', count: 1, bytes: 25 * 1024 * 1024 + 1 },
    { scope: 'content', kind: 'total', count: 11, bytes: 24 * 1024 * 1024 },
    { scope: 'administration', kind: 'file', count: 1, bytes: 25 * 1024 * 1024 + 1 },
    { scope: 'administration', kind: 'total', count: 11, bytes: 24 * 1024 * 1024 },
  ])('reports $scope $kind capacity at the public preview boundary without changing checkout bytes', async ({ scope, kind, count, bytes }) => {
    const c = await reviewedCheckout('archive-capacity');
    const root = join(scope === 'content' ? c.path : c.admin, scope === 'content' ? 'private-untracked-output' : 'private-build-output');
    await mkdir(root);
    const files = Array.from({ length: count }, (_, i) => join(root, `private-${i}.bin`));
    for (const file of files) {
      await writeFile(file, 'synthetic preserved bytes');
      await truncate(file, bytes);
    }
    const hashes = await Promise.all(files.map(sha256File));
    const before = await getBranchReconcileOutcome('app-1');
    const result = await c.prepare();
    expect(result).toEqual({ ok: false, reason: 'retirement-archive-limit-exceeded', nextAction: expect.any(String), archiveLimit: {
      scope, kind, limitBytes: (kind === 'file' ? 25 : 250) * 1024 * 1024, observedBytes: expect.any(Number),
    } });
    expect(Number.isSafeInteger(result.archiveLimit.observedBytes)).toBe(true);
    expect(result.archiveLimit.observedBytes).toBeGreaterThan(result.archiveLimit.limitBytes);
    expect(result.archiveLimit.observedBytes).toBeLessThanOrEqual(count * bytes + 1024 * 1024);
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(JSON.stringify(result)).not.toContain(c.path);
    expect(JSON.stringify(result)).not.toContain(c.admin);
    expect(await Promise.all(files.map(sha256File))).toEqual(hashes);
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
    expect(await getBranchReconcileOutcome('app-1')).toEqual(before);
  });

  it('keeps non-capacity local evidence failures distinct from archive capacity', async () => {
    const c = await reviewedCheckout('unreadable-snapshot');
    await execGit(['update-index', '--skip-worktree', 'initial.txt'], c.path);
    expect(await c.prepare()).toEqual({ ok: false, reason: 'retirement-local-evidence-unavailable' });
    expect(await registered(c.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('retains measured capacity and the exact lock when the final refreshed review exceeds its budget', async () => {
    const c = await reviewedCheckout('final-review-capacity', { normalMerge: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    const before = await getBranchReconcileOutcome('app-1');
    // Untracked work written just before the destructive step is refused there.
    const file = join(c.path, 'late-untracked.bin');
    const bytes = 25 * 1024 * 1024 + 1;
    let mutations = 0;
    let changedHash;
    const result = await c.confirm(prepared.review, { beforeMutation: async () => {
      if (++mutations === 2) {
        await writeFile(file, 'synthetic untracked payload');
        await truncate(file, bytes);
        changedHash = await sha256File(file);
      }
    } });
    expect(result).toMatchObject({ ok: false, reason: 'retirement-archive-limit-exceeded', nextAction: expect.any(String),
      archiveLimit: { scope: 'content', kind: 'file', limitBytes: bytes - 1, observedBytes: bytes } });
    expect(result.archiveDir).toBeUndefined();
    expect(changedHash).toBeTruthy();
    expect(await sha256File(file)).toBe(changedHash);
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(await archives()).toEqual([]);
    expect(await getBranchReconcileOutcome('app-1')).toEqual(before);
  });

  it('retires a merged receipt checkout without an inventory grant, preserving ignored bytes and original commits', async () => {
    const c = await receiptCheckout('receipt', { gitlink: true });
    const result = await c.retireReceipt();
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(c.release.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect((await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${c.release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
  });

  it('refreshes missing operator-review proof objects after remote main moves without accepting the old digest or advancing refs', async () => {
    const c = await reviewedCheckout('advanced-default', { ignoredPayload: true });
    const before = await c.prepare();
    expect(before.ok).toBe(true);
    const oldMain = (await execGit(['rev-parse', 'main'], repo)).stdout.trim();
    const remote = join(scratch, 'remote-proof');
    await execGit(['clone', '--no-hardlinks', repo, remote], scratch);
    await execGit(['config', 'user.email', 'test@example.com'], remote);
    await execGit(['config', 'user.name', 'Test'], remote);
    await execGit(['commit', '--allow-empty', '-m', 'unrelated remote main advance'], remote);
    c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], remote)).stdout.trim();
    await addProofOrigin();
    injected.fetchRemote = remote;
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(prepared.review.digest).not.toBe(before.review.digest);
    expect(injected.fetches).toHaveLength(1);
    expect(injected.fetches[0].args).toEqual(expect.arrayContaining(['--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', c.forge.defaultHead]));
    expect((await execGit(['rev-parse', 'main'], repo)).stdout.trim()).toBe(oldMain);
    expect((await execGit(['rev-parse', c.release.branch], repo)).stdout.trim()).toBe(c.release.head);
    expect(existsSync(join(repo, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(await c.confirm(before.review)).toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    expect(await lockText(c.release.path)).toBe(c.release.lockReason);
    expect(await archives()).toEqual([]);
    expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe('ignored work\n');
  });

  it('fetches the same moving-default snapshot that its preparation retries, then rechecks mutation freshly', async () => {
    const c = await reviewedCheckout('moving-proof-snapshot');
    const originalMain = (await execGit(['rev-parse', 'main'], repo)).stdout.trim();
    const remote = join(scratch, 'moving-proof-remote');
    await execGit(['clone', '--no-hardlinks', repo, remote], scratch);
    await execGit(['config', 'user.email', 'test@example.com'], remote);
    await execGit(['config', 'user.name', 'Test'], remote);
    const heads = [];
    for (const message of ['first default', 'second default', 'third default']) {
      await execGit(['commit', '--allow-empty', '-m', message], remote);
      heads.push((await execGit(['rev-parse', 'HEAD'], remote)).stdout.trim());
    }
    await addProofOrigin();
    injected.fetchRemote = remote;
    let reads = 0;
    c.opts.readForge = async () => ({ ...c.forge, defaultHead: heads[Math.min(reads++, heads.length - 1)] });
    const prepared = await c.prepare();
    expect(prepared.reason, JSON.stringify(prepared)).toBeUndefined();
    expect(prepared.ok).toBe(true);
    expect(prepared.review.forge.defaultHead).toBe(heads[0]);
    expect(reads).toBe(1);
    expect(injected.fetches).toHaveLength(1);
    expect(injected.fetches[0].args).toContain(heads[0]);
    expect((await execGit(['rev-parse', 'main'], repo)).stdout.trim()).toBe(originalMain);
    expect(existsSync(join(repo, '.git', 'FETCH_HEAD'))).toBe(false);
    const changed = await c.confirm(prepared.review);
    expect(changed.ok).toBe(false);
    expect(reads).toBeGreaterThan(1);
    expect(await registered(c.path)).toBe(true);
    expect(await lockText(c.path)).toBe(c.release.lockReason);
  });

  it('fetches a remote-only squash commit for receipt proof without advancing any local branch', async () => {
    const base = (await execGit(['rev-parse', 'main'], repo)).stdout.trim();
    // This proof needs a clean, unlocked checkout. Avoid constructing dirty,
    // locked recovery state and cleaning it again before the actual boundary.
    const tree = join(external, 'remote-merge');
    const branch = 'feature/remote-merge';
    await execGit(['worktree', 'add', '-b', branch, tree, 'main'], repo);
    await writeFile(join(tree, 'feature.txt'), 'remote feature\n');
    await execGit(['add', 'feature.txt'], tree);
    await execGit(['commit', '-m', 'feature awaiting remote merge'], tree);
    const [path, head] = (await execGit(['rev-parse', '--show-toplevel', 'HEAD'], tree)).stdout.trim().split(/\r?\n/);
    const release = { path, branch, head, locked: false, lockReason: null };
    const remote = join(scratch, 'remote');
    await execGit(['clone', '--no-hardlinks', repo, remote], scratch);
    await execGit(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'merge', '--squash', 'origin/feature/remote-merge'], remote);
    await execGit(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'remote squash merge'], remote);
    const merged = (await execGit(['rev-parse', 'HEAD'], remote)).stdout.trim();
    expect((await execGit(['cat-file', '-e', `${merged}^{commit}`], repo, { ignoreExitCode: true })).exitCode)
      .not.toBe(0);
    await addProofOrigin();
    injected.fetchRemote = remote;
    const prUrl = 'https://github.com/example/repo/pull/42';
    const forge = { repository: 'github.com/example/repo', prUrl, prHead: release.head,
      mergeCommit: merged, defaultHead: merged, defaultBranch: 'main', remoteHead: null,
      changedPaths: ['feature.txt'], changeBase: base, firstCommit: release.head };
    setReceiptWork(retirePendingMergeCheckout({ repoPath: repo, release, prUrl, expectedHeadSha: release.head }, {
      cosDir, readAgents: noOwners, readForge: async () => forge, forgeAccount: 'synthetic-account',
    }));
    const result = await receiptWork;
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect((await execGit(['rev-parse', 'main'], repo)).stdout.trim()).toBe(base);
    expect(existsSync(join(repo, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(injected.fetches).toHaveLength(1);
    expect(injected.fetches[0].args).toEqual(expect.arrayContaining([
      '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', 'https://github.com/example/repo.git', merged,
    ]));
    expect(injected.fetches[0].options).toMatchObject({ timeout: 30_000,
      env: { GH_TOKEN: 'synthetic-account-token', GIT_TERMINAL_PROMPT: '0' } });
    expect(result.archiveDir).toBeUndefined();
    expect(existsSync(release.path)).toBe(false);
    expect(await archives()).toEqual([]);
  });

  it.each(['head', 'supersession'])('binds receipt cleanup to the exact merged head despite later edits: %s', async change => {
    const c = await receiptCheckout('receipt-evidence', {
      superseded: change === 'supersession', multipleCommits: change === 'head',
    });
    // A different head with valid original ancestry reaches the receipt's
    // exact-head guard; the squash commit has no such ancestry and fails earlier.
    if (change === 'head') {
      c.forge.prHead = c.forge.firstCommit;
      c.forge.changedPaths = ['feature.txt'];
    }
    const result = await c.retireReceipt();
    expect(result).toMatchObject(change === 'head' ? { ok: false, reason: 'receipt-pr-head-changed' }
      : { ok: true, branchDeleted: true });
    expect(await registered(c.release.path)).toBe(change === 'head');
    expect(await archives()).toEqual([]);
  });

  it('retains manual, locked, unreadable and initialized-submodule receipt checkouts', async () => {
    const c = await receiptCheckout('receipt-holds', { gitlink: true });
    injected.policies[0].metadata.branchCompletionPolicy.completion = 'leave-open';
    expect(await c.retireReceipt()).toMatchObject({ ok: false, reason: 'pr-completion-human-handoff' });
    injected.policies[0].metadata.branchCompletionPolicy.completion = 'review-then-merge';
    expect(await c.retireReceipt({ readAgents: async () => null })).toMatchObject({ ok: false, reason: 'claim-ownership-unreadable' });
    expect(await c.retireReceipt({ readPolicies: async () => null })).toMatchObject({ ok: false, reason: 'pr-completion-policy-unavailable' });
    await execGit(['worktree', 'lock', '--reason', 'new owner', c.path], repo);
    expect(await c.retireReceipt()).toMatchObject({ ok: false, reason: 'checkout-lock-changed' });
    await execGit(['worktree', 'unlock', c.path], repo);
    await writeFile(join(c.path, 'vendor', 'unique.txt'), 'submodule work');
    expect(await c.retireReceipt()).toMatchObject({ ok: false, reason: 'retirement-submodule-not-uninitialized' });
    expect(await readFile(join(c.path, 'vendor', 'unique.txt'), 'utf8')).toBe('submodule work');
    expect(await registered(c.release.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('preserves a receipt checkout when an owner appears during its archive', async () => {
    const c = await receiptCheckout('receipt-new-owner');
    let reads = 0;
    const result = await c.retireReceipt({ readAgents: async () => (++reads < 3 ? [] : [{
      id: 'agent-live', status: 'running', workspacePath: c.release.path,
    }]) });
    expect(result).toMatchObject({ ok: false, reason: 'claim-owner-active' });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(c.release.path)).toBe(true);
    expect(await readFile(join(c.path, 'feature.txt'), 'utf8')).toBe('original feature\n');
    expect(await archives()).toEqual([]);
  });

  it.each(['original', 'repo-alias', 'pending-execution', 'recreated-pointer', 'active-owner', 'different-pr-head', 'failed-validation', 'missing-terminal-head', 'late-writer'])('recovers a merged orphan only from its exact early generation: %s', async scenario => {
    const c = await reviewedCheckout(`orphan-${scenario}`);
    await execGit(['worktree', 'unlock', c.path], repo);
    Object.assign(c.release, { locked: false, lockReason: null });
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
    const evidence = await import('./completedCheckoutEvidence.js');
    const agent = { id: 'original-orphan', status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString(),
      result: { success: false, executionSuccess: false, orphaned: true, validationPassed: null },
      metadata: { isWorktree: true, sourceWorkspace: repo, workspacePath: c.path, worktreeBranch: c.release.branch,
        prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { url: c.forge.prUrl, branch: c.release.branch } } };
    agent.metadata.checkoutSeeds = await evidence.captureCheckoutSeeds(agent);
    // completeAgent preserves this exact target while the run is still bound,
    // before publishing an orphan's terminal state with an empty initial capture.
    const targets = await evidence.captureSeededCompletionCheckouts(agent, { preterminal: true });
    expect(targets).toEqual([expect.objectContaining({ head: c.release.head, startedAt: agent.startedAt })]);
    agent.metadata.checkoutCapture = { status: 'captured', targets, unknown: false };
    agent.status = 'completed';
    agent.completedAt = new Date().toISOString();
    agent.metadata.completedCheckouts = [];
    if (scenario === 'pending-execution') {
      agent.result = { ...agent.result, orphaned: false, executionSuccess: true };
      agent.metadata.checkoutCapture = { status: 'pending', targets: [], unknown: true };
    }
    if (scenario === 'missing-terminal-head') agent.metadata.checkoutCapture = { status: 'captured' };
    if (scenario === 'late-writer') {
      await writeFile(join(c.path, 'later-user.txt'), 'later independent work\n');
      await execGit(['add', 'later-user.txt'], c.path);
      await execGit(['commit', '-m', 'later independent writer'], c.path);
      expect(await evidence.captureSeededCompletionCheckouts(agent)).toBeNull();
    }
    if (scenario === 'repo-alias') injected.app.repoPath = `${repo}/../repo`;
    if (scenario === 'failed-validation') agent.result.validationPassed = false;
    injected.policies = [agent];
    const originalResult = structuredClone(agent.result);
    let recoveries = 0;
    c.opts.recoverCheckoutCapture = async (id, { retirement }) => {
      expect(id).toBe(agent.id);
      expect(retirement).toMatchObject({ ...c.release, repoPath: realpathSync(repo), path: realpathSync(c.path) });
      if (scenario === 'pending-execution') expect(retirement).toMatchObject({ prUrl: c.forge.prUrl, verifiedMergedHead: c.release.head });
      const captured = await evidence.captureSeededCompletionCheckouts(agent, { retirement });
      if (!captured) return false;
      agent.metadata.completedCheckouts = captured;
      recoveries++;
      return true;
    };
    if (scenario === 'recreated-pointer') {
      const bytes = await readFile(join(c.path, '.git'));
      await rename(join(c.path, '.git'), join(scratch, 'original-pointer'));
      await writeFile(join(c.path, '.git'), bytes);
    }
    if (scenario === 'active-owner') c.opts.readAgents = async () => [{ id: 'other', status: 'running', workspacePath: c.path }];
    if (scenario === 'different-pr-head') c.forge.prHead = 'b'.repeat(40);
    const prepared = await c.prepare();
    expect(agent.result).toEqual(originalResult);
    if (!['original', 'repo-alias', 'pending-execution'].includes(scenario)) {
      expect(prepared.ok).toBe(false);
      expect(await registered(c.path)).toBe(true);
      expect(await archives()).toEqual([]);
      expect(recoveries).toBe(0);
      if (scenario === 'late-writer') expect(await readFile(join(c.path, 'later-user.txt'), 'utf8')).toBe('later independent work\n');
      return;
    }
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { policy: { policies: [{ success: false,
      ...(scenario === 'pending-execution' ? { continuedDelivery: { capturedHead: c.release.head } } : { orphanedExecution: true }) }] } } });
    const receipt = agent.metadata.completedCheckouts[0];
    expect(receipt).toMatchObject({ version: 2, head: c.release.head });
    expect(evidence.completedCheckoutReceiptValid(agent, receipt)).toBe(true);
    const retired = await c.confirm(prepared.review);
    expect(retired).toMatchObject({ ok: true, branchDeleted: true });
    expect(retired.archiveDir).toBeUndefined();
    expect(await registered(c.path)).toBe(false);
    expect((await c.prepare()).ok).toBe(false);
    expect(await archives()).toEqual([]);
    expect(recoveries).toBe(1);
    expect(agent.result).toEqual(originalResult);
  });

  it('retires exact release-target delivery without merging it into the unrelated default branch', async () => {
    const c = await reviewedCheckout('release-target-delivery', { targetBranch: 'release' });
    await expect(execGit(['merge-base', '--is-ancestor', c.forge.mergeCommit, 'main'], repo)).rejects.toThrow();
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { forge: { targetBranch: 'release' }, comparison: { disposition: 'integrated' } } });
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: true, branchDeleted: true });
    expect(await registered(c.path)).toBe(false);
    expect((await execGit(['rev-parse', 'release'], repo)).stdout.trim()).toBe(c.forge.targetHead);
    expect((await execGit(['rev-parse', 'main'], repo)).stdout.trim()).toBe(c.forge.defaultHead);
    expect(await archives()).toEqual([]);
  });

  it('settles the captured release delivery of an incomplete batch without declaring its siblings successful', async () => {
    const c = await reviewedCheckout('release-incomplete-batch', { targetBranch: 'release' });
    const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
    const identity = await readCompletedCheckoutIdentity({ repoPath: repo, ...c.release, allowLocked: true });
    expect(identity?.head).toBe(c.release.head);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const capturedAt = new Date().toISOString();
    const result = { success: false, executionSuccess: true, validationPassed: true,
      taskOutcome: { status: 'incomplete', reason: 'A different batch branch still needs delivery.' } };
    injected.policies = [{ id: 'completed-batch', status: 'completed', startedAt, completedAt: capturedAt, result,
      metadata: { workspacePath: repo, claimBranches: [c.release.branch], prCompletionPolicy: 'review-then-merge',
        completedCheckouts: [{ version: 1, agentId: 'completed-batch', startedAt, capturedAt,
          ...identity, repoPath: repo, branch: c.release.branch, path: c.path }] } }];
    const before = structuredClone(result);
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { policy: { policies: [expect.objectContaining({ continuedDelivery: expect.any(Object) })] } } });
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: true, branchDeleted: true });
    expect(injected.policies[0].result).toEqual(before);
    expect(await registered(c.path)).toBe(false);
  });

  it.each(['wrong-target', 'unpublished-continuation'])('preserves release checkout with %s', async scenario => {
    const c = await reviewedCheckout(`release-target-${scenario}`, { targetBranch: 'release' });
    if (scenario === 'wrong-target') c.forge.targetHead = c.forge.defaultHead;
    else {
      await writeFile(join(c.path, 'unpublished.txt'), 'wanted unfinished continuation\n');
      await execGit(['add', 'unpublished.txt'], c.path);
      await execGit(['commit', '-m', 'unpublished continuation'], c.path);
      c.release.head = (await execGit(['rev-parse', 'HEAD'], c.path)).stdout.trim();
      await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
    }
    const prepared = await c.prepare();
    if (scenario === 'wrong-target') expect(prepared).toMatchObject({ ok: false, reason: 'retirement-merge-not-in-target' });
    else {
      expect(prepared).toMatchObject({ ok: true, review: { comparison: { disposition: 'review-supersession', exactMergedDelivery: false } } });
      expect(await c.confirm(prepared.review)).toMatchObject({ ok: false });
      expect(await readFile(join(c.path, 'unpublished.txt'), 'utf8')).toContain('wanted unfinished continuation');
    }
    expect(await registered(c.path)).toBe(true);
    expect(await archives()).toEqual([]);
  });

  it('does not require manual supersession acceptance for an exact delivered head after later edits', async () => {
    const c = await reviewedCheckout('ancestral', { normalMerge: true, superseded: true });
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { comparison: { disposition: 'integrated', exactMergedDelivery: true } } });
    expect(prepared.review.comparison.difference).toContain('strengthened replacement');
    expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release,
      review: { prUrl: c.forge.prUrl, digest: prepared.review.digest, acceptSuperseded: false } }, c.opts))
      .toMatchObject({ ok: true, branchDeleted: true });
  });

  it('compares pathspec glob filenames literally', async () => {
    const c = await reviewedCheckout('literal', { featurePath: '[literal].txt', superseded: true });
    await writeFile(join(repo, 'l.txt'), 'unrelated glob match\n');
    await execGit(['add', 'l.txt'], repo);
    await execGit(['commit', '-m', 'unrelated default change'], repo);
    c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(prepared.review.comparison.disposition).toBe('integrated');
    expect(prepared.review.comparison.exactMergedDelivery).toBe(true);
    expect(prepared.review.comparison.difference).toContain('+strengthened replacement');
    expect(prepared.review.comparison.difference).not.toContain('unrelated glob match');
  });

  it('retains all original changes in a multi-commit squash review', async () => {
    const c = await reviewedCheckout('multi', { multipleCommits: true });
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(prepared.review.comparison.localPatch).toContain('+original feature');
    expect(prepared.review.comparison.localPatch).toContain('+second original change');
    expect(prepared.review.comparison.disposition).toBe('integrated');
  });

  it.each([false, true])('requires a new scoped review for completed legacy owners, superseded=%s', async superseded => {
    const c = await reviewedCheckout('legacy', { superseded, gitlink: true });
    if (!superseded) expect(await retireInventoriedCheckout({ appId: 'app-1', release: c.release }, c.opts))
      .toMatchObject({ ok: false, reason: 'pr-completion-review-required' });
    // A stale stat cache must not let confirmation's own status read rewrite
    // the private index and invalidate an otherwise unchanged scoped review.
    await utimes(join(c.path, 'feature.txt'), new Date('2001-01-01'), new Date('2001-01-01'));
    const index = await readFile(join(c.admin, 'index'));
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    expect(await readFile(join(c.admin, 'index'))).toEqual(index);
    expect(prepared.review.comparison.disposition).toBe('integrated');
    const result = await c.confirm(prepared.review);
    expect(result, `Confirmation refusal: ${result.reason ?? 'none'}`).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(existsSync(c.path)).toBe(false);
    expect(await archives()).toEqual([]);
    expect(injected.policies[0].metadata.branchCompletionPolicy).toBeUndefined();
  });

});
