/**
 * Scoped retirement of held checkouts through real Git (#12002, #13519): a
 * release binds to the exact inventory row. A merged checkout is removed in
 * place (dirty only when its PR merged at the exact head). Dirty unmerged and
 * live-owner checkouts stay, and retirement never copies the checkout. Archives
 * in the historical format remain readable.
 *
 * This file: completed resume lineage, merge-on-green delivery, sibling obligations,
 * reused branches, the review-change matrix and ref-only finalization.
 * The suite is split across heldCheckoutRecovery{,.receipts,.siblings}.test.js
 * so Vitest can run the slow real-Git cases in parallel; the shared mocks,
 * per-case repository and builders live in _heldCheckoutRecoveryMocks.js and
 * _heldCheckoutRecoveryFixture.js.
 */
import { describe, expect, vi } from 'vitest';
// Load the factories before any import below resolves a mocked module.
import { mockBranchCompletionPolicy, mockClaimOwnershipState, mockExecGit, mockPaths, mockTaskScheduleStore, injected, receiptTiming, retirementFaults, SYMLINKS } from './_heldCheckoutRecoveryMocks.js';
import { cp, mkdir, rename, writeFile, readFile, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';
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

import { describeHeldCheckoutRecovery, setExternal, it, beforeEach, scratch, repo, external, noOwners, registered, lockText, retire, addProofOrigin, reviewedCheckout } from './_heldCheckoutRecoveryFixture.js';
const { retireInventoriedCheckout, prepareInventoriedCheckoutRetirement } = await import('./heldCheckoutRecovery.js');
const { recordBranchReconcileOutcome, getBranchReconcileOutcome, recordHeldCheckoutRetirement } = await import('./branchReconcileOutcome.js');

describeHeldCheckoutRecovery(() => {
  // Each contract keeps a fresh physical registration and the five-second
  // deadline. Only immutable history is shared by reviewedHistory; proof,
  // ownership, generation and persisted receipts are always read afresh.
  async function rewrittenResumeCheckout() {
    return receiptTiming.run('lineage-fixture', async () => {
      const c = await reviewedCheckout('rewritten-resume', { normalMerge: true, unlocked: true });
      const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
      const captured = await readCompletedCheckoutIdentity({ repoPath: repo, ...c.release });
      const base = (await execGit(['rev-parse', `${c.release.head}^`], repo)).stdout.trim();
      const rewritten = (await execGit(['commit-tree', `${c.release.head}^{tree}`, '-p', base, '-m', 'before review rewrite'], repo)).stdout.trim();
      const attempts = ['predecessor', 'successor'].map((id, index) => {
        const startedAt = `2026-03-01T0${index}:00:00.000Z`;
        const path = index ? c.path : join(external, 'original-before-move');
        return { id, taskId: 'same-original-task', status: 'completed', startedAt,
          completedAt: `2026-03-01T0${index}:01:00.000Z`,
          result: { success: false, executionSuccess: true, validationPassed: index ? true : null,
            ...(index && { cleanupPending: true, taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } }) },
          metadata: { sourceWorkspace: repo, workspacePath: path, worktreeBranch: c.release.branch,
            prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { branch: c.release.branch, url: c.forge.prUrl },
            resumedFromAgentId: index ? 'predecessor' : null,
            completedCheckouts: [{ version: 1, agentId: id, startedAt, capturedAt: startedAt, ...captured,
              path, head: index ? c.release.head : rewritten }] } };
      });
      injected.policies = attempts;
      return { c, attempts, base, rewritten, row: attempts[0].metadata.completedCheckouts[0] };
    });
  }

  it('refuses changed, dropped and ambiguous captured completed resume lineage before retirement', async () => {
    const { c, base, rewritten, row } = await rewrittenResumeCheckout();
    const unchanged = structuredClone(injected.policies);
    // A changed patch and an additional dropped patch must not be mistaken for
    // a rebase, even with the exact same trusted resume/physical lineage.
    const rejected = await receiptTiming.run('rejected-history-fixture', async () => {
      const rejected = [];
      const scratchCheckout = join(external, 'unmatched-original');
      await execGit(['worktree', 'add', '--detach', scratchCheckout, base], repo);
      await writeFile(join(scratchCheckout, 'feature.txt'), 'changed original patch\n');
      await execGit(['add', 'feature.txt'], scratchCheckout);
      await execGit(['commit', '-m', 'changed original patch'], scratchCheckout);
      rejected.push((await execGit(['rev-parse', 'HEAD'], scratchCheckout)).stdout.trim());
      await execGit(['checkout', '--detach', rewritten], scratchCheckout);
      await writeFile(join(scratchCheckout, 'dropped.txt'), 'wanted undelivered patch\n');
      await execGit(['add', 'dropped.txt'], scratchCheckout);
      await execGit(['commit', '-m', 'undelivered additional patch'], scratchCheckout);
      rejected.push((await execGit(['rev-parse', 'HEAD'], scratchCheckout)).stdout.trim());
      await execGit(['worktree', 'remove', scratchCheckout], repo);
      rejected.push((await execGit(['commit-tree', `${c.release.head}^{tree}`, '-p', base, '-p', c.release.head, '-m', 'ambiguous original merge'], repo)).stdout.trim());
      return rejected;
    });
    for (const head of rejected) {
      row.head = head;
      expect(await receiptTiming.run('lineage-refusal', () => c.prepare())).toMatchObject({ ok: false, reason: 'retirement-policy-not-legacy-completed' });
      expect(await registered(c.path)).toBe(true);
    }
    row.head = rewritten;
    expect(injected.policies).toEqual(unchanged);
  });

  it('preserves authority holds for captured completed resume lineage before retirement', async () => {
    const { c, attempts, row } = await rewrittenResumeCheckout();
    const unchanged = structuredClone(attempts);
    // These holds must survive the real rewritten-delivery fallback as well
    // as ordinary exact-head policy admission.
    for (const [target, key, value] of [[attempts[0], 'taskId', 'other-task'], [attempts[0], 'status', 'running'],
      [attempts[0].metadata.reviewLoopMergeTarget, 'url', 'https://github.com/example/repo/pull/43'],
      [attempts[0].metadata, 'prCompletionPolicy', 'leave-open'],
      [row, 'incarnation', { pointer: { ino: 'different' } }]]) {
      const prior = target[key]; target[key] = value;
      const refused = await receiptTiming.run('lineage-authority', () => c.prepare());
      expect(refused, `${key}: ${JSON.stringify(refused)}`).toMatchObject({ ok: false });
      expect(await registered(c.path)).toBe(true);
      target[key] = prior;
    }
    expect(injected.policies).toEqual(unchanged);
  });

  it('binds explicit original policies to captured completed resume lineage before retirement', async () => {
    const { c, attempts, rewritten } = await rewrittenResumeCheckout();
    const unchanged = structuredClone(attempts);
    // An explicit original-head policy must bind the captured old head, rather
    // than being replaced with the rewritten tip to make the review pass.
    attempts[0].metadata.branchCompletionPolicy = { branch: c.release.branch, completion: 'review-then-merge',
      prUrl: c.forge.prUrl, tip: 'b'.repeat(40) };
    expect(await receiptTiming.run('lineage-verification', () => c.prepare())).toMatchObject({ ok: false });
    attempts[0].metadata.branchCompletionPolicy.tip = rewritten;
    const boundPolicy = await receiptTiming.run('lineage-verification', () => c.prepare());
    expect(boundPolicy, JSON.stringify(boundPolicy)).toMatchObject({ ok: true });
    delete attempts[0].metadata.branchCompletionPolicy;
    expect(injected.policies).toEqual(unchanged);
  });

  it('proves rewritten delivery only for the captured completed resume lineage before retirement', async () => {
    const { c, attempts } = await rewrittenResumeCheckout();
    const unchanged = structuredClone(attempts);
    const prepared = await receiptTiming.run('lineage-verification', () => c.prepare());
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { policy: { policies: [
      { id: 'predecessor', success: false, resumedCleanup: { successorAgentId: 'successor' } },
      { id: 'successor', success: false },
    ] } } });
    const retired = await receiptTiming.run('confirmation', () => c.confirm(prepared.review));
    expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(retired.archiveDir ?? null).toBeNull();
    expect(injected.policies).toEqual(unchanged);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({
      branch: c.release.branch, head: c.release.head, branchDeleted: true, archiveDir: null,
    }));
  });

  it.each(['bound', 'discovered'])('retires a resumed merged checkout with %s PR identity without promoting failed attempts', async prIdentity => {
    const c = await reviewedCheckout('resumed-cleanup', { normalMerge: true });
    await execGit(['worktree', 'unlock', c.path], repo);
    Object.assign(c.release, { locked: false, lockReason: null });
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
    const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
    const captured = await readCompletedCheckoutIdentity({ repoPath: repo, ...c.release });
    const attempts = ['failed', 'cleanup', 'resumed'].map((id, index) => {
      const startedAt = `2026-03-01T0${index}:00:00.000Z`;
      const path = index === 2 ? c.path : join(external, id);
      return { id, taskId: 'same-original-task', status: 'completed', startedAt,
        completedAt: `2026-03-01T0${index}:01:00.000Z`,
        result: index === 0 ? { success: false, executionSuccess: false, validationPassed: null }
          : { success: false, executionSuccess: true, validationPassed: null, cleanupPending: true,
            taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } },
        metadata: { sourceWorkspace: repo, workspacePath: path, worktreeBranch: c.release.branch,
          prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: prIdentity === 'bound' ? { branch: c.release.branch, url: c.forge.prUrl } : null,
          checkoutSeeds: [],
          resumedFromAgentId: index ? ['failed', 'cleanup'][index - 1] : null,
          completedCheckouts: [{ version: 1, agentId: id, startedAt, capturedAt: startedAt, ...captured, path }] } };
    });
    injected.policies = attempts;
    // Git and realpath can spell the same Windows path differently. Exercise
    // equivalent receipt paths on every platform, retaining the real identity.
    const receipt = attempts[2].metadata.completedCheckouts[0];
    receipt.repoPath += '/.';
    receipt.path += '/.';
    const original = structuredClone(attempts);
    // Keep authority refusals on the real continuation/rewrite fallback, as well
    // as physical repository, checkout and generation binding.
    for (const [target, key, value] of [[attempts[2].metadata, 'resumedFromAgentId', null],
      [attempts[0], 'taskId', 'other-task'], [attempts[0].result, 'validationPassed', false],
      [attempts[0].metadata, 'prCompletionPolicy', 'leave-open'],
      [attempts[0].metadata, 'reviewLoopMergeTarget', { branch: c.release.branch, url: 'https://github.com/example/repo/pull/99' }],
      [receipt, 'repoPath', join(scratch, 'unrelated-repo')],
      [receipt, 'path', join(external, 'unrelated-checkout')],
      [attempts[0].metadata.completedCheckouts[0], 'head', 'b'.repeat(40)],
      [attempts[0].metadata.completedCheckouts[0], 'incarnation', { pointer: { ino: 'other' } }]]) {
      const prior = target[key]; target[key] = value;
      const refused = await c.prepare();
      expect(refused, `${key}: ${JSON.stringify(refused)}`).toMatchObject({ ok: false });
      expect(await registered(c.path)).toBe(true);
      target[key] = prior;
    }
    const prepared = await c.prepare();
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { policy: { policies: [
      { id: 'cleanup', success: false, resumedCleanup: { successorAgentId: 'resumed' } },
      { id: 'failed', success: false, resumedCleanup: { successorAgentId: 'resumed' } },
      { id: 'resumed', success: false },
    ] } } });
    const retired = await c.confirm(prepared.review);
    expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
    expect(existsSync(c.path)).toBe(false);
    expect(injected.policies).toEqual(original);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({
      branch: c.release.branch, path: c.path, head: c.release.head, branchDeleted: true, archiveDir: null,
    }));
  });

  it.each(['captured', 'legacy-capture', 'missing-capture', 'failed-validation', 'failed-execution', 'human-handoff', 'changed-generation'])(
    'retires captured merge-on-green delivery without promoting its aggregate outcome: %s', async scenario => {
      const c = await reviewedCheckout(`merge-on-green-${scenario}`);
      await execGit(['worktree', 'unlock', c.path], repo);
      Object.assign(c.release, { locked: false, lockReason: null });
      await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'pr-completion-review-required' }] });
      const evidence = await import('./completedCheckoutEvidence.js');
      const agent = { id: 'completed-automatic-owner', status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString(),
        metadata: { isWorktree: true, sourceWorkspace: repo, workspacePath: c.path, worktreeBranch: c.release.branch,
          prCompletionPolicy: 'merge-on-green' } };
      agent.metadata.checkoutSeeds = await evidence.captureCheckoutSeeds(agent);
      agent.metadata.completedCheckouts = await evidence.captureSeededCompletionCheckouts(agent, { preterminal: true });
      expect(agent.metadata.completedCheckouts).toHaveLength(1);
      agent.status = 'completed'; agent.completedAt = new Date().toISOString();
      agent.result = { success: false, executionSuccess: true, validationPassed: true,
        taskOutcome: { status: 'blocked', recovery: { mode: 'runtime', prUrl: c.forge.prUrl, requiredCommit: c.forge.defaultHead } } };
      if (scenario === 'legacy-capture') agent.metadata.completedCheckouts = agent.metadata.completedCheckouts.map(row =>
        ({ ...row, version: 1, capturedAt: agent.completedAt }));
      if (scenario === 'missing-capture') agent.metadata.completedCheckouts = [];
      if (scenario === 'failed-validation') agent.result.validationPassed = false;
      if (scenario === 'failed-execution') agent.result.executionSuccess = false;
      if (scenario === 'human-handoff') agent.metadata.prCompletionPolicy = 'leave-open';
      if (scenario === 'changed-generation') agent.metadata.completedCheckouts[0].incarnation.pointer.ino = '1';
      injected.policies = [agent];
      const original = structuredClone(agent);
      const prepared = await c.prepare();
      if (!['captured', 'legacy-capture'].includes(scenario)) {
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: false });
        expect(await registered(c.path)).toBe(true);
      } else {
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ ok: true, review: { policy: { policies: [
          { id: agent.id, success: false, completion: 'merge-on-green', continuedDelivery: { kind: 'captured-merged-delivery' } },
        ] } } });
        const retired = await c.confirm(prepared.review);
        expect(retired, JSON.stringify(retired)).toMatchObject({ ok: true, branchDeleted: true });
        expect(await registered(c.path)).toBe(false);
      }
      expect(agent).toEqual(original);
    });

  it.each([false, true])('retires legacy pinned cleanup with lagging main and missing remote proof=%s', async missingProof => {
    const c = await reviewedCheckout('pinned-cleanup', { normalMerge: true });
    injected.policies[0].result = { success: false, executionSuccess: true,
      taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } };
    let shippedDefault = c.forge.defaultHead;
    if (missingProof) {
      const remote = join(scratch, 'proof-remote');
      await execGit(['clone', '--no-hardlinks', repo, remote], scratch);
      await execGit(['config', 'user.email', 'test@example.com'], remote);
      await execGit(['config', 'user.name', 'Test'], remote);
      await execGit(['commit', '--allow-empty', '-m', 'new remote default'], remote);
      shippedDefault = (await execGit(['rev-parse', 'HEAD'], remote)).stdout.trim();
      expect((await execGit(['cat-file', '-e', `${shippedDefault}^{commit}`], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
      await addProofOrigin();
      injected.fetchRemote = remote;
    }
    await execGit(['reset', '--hard', 'HEAD^'], repo);
    const localMain = (await execGit(['rev-parse', 'main'], repo)).stdout.trim();
    c.forge.defaultHead = localMain;
    expect(await c.prepare()).toMatchObject({ ok: false, reason: 'retirement-policy-not-legacy-completed' });
    c.forge.defaultHead = shippedDefault;
    injected.policies[0].result.validationPassed = false;
    expect(await c.prepare()).toMatchObject({ ok: false, reason: 'retirement-policy-not-legacy-completed' });
    injected.policies[0].result.validationPassed = null;
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { comparison: { disposition: 'integrated', difference: '' },
      policy: { integratedCleanupHead: shippedDefault } } });
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(c.path)).toBe(false);
    expect((await execGit(['rev-parse', 'main'], repo)).stdout.trim()).toBe(localMain);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({
      branch: c.release.branch, head: c.release.head, archiveDir: null, branchDeleted: true,
    }));
    expect(injected.fetches).toHaveLength(missingProof ? 1 : 0);
  });

  it.each(['complete', 'owner-reacquired', 'identity-changed'])('recovers retained merged claims through persisted retirement: %s', async scenario => {
    setExternal(join(repo, '.claude', 'worktrees'));
    await mkdir(external, { recursive: true });
    const c = await reviewedCheckout('claim-issue-425', { normalMerge: true });
    await execGit(['branch', '-m', c.release.branch, 'claim/issue-425'], repo);
    await execGit(['worktree', 'unlock', c.path], repo);
    await execGit(['restore', 'initial.txt'], c.path);
    await mkdir(join(c.admin, 'info'), { recursive: true });
    await writeFile(join(c.admin, 'info', 'exclude'), 'private fixture exclusion note\n');
    expect((await execGit(['status', '--porcelain'], c.path)).stdout).toBe('');
    const release = { ...c.release, branch: 'claim/issue-425', locked: false, lockReason: null,
      checkoutIdentity: await readRetirementCheckoutIdentity(c.path) };
    injected.policies[0].metadata.claimBranches = [release.branch];
    injected.policies[0].result = { success: false, executionSuccess: true,
      taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } };
    const merged = { branch: release.branch, tip: release.head, worktreePath: release.path,
      state: 'MERGED', isMerged: true, worktreeAgeMs: 0, worktreeLocked: false };
    const { cleanupMerged } = await import('./branchReconcile.js');
    const initial = await cleanupMerged(repo, 'main', [merged], { appId: 'app-1', activeAgentIds: new Set(),
      claimOwners: { agents: [], readAgents: noOwners } });
    expect(initial).toMatchObject({ cleaned: [], skipped: [{ branch: release.branch, reason: 'claim-completion-unverified' }] });
    const remaining = [{ ...release, reason: 'claim-completion-unverified' }];
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining });
    const { prepareReconcileRetirements } = await import('./branchReconcileRetirement.js');
    const input = { wip: [], merged: [merged], skipped: initial.skipped,
      worktreeInventory: [{ ...release, managed: true }] };
    const result = await prepareReconcileRetirements(injected.app, input, {
      readPr: async () => c.forge.prUrl,
      prepare: async request => {
        const reviewed = await prepareInventoriedCheckoutRetirement(request, c.opts);
        if (scenario === 'owner-reacquired') c.opts.readAgents = async () => [{ id: 'new-owner', status: 'running',
          metadata: { sourceWorkspace: repo, workspacePath: c.path, worktreeBranch: release.branch } }];
        if (scenario === 'identity-changed') {
          const pointer = await readFile(join(c.path, '.git'));
          await rename(join(c.path, '.git'), join(c.path, '.git.previous')); await writeFile(join(c.path, '.git'), pointer);
        }
        return reviewed;
      },
      // Model the daemon's admitted mutation callback; exercise the actual
      // inventory, policy, owner, archive, removal and persisted-receipt gates.
      retire: (request, options) => retireInventoriedCheckout(request, { ...c.opts, ...options, beforeMutation: async () => {} }),
    });
    const outcome = await getBranchReconcileOutcome('app-1');
    if (scenario !== 'complete') {
      expect(result).toMatchObject({ retired: [], held: [{ reason: scenario === 'owner-reacquired' ? 'claim-owner-active' : 'checkout-identity-changed' }] });
      expect(await registered(c.path)).toBe(true);
      expect(outcome.retired || []).toEqual([]);
      return;
    }
    expect(result).toMatchObject({ candidates: [], held: [], retired: [expect.objectContaining({ checkoutIdentity: release.checkoutIdentity })] });
    expect(await registered(c.path)).toBe(false);
    const receipt = outcome.retired.find(row => row.branch === release.branch);
    expect(receipt).toMatchObject({ head: release.head, branchDeleted: true, archiveDir: null, checkoutIdentity: release.checkoutIdentity });
  });

  it('settles a review obligation for unattended retirement only once every commit is on the default branch', async () => {
    const c = await reviewedCheckout('settled', { normalMerge: true, superseded: true });
    await execGit(['worktree', 'unlock', c.path], repo);
    const release = { ...c.release, locked: false, lockReason: null };
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...release, reason: 'pr-completion-review-required' }] });
    const retire = (more = {}) => retireInventoriedCheckout({ appId: 'app-1', release }, { ...c.opts, ...more });
    // A reused branch: the obligation names an earlier PR, not this head.
    injected.policies[0].metadata.branchCompletionPolicy = {
      branch: release.branch, completion: 'review-then-merge', prUrl: 'https://github.com/example/repo/pull/41', tip: null,
    };
    injected.policies[0].metadata.branchCompletionPolicy.completion = 'leave-open';
    expect(await retire({ settleMergedReviewObligation: true })).toMatchObject({ ok: false, reason: 'pr-completion-human-handoff' });
    injected.policies[0].metadata.branchCompletionPolicy.completion = 'review-then-merge';
    expect(await retire()).toMatchObject({ ok: false, reason: 'pr-completion-review-required' });
    expect(await registered(release.path)).toBe(true);
    const result = await retire({ settleMergedReviewObligation: true });
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(release.path)).toBe(false);
    expect((await execGit(['cat-file', '-t', release.head], repo)).stdout.trim()).toBe('commit');
  });

  function reusedBranchOwners(c) {
    const current = { id: 'current-review-owner', status: 'completed', result: { success: true },
      startedAt: '2026-03-01T00:00:00Z', completedAt: '2026-03-01T01:00:00Z',
      metadata: { sourceWorkspace: repo, workspacePath: c.release.path, worktreeBranch: c.release.branch,
        prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { branch: c.release.branch, url: c.forge.prUrl } } };
    // Reused quality branches retain older records with no explicit policy,
    // including unsuccessful launches. Distinct completed checkout incarnations
    // are history; neither their age nor a success summary grants permission.
    const prior = Array.from({ length: 33 }, (_, index) => ({
      id: `prior-owner-${index}`, status: 'completed', result: { success: index !== 0 },
      startedAt: '2026-02-01T00:00:00Z', completedAt: '2026-02-01T01:00:00Z',
      metadata: { sourceWorkspace: repo, workspacePath: join(external, `prior-${index}`), worktreeBranch: c.release.branch },
    }));
    injected.policies = [current, ...prior, {
      id: 'unscoped-successful-recovery', status: 'completed', result: { success: true },
      metadata: { workspacePath: repo, recoveryOrigin: { subsystem: 'repository-cleanup', parentAgentId: current.id } },
    }];
    return current;
  }

  it('retires reviewed metadata with unrelated hashes while recovering only structural reflog and fetch objects', async () => {
    const c = await reviewedCheckout('metadata-hashes');
    const absent = '1'.repeat(40);
    expect((await execGit(['cat-file', '-e', absent], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
    const metadata = Buffer.from(`${JSON.stringify({ reviews: [{ user: { avatar_url: `https://example.invalid/avatar/${absent}` } }], note: '2'.repeat(64) }, null, 2)}\n`);
    await writeFile(join(c.admin, 'portos-pr-review-outcome.json'), metadata);
    await writeFile(join(c.admin, 'COMMIT_EDITMSG'), `Unrelated message hash ${absent}\n`);
    const tree = (await execGit(['rev-parse', 'HEAD^{tree}'], c.path)).stdout.trim();
    const old = (await execGit(['commit-tree', tree, '-m', 'only in the old reflog field'], c.path)).stdout.trim();
    const next = (await execGit(['commit-tree', tree, '-m', 'only in the new reflog field'], c.path)).stdout.trim();
    const fetched = (await execGit(['commit-tree', tree, '-m', 'only in FETCH_HEAD'], c.path)).stdout.trim();
    await writeFile(join(c.admin, 'logs/HEAD'), `${old} ${next} Test <test@example.com> 1 +0000\tmessage ${absent}\n`);
    await writeFile(join(c.admin, 'FETCH_HEAD'), `${fetched}\tnot-for-merge\tbranch '${absent}' of https://example.invalid/repo\n`);
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true);
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(existsSync(c.path)).toBe(false);
    expect((await getBranchReconcileOutcome('app-1')).retired).toContainEqual(expect.objectContaining({
      path: c.release.path, branch: c.release.branch, head: c.release.head, archiveDir: null, branchDeleted: true,
    }));
    for (const oid of [old, next, fetched]) expect((await execGit(['cat-file', '-t', oid], repo)).stdout.trim()).toBe('commit');
    expect((await execGit(['cat-file', '-e', absent], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
  });

  it('retires a freshly reviewed reused-branch incarnation with a standalone archive and exact receipt', async () => {
    const c = await reviewedCheckout('quality-reused', { gitlink: true });
    reusedBranchOwners(c);
    const shared = join(scratch, 'shared-dependencies');
    await mkdir(shared);
    await writeFile(join(shared, 'untouched'), 'shared installation\n');
    if (SYMLINKS) {
      for (const relative of ['node_modules', 'server/node_modules', 'client/node_modules', 'autofixer/node_modules']) {
        await mkdir(dirname(join(c.path, relative)), { recursive: true });
        await symlink(shared, join(c.path, relative), 'dir');
      }
    }
    const policiesBefore = structuredClone(injected.policies);
    const prepared = await c.prepare();
    expect(prepared).toMatchObject({ ok: true, review: { policy: {
      policies: [{ id: 'current-review-owner' }], reviewedPr: { tip: c.release.head, prUrl: c.forge.prUrl },
    } } });
    expect(prepared.review.policy.priorCheckouts).toHaveLength(33);
    expect(prepared.review.comparison.localPatch).toContain('original feature');
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(existsSync(c.path)).toBe(false);
    expect(await registered(c.release.path)).toBe(false);
    expect((await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${c.release.branch}`], repo, { ignoreExitCode: true })).exitCode).not.toBe(0);
    expect((await getBranchReconcileOutcome('app-1')).retired).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: c.release.path, branch: c.release.branch, head: c.release.head,
        archiveDir: null, branchDeleted: true }),
    ]));
    expect(injected.policies).toEqual(policiesBefore);
    expect(await readFile(join(shared, 'untouched'), 'utf8')).toBe('shared installation\n');
  });

  it.each(['head-mismatch', 'same-checkout-failed', 'ambiguous-history', 'current-manual', 'current-active', 'checkout-alias', 'primary-alias'])(
    'keeps the full original checkout when reused-branch proof changes: %s', async change => {
      const c = await reviewedCheckout('quality-held', { ignoredPayload: true });
      const current = reusedBranchOwners(c);
      const prepared = await c.prepare();
      expect(prepared.ok).toBe(true);
      if (change === 'head-mismatch') c.forge.prHead = c.forge.changeBase;
      if (change === 'same-checkout-failed') injected.policies[1].metadata.workspacePath = c.release.path;
      if (change === 'ambiguous-history') delete injected.policies[1].metadata.workspacePath;
      if (change === 'current-manual') current.metadata.prCompletionPolicy = 'leave-open';
      if (change === 'current-active') current.status = 'running';
      if (change === 'checkout-alias' || change === 'primary-alias') {
        const alias = join(external, 'historical-alias');
        await symlink(change === 'checkout-alias' ? c.path : repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
        injected.policies[1].metadata.workspacePath = alias;
      }
      expect(await c.confirm(prepared.review)).toMatchObject({ ok: false });
      expect(await lockText(c.release.path)).toBe(c.release.lockReason);
      expect((await execGit(['rev-parse', `refs/heads/${c.release.branch}`], repo)).stdout.trim()).toBe(c.release.head);
      expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe('ignored work\n');
    });

  it('preserves the checkout and inventory when private administration is recreated behind an unchanged Git pointer', async () => {
    const c = await reviewedCheckout('replaced-administration', { ignoredPayload: true });
    await writeFile(join(c.path, 'untracked.txt'), 'untracked work\n');
    const { readCompletedCheckoutIdentity } = await import('./completedCheckoutEvidence.js');
    const identity = await readCompletedCheckoutIdentity({ repoPath: repo, ...c.release, allowLocked: true });
    expect(identity).not.toBeNull();
    const checkoutIdentity = await readRetirementCheckoutIdentity(c.path);
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release,
      checkoutIdentity, checkoutIncarnation: identity.incarnation, reason: 'retirement-review-pending' }] });
    const before = await getBranchReconcileOutcome('app-1');
    const prepared = await c.prepare();
    expect(prepared.ok).toBe(true); // Tuple-only clients use the stored full identity.
    const pointer = await readFile(join(c.path, '.git'));
    const index = await readFile(join(c.admin, 'index'));
    const tracked = await readFile(join(c.path, 'initial.txt'));
    const preserved = join(scratch, 'preserved-administration');
    await rename(c.admin, preserved);
    await cp(preserved, c.admin, { recursive: true });
    expect((await execGit(['worktree', 'list', '--porcelain'], repo)).stdout.split('\n')
      .filter(line => line === `branch refs/heads/${c.release.branch}`)).toHaveLength(1);
    expect(await readRetirementCheckoutIdentity(c.path)).toBe(checkoutIdentity);
    expect(await c.prepare()).toMatchObject({ ok: false, reason: 'checkout-identity-changed' });
    expect(await c.confirm(prepared.review)).toMatchObject({ ok: false, reason: 'checkout-identity-changed' });
    expect(await readFile(join(c.path, '.git'))).toEqual(pointer);
    expect(await readFile(join(c.admin, 'index'))).toEqual(index);
    expect(await readFile(join(c.path, 'initial.txt'))).toEqual(tracked);
    expect(await readFile(join(preserved, 'index'))).toEqual(index);
    expect(await readFile(join(c.admin, 'portos-review-status'), 'utf8')).toBe('private synthetic review marker');
    expect(await readFile(join(c.path, 'ignored.txt'), 'utf8')).toBe('ignored work\n');
    expect(await readFile(join(c.path, 'untracked.txt'), 'utf8')).toBe('untracked work\n');
    expect(await lockText(c.path)).toBe(c.release.lockReason);
    expect((await execGit(['rev-parse', `refs/heads/${c.release.branch}`], repo)).stdout.trim()).toBe(c.release.head);
    expect(await registered(c.path)).toBe(true);
    const after = await getBranchReconcileOutcome('app-1');
    expect(after.remaining).toEqual(before.remaining);
    expect(after.retired).toEqual(before.retired);
    expect(after.retirementObligations).toEqual(before.retirementObligations);
  });

  describe.each(['content', 'index', 'administration', 'default', 'pr-head', 'policy', 'submodule', 'inventory'])('changed %s evidence between review and confirmation', change => {
    let c;
    let prepared;
    // Fixture construction, preview and confirmation are distinct real-Git
    // workflows; each retains the existing 30-second phase budget.
    beforeEach(async () => {
      c = await reviewedCheckout('changed-review', { gitlink: true });
    });
    beforeEach(async () => {
      prepared = await c.prepare();
      expect(prepared.ok).toBe(true);
    });
    it('refuses confirmation and retains the checkout, lock and archive state', async () => {
      if (change === 'content') await writeFile(join(c.path, 'wanted.txt'), 'new local work');
      if (change === 'index') { await writeFile(join(c.path, 'staged.txt'), 'new index'); await execGit(['add', 'staged.txt'], c.path); }
      if (change === 'administration') await writeFile(join(c.admin, 'portos-review-status'), 'new review');
      if (change === 'default') {
        await writeFile(join(repo, 'later.txt'), 'later default');
        await execGit(['add', 'later.txt'], repo); await execGit(['commit', '-m', 'later default'], repo);
        c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
      }
      if (change === 'pr-head') c.forge.prHead = c.forge.defaultHead;
      if (change === 'policy') injected.policies[0].metadata.prCompletionPolicy = 'leave-open';
      if (change === 'submodule') await writeFile(join(c.path, 'vendor', 'unique.txt'), 'submodule work');
      if (change === 'inventory') injected.schedule.executions = {};
      const result = await c.confirm(prepared.review);
      expect(result.ok).toBe(false);
      expect(await registered(c.release.path)).toBe(true);
      expect(await lockText(c.release.path)).toBe(c.release.lockReason);
    });
  });

  it.each(['running', 'paused'])('refuses a %s owner that arrives after preparation', async status => {
    const c = await reviewedCheckout('owner-review');
    const prepared = await c.prepare();
    const result = await c.confirm(prepared.review, { readAgents: async () => [{ id: 'agent-live', status,
      metadata: { workspacePath: repo, claimBranches: [c.release.branch] } }] });
    expect(result).toMatchObject({ ok: false, reason: 'claim-owner-active' });
    expect(await registered(c.release.path)).toBe(true);
  });

  it.each(['confirmed', 'unconfirmed', 'human-handoff', 'active-owner', 'changed-default', 'changed-source'])('reviews source-superseded local work through the existing archive fence: %s', async scenario => {
    const c = await reviewedCheckout(`source-${scenario}`, { superseded: scenario !== 'unconfirmed' });
    c.forge.prHead = c.forge.firstCommit = c.forge.mergeCommit;
    c.forge.changeBase = (await execGit(['rev-parse', `${c.forge.firstCommit}^`], repo)).stdout.trim();
    c.forge.sourceSupersessionHead = c.release.head;
    const prepare = () => prepareInventoriedCheckoutRetirement({ appId: 'app-1', release: c.release,
      prUrl: c.forge.prUrl, kind: 'source-supersession' }, c.opts);
    if (scenario === 'human-handoff') injected.policies[0].metadata.prCompletionPolicy = 'leave-open';
    if (scenario === 'active-owner') c.opts.readAgents = async () => [{ id: 'live', status: 'running', metadata: { workspacePath: repo, claimBranches: [c.release.branch] } }];
    const prepared = await prepare();
    if (['human-handoff', 'active-owner'].includes(scenario)) {
      expect(prepared.ok).toBe(false);
      expect(await registered(c.path)).toBe(true);
      return;
    }
    expect(prepared).toMatchObject({ ok: true, review: { kind: 'source-supersession',
      forge: { sourceSupersessionHead: c.release.head }, comparison: { disposition: 'review-supersession' } } });
    if (scenario === 'changed-source') await writeFile(join(c.path, 'ignored.txt'), 'new local work\n');
    if (scenario === 'changed-default') {
      await writeFile(join(repo, 'later.txt'), 'new default\n');
      await execGit(['add', 'later.txt'], repo);
      await execGit(['commit', '-m', 'later default'], repo);
      c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
    }
    const result = await retireInventoriedCheckout({ appId: 'app-1', release: c.release, review: {
      prUrl: c.forge.prUrl, digest: prepared.review.digest, kind: 'source-supersession', acceptSuperseded: scenario !== 'unconfirmed',
    } }, c.opts);
    if (scenario !== 'confirmed') {
      expect(result).toMatchObject({ ok: false, reason: scenario === 'unconfirmed' ? 'retirement-supersession-not-accepted' : 'retirement-review-changed' });
      expect(await registered(c.path)).toBe(true);
      return;
    }
    expect(result).toMatchObject({ ok: true, branchDeleted: true });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(c.path)).toBe(false);
    expect((await getBranchReconcileOutcome('app-1')).retired).toEqual(expect.arrayContaining([expect.objectContaining({ head: c.release.head, archiveDir: null })]));
    expect((await execGit(['show', `${c.release.head}:feature.txt`], repo)).stdout).toBe('original feature\n');
  });

  it.each(['confirmed', 'human-handoff', 'published-owner'])('reviews an exact merged detached checkout without borrowing branch retirement: %s', async scenario => {
    const c = await reviewedCheckout(`detached-review-${scenario}`);
    const publishedBranch = c.release.branch;
    await execGit(['switch', '--detach', c.release.head], c.path);
    c.release.branch = null;
    c.forge.publishedBranch = publishedBranch;
    c.forge.exactAliasHead = c.release.head;
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [{ ...c.release, reason: 'worktree-unmanaged-location' }] });
    if (scenario === 'human-handoff') injected.policies[0].metadata.prCompletionPolicy = 'leave-open';
    if (scenario === 'published-owner') c.opts.readAgents = async () => [{ id: 'live', status: 'running', metadata: { workspacePath: repo, claimBranches: [publishedBranch] } }];
    const prepared = await c.prepare();
    if (scenario !== 'confirmed') {
      expect(prepared.ok).toBe(false);
      expect(await registered(c.path)).toBe(true);
      return;
    }
    expect(prepared.ok).toBe(true);
    const result = await c.confirm(prepared.review);
    expect(result).toMatchObject({ ok: true, branchDeleted: false });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(c.path)).toBe(false);
    expect((await execGit(['rev-parse', publishedBranch], repo)).stdout.trim()).toBe(c.release.head);
  });

  it.each(['confirmed', 'owner-alias', 'missing-receipt', 'same-incarnation', 'human-handoff', 'active-owner', 'normal-completed', 'normal-invalid-time', 'normal-resumed-lineage', 'separate-incomplete', 'separate-retained-work', 'separate-same-incarnation', 'separate-replaced-pointer', 'separate-malformed-capture', 'separate-missing-receipt', 'separate-wrong-pr'])('keeps an original sibling obligation separate from a detached copy: %s', async scenario => {
    const c = await reviewedCheckout(`orphan-sibling-${scenario}`, { normalMerge: scenario.startsWith('separate-') });
    const namedPath = c.path;
    const namedBranch = c.release.branch;
    await execGit(['worktree', 'unlock', namedPath], repo);
    if (scenario === 'separate-retained-work') {
      await writeFile(join(namedPath, 'unpublished-reviewer.txt'), 'unique unfinished reviewer work\n');
      await execGit(['add', 'unpublished-reviewer.txt'], namedPath);
      await execGit(['commit', '-m', 'unfinished reviewer work'], namedPath);
    }
    const capturedHead = (await execGit(['rev-parse', 'HEAD'], namedPath)).stdout.trim();
    const evidence = await import('./completedCheckoutEvidence.js');
    const agent = { id: 'sibling-owner', status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString(),
      metadata: { sourceWorkspace: repo, workspacePath: namedPath, isWorktree: true, worktreeBranch: namedBranch,
        prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { url: c.forge.prUrl, branch: namedBranch } } };
    agent.metadata.checkoutSeeds = await evidence.captureCheckoutSeeds(agent);
    // Completion records the exact terminal target before publishing the orphan.
    const targets = await evidence.captureSeededCompletionCheckouts(agent, { preterminal: true });
    expect(targets).toEqual([expect.objectContaining({ head: capturedHead, startedAt: agent.startedAt })]);
    agent.metadata.checkoutCapture = { status: 'captured', targets, unknown: false };
    agent.status = 'completed'; agent.completedAt = new Date().toISOString();
    agent.result = { success: false, executionSuccess: false, orphaned: true, validationPassed: null };
    agent.metadata.completedCheckouts = await evidence.captureSeededCompletionCheckouts(agent);
    expect(agent.metadata.completedCheckouts).toHaveLength(1);
    if (scenario.startsWith('normal-')) {
      agent.result = { success: false, executionSuccess: true, validationPassed: true, cleanupPending: true,
        taskOutcome: { status: 'incomplete', recovery: { mode: 'cleanup' } } };
      agent.metadata.completedCheckouts = agent.metadata.completedCheckouts.map(row => ({ ...row, version: 1,
        capturedAt: scenario === 'normal-invalid-time' ? new Date(Date.parse(agent.completedAt) + 1000).toISOString() : agent.completedAt }));
    }
    if (scenario.startsWith('separate-')) {
      agent.result = { success: false, executionSuccess: true, validationPassed: null,
        taskOutcome: { status: 'blocked', reason: 'Earlier CI did not finish' } };
      // Captures use native canonical paths; app inventories may use Git's
      // spelling. Even a portable trailing separator must not lose the proof.
      for (const row of [...agent.metadata.checkoutSeeds, ...agent.metadata.completedCheckouts]) row.repoPath += '/';
      if (scenario === 'separate-wrong-pr') agent.metadata.reviewLoopMergeTarget.url = 'https://github.com/example/repo/pull/43';
    }
    const originalResult = structuredClone(agent.result);
    if (scenario === 'owner-alias') {
      const alias = join(external, 'canonical-owner-alias');
      await symlink(namedPath, alias, 'junction');
      agent.metadata.workspacePath = alias;
    }
    let path = join(external, `detached-${scenario}`);
    if (scenario === 'same-incarnation' || scenario === 'separate-same-incarnation' || scenario === 'separate-replaced-pointer') {
      const pointerIdentity = await readRetirementCheckoutIdentity(namedPath);
      await execGit(['worktree', 'move', namedPath, path], repo);
      await execGit(['switch', '--detach', c.release.head], path);
      expect(await readRetirementCheckoutIdentity(path)).toBe(pointerIdentity);
      if (scenario === 'separate-replaced-pointer') {
        const bytes = await readFile(join(path, '.git'));
        await rename(join(path, '.git'), join(scratch, 'prior-checkout-pointer'));
        await writeFile(join(path, '.git'), bytes);
        expect(await readRetirementCheckoutIdentity(path)).not.toBe(pointerIdentity);
      }
    }
    else {
      await execGit(['worktree', 'add', '--detach', path, c.release.head], repo);
    }
    // Real inventories use Git's observed spelling. Windows temp paths can
    // differ from that registration (including short names and drive casing).
    path = (await execGit(['rev-parse', '--show-toplevel'], path)).stdout.trim();
    expect(await registered(path)).toBe(true);
    const release = { path, branch: null, head: c.release.head, locked: false, lockReason: null };
    c.forge.publishedBranch = namedBranch; c.forge.exactAliasHead = release.head;
    if (scenario.startsWith('separate-')) {
      await writeFile(join(repo, 'later-reviewed.txt'), 'later reviewed correction\n');
      await execGit(['add', 'later-reviewed.txt'], repo);
      await execGit(['commit', '-m', 'final delivered correction'], repo);
      const deliveredHead = (await execGit(['rev-parse', 'HEAD'], repo)).stdout.trim();
      const targetTree = (await execGit(['rev-parse', 'HEAD^{tree}'], repo)).stdout.trim();
      Object.assign(c.forge, { prHead: deliveredHead, mergeCommit: deliveredHead, defaultHead: deliveredHead,
        scopeProof: 'represented-detached-head', detachedRepresentation: {
          sourceHead: release.head, deliveredHead, base: release.head, targetTree, sourceCommits: 0,
        } });
    }
    if (scenario.startsWith('separate-')) {
      // The real represented-head reader intentionally omits historical patch
      // fields. Missing current-base objects still need a proof-bound fetch.
      delete c.forge.changeBase; delete c.forge.firstCommit;
      if (scenario === 'separate-incomplete') {
        const remote = join(scratch, 'represented-proof-remote');
        await execGit(['clone', '--no-hardlinks', repo, remote], scratch);
        await execGit(['config', 'user.email', 'test@example.com'], remote);
        await execGit(['config', 'user.name', 'Test'], remote);
        await execGit(['commit', '--allow-empty', '-m', 'remote-only default advance'], remote);
        c.forge.defaultHead = (await execGit(['rev-parse', 'HEAD'], remote)).stdout.trim();
        await addProofOrigin();
        injected.fetchRemote = remote;
      }
    }
    injected.policies = [agent];
    let lineageControls = [];
    if (scenario === 'normal-resumed-lineage') {
      agent.taskId = 'original-cleanup-task';
      const ancestors = ['failed-first', 'failed-second'].map((id, index) => {
        const startedAt = new Date(Date.parse(agent.startedAt) - (2 - index) * 60_000).toISOString();
        const completedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
        const workspacePath = join(external, id);
        return { id, taskId: agent.taskId, status: 'completed', startedAt, completedAt,
          result: { success: false, executionSuccess: false, validationPassed: null },
          metadata: { sourceWorkspace: repo, workspacePath, worktreeBranch: namedBranch,
            prCompletionPolicy: 'review-then-merge', reviewLoopMergeTarget: { branch: namedBranch, url: c.forge.prUrl },
            resumedFromAgentId: index ? 'failed-first' : null,
            completedCheckouts: [{ ...agent.metadata.completedCheckouts[0], version: 1, agentId: id,
              startedAt, capturedAt: completedAt, path: workspacePath }] } };
      });
      agent.metadata.resumedFromAgentId = 'failed-second';
      injected.policies = [...ancestors, agent];
      const differentGeneration = structuredClone(agent.metadata.completedCheckouts[0].incarnation);
      differentGeneration.pointer.ino = String(BigInt(differentGeneration.pointer.ino) + 1n);
      lineageControls = [[ancestors[0], 'taskId', 'unrelated-task'],
        [ancestors[0].metadata.completedCheckouts[0], 'incarnation', differentGeneration],
        [ancestors[0].metadata, 'prCompletionPolicy', 'leave-open'], [ancestors[0], 'status', 'running']];
    }
    if (scenario === 'separate-malformed-capture') {
      agent.metadata.completedCheckouts[0].version = 1;
      delete agent.metadata.completedCheckouts[0].incarnation.gitdir;
    }
    if (scenario === 'missing-receipt' || scenario === 'separate-missing-receipt') agent.metadata.completedCheckouts = [];
    if (scenario === 'human-handoff') agent.metadata.prCompletionPolicy = 'leave-open';
    if (scenario === 'active-owner') { agent.status = 'running'; c.opts.readAgents = async () => [agent]; }
    const originalRelease = scenario === 'normal-resumed-lineage'
      ? { ...c.release, locked: false, lockReason: null, checkoutIdentity: await readRetirementCheckoutIdentity(namedPath) } : null;
    await recordBranchReconcileOutcome('app-1', { status: 'incomplete', remaining: [
      ...(scenario === 'normal-resumed-lineage' ? [{ ...originalRelease, reason: 'retirement-receipt-unverified' }] : []),
      { ...release, reason: 'worktree-unmanaged-location' },
    ] });
    const originalPolicies = structuredClone(injected.policies);
    for (const [target, key, value] of lineageControls) {
      const prior = target[key]; target[key] = value;
      const refused = await prepareInventoriedCheckoutRetirement({ appId: 'app-1', release, prUrl: c.forge.prUrl }, c.opts);
      expect(refused, `${key}: ${JSON.stringify(refused)}`).toMatchObject({ ok: false });
      expect(await registered(path)).toBe(true); expect(await registered(namedPath)).toBe(true);
      target[key] = prior;
    }
    const prepared = await prepareInventoriedCheckoutRetirement({ appId: 'app-1', release, prUrl: c.forge.prUrl }, c.opts);
    if (!['confirmed', 'owner-alias', 'normal-completed', 'normal-resumed-lineage', 'separate-incomplete', 'separate-retained-work'].includes(scenario)) {
      const reason = scenario === 'human-handoff' ? 'pr-completion-human-handoff'
        : 'retirement-policy-not-legacy-completed';
      expect(prepared).toMatchObject({ ok: false, reason });
      expect(await registered(path)).toBe(true);
      return;
    }
    expect(prepared.reason).toBeUndefined();
    if (scenario === 'separate-incomplete') {
      expect(injected.fetches).toHaveLength(1);
      expect(injected.fetches[0].args).toContain(c.forge.defaultHead);
      expect((await execGit(['rev-parse', 'main'], repo)).stdout.trim()).toBe(c.forge.mergeCommit);
      expect(existsSync(join(repo, '.git', 'FETCH_HEAD'))).toBe(false);
    }
    if (scenario === 'normal-resumed-lineage') {
      const detachedIdentity = await readRetirementCheckoutIdentity(path);
      expect(prepared).toMatchObject({ ok: true, review: { policy: { policies: [
        { id: 'failed-first', success: false, resumedCleanup: { successorAgentId: agent.id, detachedCheckoutIdentity: detachedIdentity,
          checkoutIncarnation: agent.metadata.completedCheckouts[0].incarnation } },
        { id: 'failed-second', success: false, resumedCleanup: { successorAgentId: agent.id, detachedCheckoutIdentity: detachedIdentity } },
        { id: agent.id, success: false, completedSibling: true },
      ] } } });
    }
    else expect(prepared).toMatchObject({ ok: true, review: { policy: { policies: [{ success: false,
      ...(scenario.startsWith('separate-') ? { retainedSiblingObligation: agent.metadata.completedCheckouts[0] }
        : scenario === 'normal-completed' ? { completedSibling: true } : { orphanedSibling: true }) }] } } });
    const result = await retireInventoriedCheckout({ appId: 'app-1', release,
      review: { prUrl: c.forge.prUrl, digest: prepared.review.digest, acceptSuperseded: false } }, c.opts);
    expect(result).toMatchObject({ ok: true, branchDeleted: false });
    expect(result.archiveDir).toBeUndefined();
    expect(await registered(path)).toBe(false);
    expect(await registered(namedPath)).toBe(true);
    expect((await execGit(['rev-parse', namedBranch], repo)).stdout.trim()).toBe(capturedHead);
    if (scenario === 'separate-retained-work') {
      expect((await execGit(['merge-base', '--is-ancestor', capturedHead, c.forge.prHead], repo, { ignoreExitCode: true })).exitCode).toBe(1);
      expect(await readFile(join(namedPath, 'unpublished-reviewer.txt'), 'utf8')).toBe('unique unfinished reviewer work\n');
    }
    expect(agent.result).toEqual(originalResult);
    expect(injected.policies).toEqual(originalPolicies);
    if (scenario === 'normal-resumed-lineage') {
      const outcome = await getBranchReconcileOutcome('app-1');
      expect(outcome.remaining).toContainEqual(expect.objectContaining({ path: namedPath, branch: namedBranch, reason: 'retirement-receipt-unverified' }));
      const copyReceipt = outcome.retired.find(row => row.path === path);
      expect(copyReceipt).toMatchObject({ head: release.head, branchDeleted: false,
        checkoutIdentity: prepared.review.policy.policies.find(row => row.id === agent.id).detachedCheckoutIdentity });
      expect(copyReceipt.branch ?? null).toBeNull();
      expect(outcome.retired.some(row => row.path === namedPath)).toBe(false);
    }
  });

  it('preserves archive and checkout when fresh forge evidence changes after archiving', async () => {
    const c = await reviewedCheckout('late-forge');
    const prepared = await c.prepare();
    let reads = 0;
    const result = await c.confirm(prepared.review, { readForge: async () => ({ ...c.forge, remoteHead: ++reads === 1 ? null : c.release.head }) });
    expect(result).toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    expect(result.archiveDir).toBeUndefined();
    expect(await readFile(join(c.path, 'feature.txt'), 'utf8')).toBe('original feature\n');
    expect(await registered(c.release.path)).toBe(true);
    expect(await lockText(c.release.path)).toBe(c.release.lockReason);
  });
  async function removedCheckoutWithSurvivingRef(name) {
    const c = await reviewedCheckout(name, { normalMerge: true });
    c.forge.scopeProof = 'exact-delivered-head';
    const checkoutIdentity = await readRetirementCheckoutIdentity(c.path);
    await execGit(['worktree', 'unlock', c.path], repo);
    await execGit(['worktree', 'remove', '--force', c.path], repo);
    await recordHeldCheckoutRetirement('app-1', { ...c.release, checkoutIdentity, branchDeleted: false });
    const receipt = (await getBranchReconcileOutcome('app-1')).retired[0];
    const release = { path: receipt.path, head: receipt.head, branch: receipt.branch,
      checkoutIdentity, locked: false, lockReason: null };
    const input = { appId: 'app-1', release, prUrl: c.forge.prUrl };
    const prepared = await prepareInventoriedCheckoutRetirement(input, c.opts);
    expect(prepared).toMatchObject({ ok: true });
    const request = { appId: 'app-1', release, review: { digest: prepared.review.digest, prUrl: c.forge.prUrl, acceptSuperseded: false } };
    return { ...c, release, input, request, receipt };
  }

  it('finalizes only the surviving ref and preserves the canonical physical-removal receipt on retry', async () => {
    const c = await removedCheckoutWithSurvivingRef('ref-only-finalization');
    await recordHeldCheckoutRetirement('app-1', c.receipt); // Replayed physical-removal producer.
    expect((await getBranchReconcileOutcome('app-1')).retired).toEqual([c.receipt]);
    expect(await retireInventoriedCheckout(c.request, c.opts)).toEqual({ ok: true, branchDeleted: true });
    expect(await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${c.release.branch}`], repo, { ignoreExitCode: true }))
      .toMatchObject({ exitCode: 1 });
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.retired).toHaveLength(1);
    expect(outcome.retired[0]).toMatchObject({ ...c.receipt, branchDeleted: true, branchFinalizedAt: expect.any(String) });
    expect(Object.values(outcome.retirementReceiptEvidence)).toContainEqual(outcome.retired[0]);
    await recordHeldCheckoutRetirement('app-1', c.receipt); // A late partial phase cannot regress completion.
    expect((await getBranchReconcileOutcome('app-1')).retired).toEqual(outcome.retired);
    expect(await retireInventoriedCheckout(c.request, c.opts)).toEqual({ ok: true, branchDeleted: true });
    expect((await getBranchReconcileOutcome('app-1')).retired[0]).toEqual(outcome.retired[0]);
    await execGit(['branch', c.release.branch, c.release.head], repo);
    expect(await retireInventoriedCheckout(c.request, c.opts)).toMatchObject({ ok: false, reason: 'branch-ref-changed-or-recreated' });
  });

  it.each(['dangling symbolic', 'resolved symbolic', 'malformed loose'])(
    'holds ref-only finalization when a %s ref cannot establish absence', async kind => {
      const c = await removedCheckoutWithSurvivingRef(`ref-only-unreadable-${kind.replaceAll(' ', '-')}`);
      const ref = `refs/heads/${c.release.branch}`;
      const refPath = join(repo, '.git', ref);
      await execGit(['update-ref', '-d', ref], repo);
      if (kind === 'resolved symbolic') await execGit(['branch', 'symbolic-target', c.release.head], repo);
      if (kind.endsWith('symbolic')) await execGit(['symbolic-ref', ref,
        kind === 'resolved symbolic' ? 'refs/heads/symbolic-target' : 'refs/heads/missing-target'], repo);
      else {
        await mkdir(dirname(refPath), { recursive: true });
        await writeFile(refPath, 'not a valid ref\n');
      }
      const before = await readFile(refPath, 'utf8');
      expect((await execGit(['show-ref', '--verify', '--quiet', ref], repo, { ignoreExitCode: true })).exitCode)
        .toBe(kind === 'resolved symbolic' ? 0 : 1);
      expect(await retireInventoriedCheckout(c.request, c.opts))
        .toMatchObject({ ok: false, reason: 'branch-ref-presence-unverified' });
      expect(await readFile(refPath, 'utf8')).toBe(before);
      expect((await getBranchReconcileOutcome('app-1')).retired[0]).toEqual(c.receipt);
      if (kind === 'resolved symbolic') expect((await execGit(['rev-parse', 'refs/heads/symbolic-target'], repo)).stdout.trim()).toBe(c.release.head);
    });

  it.each(['tip', 'holder', 'receipt', 'forge', 'path', 'policy', 'owner', 'repository'])(
    'refuses ref-only finalization when reviewed %s changes before mutation', async change => {
      const c = await removedCheckoutWithSurvivingRef(`ref-only-${change}`);
      let ownerStarted = false;
      const result = await retireInventoriedCheckout(c.request, { ...c.opts, beforeMutation: async () => {
        if (change === 'repository') injected.app.repoPath = external;
        if (change === 'tip') await execGit(['update-ref', `refs/heads/${c.release.branch}`, c.forge.changeBase], repo);
        if (change === 'holder') await execGit(['worktree', 'add', join(external, 'new-holder'), c.release.branch], repo);
        if (change === 'receipt') (await getBranchReconcileOutcome('app-1')).retired[0].checkoutIdentity = 'f'.repeat(64);
        if (change === 'forge') c.forge.prHead = c.forge.changeBase;
        if (change === 'path') await mkdir(c.release.path);
        if (change === 'policy') injected.policies[0].status = 'running';
        if (change === 'owner') ownerStarted = true;
      }, ...(change === 'owner' && { readAgents: async () => ownerStarted ? [{ id: 'active-owner', status: 'running',
        metadata: { claimBranches: [c.release.branch], sourceWorkspace: repo } }] : [] }) });
      expect(result.ok).toBe(false);
      expect((await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${c.release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(0);
      expect((await getBranchReconcileOutcome('app-1')).retired[0].branchDeleted).toBe(false);
    });

  it('requires the exact canonical removal receipt and exact PR delivery for ref-only review', async () => {
    const c = await removedCheckoutWithSurvivingRef('ref-only-invalid-proof');
    expect(await prepareInventoriedCheckoutRetirement({ ...c.input, release: { ...c.release, checkoutIdentity: '0'.repeat(64) } }, c.opts))
      .toMatchObject({ ok: false, reason: 'release-not-in-inventory' });
    expect(await prepareInventoriedCheckoutRetirement({ ...c.input, prUrl: 'https://github.com/example/repo/pull/999' }, c.opts))
      .toMatchObject({ ok: false, reason: 'retirement-exact-delivery-unverified' });
  });

  it('keeps explicit human handoffs and stale ref-only approvals refused', async () => {
    const c = await removedCheckoutWithSurvivingRef('ref-only-handoff');
    expect(await retireInventoriedCheckout({ ...c.request, review: { ...c.request.review, digest: '0'.repeat(64) } }, c.opts))
      .toMatchObject({ ok: false, reason: 'retirement-review-changed' });
    injected.policies[0].metadata.prCompletionPolicy = 'leave-open';
    expect(await prepareInventoriedCheckoutRetirement(c.input, c.opts))
      .toMatchObject({ ok: false, reason: 'pr-completion-human-handoff' });
    expect(await prepareInventoriedCheckoutRetirement({ ...c.input, appId: 'different-app' }, c.opts))
      .toMatchObject({ ok: false, reason: 'app-not-found' });
  });

  it('retries ref-only receipt persistence after CAS without deleting twice or changing retiredAt', async () => {
    const c = await removedCheckoutWithSurvivingRef('ref-only-persistence-failure');
    let deletions = 0;
    retirementFaults.onBranchDelete = async () => { deletions++; };
    retirementFaults.failScheduleWrite = retirementFaults.scheduleWrites + 1;
    expect(await retireInventoriedCheckout(c.request, c.opts))
      .toEqual({ ok: false, branchDeleted: true, reason: 'synthetic receipt persistence failure' });
    expect((await getBranchReconcileOutcome('app-1')).retired[0]).toEqual(c.receipt);
    expect((await execGit(['show-ref', '--verify', '--quiet', `refs/heads/${c.release.branch}`], repo, { ignoreExitCode: true })).exitCode).toBe(1);
    retirementFaults.failScheduleWrite = null;
    expect(await retireInventoriedCheckout(c.request, c.opts)).toEqual({ ok: true, branchDeleted: true });
    expect(deletions).toBe(1);
    const retired = (await getBranchReconcileOutcome('app-1')).retired;
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({ ...c.receipt, branchDeleted: true, branchFinalizedAt: expect.any(String),
      branchFinalization: { kind: 'observed-absent' } });
  });

  it('keeps post-CAS receipt recovery held by a new owner or recreated ref', async () => {
    const c = await removedCheckoutWithSurvivingRef('ref-only-retry-holder');
    retirementFaults.failScheduleWrite = retirementFaults.scheduleWrites + 1;
    expect(await retireInventoriedCheckout(c.request, c.opts)).toMatchObject({ ok: false, branchDeleted: true });
    retirementFaults.failScheduleWrite = null;
    const owner = async () => [{ id: 'new-owner', status: 'running', metadata: {
      claimBranches: [c.release.branch], sourceWorkspace: repo,
    } }];
    expect(await retireInventoriedCheckout(c.request, { ...c.opts, readAgents: owner }))
      .toMatchObject({ ok: false, reason: 'claim-owner-active' });
    await execGit(['branch', c.release.branch, c.forge.changeBase], repo);
    expect(await retireInventoriedCheckout(c.request, c.opts))
      .toMatchObject({ ok: false, reason: 'branch-ref-changed-or-recreated' });
    expect((await getBranchReconcileOutcome('app-1')).retired[0]).toEqual(c.receipt);
  });

  it('finalizes ref-only removal evidence after display eviction without settling the partial receipt early', async () => {
    const c = await removedCheckoutWithSurvivingRef('ref-only-evicted');
    const before = await getBranchReconcileOutcome('app-1');
    expect(Object.values(before.retirementReceiptEvidence)).toContainEqual(c.receipt);
    const { hasRetirementReceipt } = await import('../lib/reconcileRetirementEvidence.js');
    expect(hasRetirementReceipt(before, c.release)).toBe(false);
    for (let index = 0; index < 21; index++) await recordHeldCheckoutRetirement('app-1', {
      path: `/synthetic/eviction-${index}`, branch: `feature/eviction-${index}`, head: c.release.head,
      checkoutIdentity: `${index}`.padStart(64, '0'), branchDeleted: true,
    });
    const evicted = await getBranchReconcileOutcome('app-1');
    expect(evicted.retired.some(row => row.branch === c.release.branch)).toBe(false);
    expect(Object.values(evicted.retirementReceiptEvidence)).toContainEqual(c.receipt);
    // Reload JSON as a restart would: durable evidence must be sufficient alone.
    injected.schedule = JSON.parse(JSON.stringify(injected.schedule));
    const prepared = await prepareInventoriedCheckoutRetirement(c.input, c.opts);
    expect(prepared.ok).toBe(true);
    expect(await retireInventoriedCheckout({ ...c.request, review: { ...c.request.review, digest: prepared.review.digest } }, c.opts))
      .toEqual({ ok: true, branchDeleted: true });
    const final = await getBranchReconcileOutcome('app-1');
    const receipt = Object.values(final.retirementReceiptEvidence).find(row => row.branch === c.release.branch);
    expect(receipt).toMatchObject({ ...c.receipt, branchDeleted: true, branchFinalizedAt: expect.any(String),
      branchFinalization: { kind: 'deleted' } });
    expect(hasRetirementReceipt(final, c.release)).toBe(true);
    expect(await retireInventoriedCheckout(c.request, c.opts)).toEqual({ ok: true, branchDeleted: true });
  });

  it('clears and audits only current matching branch-only ref-finalization inventory rows', async () => {
    const c = await removedCheckoutWithSurvivingRef('ref-only-branch-inventory');
    const removed = [{ branch: c.release.branch, reason: 'cleanup-disabled' },
      { branch: c.release.branch, path: c.release.path, head: c.release.head, reason: 'cleanup-disabled' }];
    const kept = [{ branch: c.release.branch, head: c.forge.changeBase, reason: 'cleanup-disabled' },
      { branch: c.release.branch, checkoutIdentity: 'f'.repeat(64), reason: 'cleanup-disabled' },
      { branch: c.release.branch, path: '/synthetic/different-checkout', reason: 'cleanup-disabled' },
      { branch: 'feature/other', reason: 'cleanup-disabled' }];
    (await getBranchReconcileOutcome('app-1')).remaining = [...removed, ...kept];
    expect(await retireInventoriedCheckout(c.request, c.opts)).toEqual({ ok: true, branchDeleted: true });
    const outcome = await getBranchReconcileOutcome('app-1');
    expect(outcome.remaining).toEqual(kept);
    const receipt = outcome.retired.find(row => row.branch === c.release.branch);
    expect(receipt.retiredAt).toBe(c.receipt.retiredAt);
    expect(receipt.settledObservations).toEqual(removed.map(observation => ({ observation, settledAt: receipt.branchFinalizedAt })));
    expect(await retireInventoriedCheckout(c.request, c.opts)).toEqual({ ok: true, branchDeleted: true });
    // A delayed ordinary inventory row requires fresh absence and its own audit.
    const delayed = { branch: c.release.branch, reason: 'cleanup-disabled', observedAt: new Date().toISOString() };
    (await getBranchReconcileOutcome('app-1')).remaining.push(delayed);
    expect(await retireInventoriedCheckout(c.request, c.opts)).toEqual({ ok: true, branchDeleted: true });
    const replayed = await getBranchReconcileOutcome('app-1');
    expect(replayed.remaining).toEqual(kept);
    expect(replayed.retired[0].branchFinalizedAt).toBe(receipt.branchFinalizedAt);
    expect(replayed.retired[0].branchFinalization).toEqual({ kind: 'deleted' });
    const audit = replayed.retired[0].settledObservations.find(row => JSON.stringify(row.observation) === JSON.stringify(delayed));
    expect(audit).toBeDefined();
    expect(Date.parse(audit.settledAt)).toBeGreaterThanOrEqual(Date.parse(delayed.observedAt));
  });
});
