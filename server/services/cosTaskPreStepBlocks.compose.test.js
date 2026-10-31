/**
 * Cross-module wiring guard: `prepareManagedAppImprovementTask`
 * (cosTaskGenerator.js) still COMPOSES the pre-step resolvers that now live in
 * cosTaskPreStepBlocks.js.
 *
 * The extraction moved eight resolvers out of the generator and left the call
 * sites behind. A resolver that is exported from the new module but never
 * re-imported into the generator is a free identifier: the module still LOADS,
 * every source-level guard still passes, and the failure is a ReferenceError on
 * a scheduled task nobody runs in CI. (That exact shape was already latent here
 * — `isTruthyMeta` was destructured in one resolver and used in another.) So the
 * guard has to be a real dispatch through the composed path.
 *
 * branch-reconcile is the case that walks the most of it: the drain cap, the
 * reconcile scan, the convergence gate, and the token renderer that folds the
 * resulting block into the prompt.
 *
 * Isolated file so the mocked leaf graph (taskSchedule / branchReconcile /
 * appActivity) can't leak into the shared cosTaskGenerator suites.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createCosTaskSchema } from '../lib/cosValidation.js';
import { buildQueuedTask } from './cosTaskIntake.js';
import { buildAgentRegistration } from '../lib/agentRegistrationRecord.js';
import { generateTasksMarkdown, parseTasksMarkdown } from '../lib/taskParser.js';
import { retainRetirementObligations } from '../lib/reconcileRetirementEvidence.js';

const BRANCH_RECONCILE_TEMPLATE = [
  '# Branch reconcile for {appName}',
  '',
  'Repository: {repoPath}',
  '',
  '## In-flight branches',
  '',
  '{inFlightBranches}',
].join('\n');

vi.mock('./cosEvents.js', async original => ({ ...await original(), emitLog: vi.fn() }));

vi.mock('./taskPromptService.js', () => ({
  getTaskPrompt: vi.fn(async () => BRANCH_RECONCILE_TEMPLATE),
  getStagePrompt: vi.fn(async () => BRANCH_RECONCILE_TEMPLATE),
}));

const getPerpetualDrainState = vi.fn(async () => ({ signature: null, dispatchCount: 0 }));
const parkPerpetual = vi.fn(async () => {});
const recordPerpetualDispatch = vi.fn(async () => 1);
vi.mock('./taskSchedule.js', () => ({
  INTERVAL_TYPES: { PERPETUAL: 'perpetual', ON_DEMAND: 'on-demand', WEEKLY: 'weekly' },
  getTaskInterval: vi.fn(async () => ({ type: 'perpetual', taskMetadata: {} })),
  stripManagedAgentOptionsFromOverride: vi.fn((_type, meta) => meta),
  recordExecution: vi.fn(async () => {}),
  parkPerpetual: (...a) => parkPerpetual(...a),
  getPerpetualDrainState: (...a) => getPerpetualDrainState(...a),
  recordPerpetualDispatch: (...a) => recordPerpetualDispatch(...a),
}));

vi.mock('./branchReconcileOutcome.js', () => ({
  recordBranchReconcileOutcome: vi.fn(async () => {}),
  getBranchReconcileOutcome: vi.fn(async () => null),
}));

vi.mock('./appActivity.js', async (importActual) => ({
  ...(await importActual()),
  updateAppActivity: vi.fn(async () => {}),
}));

vi.mock('./apps.js', async (importActual) => ({
  ...(await importActual()),
  getAppTaskTypeOverrides: vi.fn(async () => ({})),
  getAppById: async () => admissionFixture.app,
}));

vi.mock('./codeReview.js', async (importActual) => ({
  ...(await importActual()),
  getCodeReviewDefaults: vi.fn(async () => ({ reviewers: ['codex'], usernames: [], optionalReviewers: [] })),
}));

vi.mock('./taskLearning.js', async (importActual) => ({
  ...(await importActual()),
  getTaskTypeConfidence: vi.fn(async () => ({ autoApprove: true, tier: 'high', reason: 'test' })),
}));

// The reconcile scan is the git/gh-touching half; the classification helpers it
// feeds stay REAL so the block the prompt receives is the real rendering.
vi.mock('./repoCleanupRecovery.js', () => ({ inspectOrQueueCompletedReview: vi.fn(async () => ({ disposition: 'held', reason: 'review-recorded-handoff-missing' })) }));
vi.mock('./repoCleanupObservation.js', () => ({ inspectOpenDeliveryRepair: vi.fn(async () => ({ reason: 'delivery-ci-or-review-pending' })) }));
const prepareRetirement = vi.fn();
const retireCheckout = vi.fn();
const reserveReview = vi.fn(async () => ({ admitted: true }));
vi.mock('./heldCheckoutRecovery.js', () => ({ retireInventoriedCheckout: (...args) => retireCheckout(...args), prepareInventoriedCheckoutRetirement: (...args) => prepareRetirement(...args) }));
const mergedPrRead = vi.fn();
vi.mock('./branchReconcileRetirement.js', async (original) => {
  const real = await original();
  return { ...real, reserveRetirementReview: (...args) => reserveReview(...args), prepareReconcileRetirements: (app, result) => real.prepareReconcileRetirements(app, result, { readPr: mergedPrRead }) };
});
const reconcileMock = vi.fn();
vi.mock('./branchReconcile.js', async (importActual) => ({
  ...(await importActual()),
  reconcile: vi.fn((...args) => reconcileMock(...args)),
}));

// formatInFlightForPrompt (real, via importActual above) fetches a dispatch
// hint per issue-derived branch — mock just that one gh call so this suite
// never shells out to a real `gh`. `getIssueDispatchHint` already collapses
// every failure mode to `unavailable`, so this mirrors "no forge reachable".
vi.mock('./github.js', async (importActual) => ({
  ...(await importActual()),
  getIssueDispatchHint: vi.fn(async () => ({ status: 'unavailable', model: null, effort: null })),
}));

vi.mock('./agentState.js', async (importActual) => ({
  ...(await importActual()),
  getActiveAgentIds: vi.fn(() => []),
}));

const admissionFixture = vi.hoisted(() => ({ state: null, task: null, app: null, trees: [], hold: null,
  branch: 'claim/issue-42', origin: { host: 'github.com', fullName: 'example/repo' } }));
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: '/tmp/synthetic-agents',
  readAgentsStateForSafetyCheck: vi.fn(async () => ({ trusted: true, agents: {} })),
  readMergeAdmissionStateForSafetyCheck: async () => ({ trusted: true, ...structuredClone(admissionFixture.state) }),
  withStateLock: createFileWriteQueue(),
  loadState: async () => admissionFixture.state,
  saveState: async state => { admissionFixture.state = structuredClone(state); },
}));
vi.mock('./cosTaskStore.js', async original => ({ ...await original(), getTaskById: async () => admissionFixture.task }));
vi.mock('../lib/gitRemote.js', async original => ({ ...await original(), getOriginInfo: async () => admissionFixture.origin }));
vi.mock('./worktreeManager.js', async original => ({ ...await original(), listWorktrees: async () => admissionFixture.trees }));
vi.mock('../lib/execGit.js', async original => ({ ...await original(), execGit: async () => ({ stdout: admissionFixture.branch }) }));
vi.mock('./branchCompletionPolicy.js', async original => ({ ...await original(), readBranchCompletionHold: async () => admissionFixture.hold }));
// The test's repository is synthetic; durable retirement fencing has real-filesystem coverage.
vi.mock('../lib/checkoutRetirementAdmission.js', () => ({ withCheckoutPublication: (_repo, work) => work() }));

import { registerAgent } from './cosAgentLifecycle.js';
import { resolveMergeHandoffOwner } from './mergeHandoffOwner.js';
import { checkReconcileOwnership } from './cosClaimOwnership.js';

import { emitLog } from './cosEvents.js';
import { inspectOpenDeliveryRepair } from './repoCleanupObservation.js';
import { inspectOrQueueCompletedReview } from './repoCleanupRecovery.js';
import { prepareManagedAppImprovementTask, recordDeferredPerpetualDispatch } from './cosTaskGenerator.js';
import { getTaskInterval } from './taskSchedule.js';
import { getBranchReconcileOutcome, recordBranchReconcileOutcome } from './branchReconcileOutcome.js';
import { applyPerpetualDrainCap } from './cosTaskPreStepBlocks.js';
import { readAgentsStateForSafetyCheck } from './cosState.js';

const APP = { id: 'app-1', name: 'Example App', repoPath: '/tmp/example-repo' };
const STATE = { config: { confidenceAutoApproval: { enabled: false }, idleReviewPriority: 'MEDIUM' } };

const scan = (over = {}) => ({
  defaultBranch: 'main',
  cleaned: [],
  skipped: [],
  wip: [],
  superseded: [],
  inFlight: [{ branch: 'claim/issue-42', state: 'NEEDS_PR', openPr: null, ahead: 3, behind: 0 }],
  ...over,
});

const generate = async (options = {}) => {
  const prepared = await prepareManagedAppImprovementTask('branch-reconcile', APP, STATE, { skipPreconditions: true, ...options });
  // This suite's direct prepare call simulates a caller that has admitted the
  // task; production records only after its own admission gate succeeds.
  await recordDeferredPerpetualDispatch(prepared.pendingPerpetualDispatch, await import('./taskSchedule.js'));
  return prepared.task;
};

describe('prepareManagedAppImprovementTask composes the extracted pre-step layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectOpenDeliveryRepair.mockResolvedValue({ reason: 'delivery-ci-or-review-pending' });
    inspectOrQueueCompletedReview.mockResolvedValue({ disposition: 'held', reason: 'review-recorded-handoff-missing' });
    reserveReview.mockResolvedValue({ admitted: true });
    retireCheckout.mockResolvedValue({ ok: true, archiveDir: '/private/archive', branchDeleted: true });
    getBranchReconcileOutcome.mockResolvedValue(null);
    recordBranchReconcileOutcome.mockImplementation(async (_appId, update) => ({ ...update, retirementObligations: retainRetirementObligations(null, update.remaining || [], '2026-10-20T00:00:00Z') }));
    parkPerpetual.mockReset().mockResolvedValue();
    recordPerpetualDispatch.mockReset().mockResolvedValue(1);
    readAgentsStateForSafetyCheck.mockResolvedValue({ trusted: true, agents: {} });
    getPerpetualDrainState.mockResolvedValue({ signature: null, dispatchCount: 0 });
    reconcileMock.mockResolvedValue(scan());
    getTaskInterval.mockResolvedValue({ type: 'on-demand', perpetual: true, drainDispatchCap: 5, taskMetadata: { branchesPerAgent: 3 } });
  });

  it('a user run retires merged review holds and generates review work only for the rest', async () => {
    const rows = [1, 2, 3, 4].map(n => ({ branch: `claim/issue-${n}`, tip: String(n).repeat(40),
      worktreePath: `/example/checkouts/${n}`, isMerged: n !== 2, rule: 'completion-policy', completionPolicyReason: 'pr-completion-review-required' }));
    reconcileMock.mockResolvedValue(scan({ inFlight: [], wip: rows, worktreeInventory: rows.map(row => ({
      branch: row.branch, path: row.worktreePath, head: row.tip, managed: true, locked: false, lockReason: null,
    })) }));
    mergedPrRead.mockImplementation(async (_app, name) => `https://github.com/example/repo/pull/${name.split('-').at(-1)}`);
    prepareRetirement.mockResolvedValue({ ok: true, review: { digest: 'd'.repeat(64), policy: { policies: [{ id: 'completed-owner' }] }, comparison: { disposition: 'review-supersession', localPatch: '+old', difference: '+replacement' } } });
    const task = await generate({ onDemand: true });
    expect(task).not.toBeNull();
    // Ancestral checkouts retire through the fenced service; only the
    // non-ancestral one needs a cognitive review.
    expect(retireCheckout).toHaveBeenCalledTimes(3);
    expect(retireCheckout).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ branch: 'claim/issue-1' }) }),
      expect.objectContaining({ settleMergedReviewObligation: true }));
    expect(task.metadata.reconcileRetirements).toHaveLength(1);
    expect(task.metadata.reconcileRetirements[0].release.branch).toBe('claim/issue-2');
    expect(task.description).toContain('[REVIEW_RETIREMENT]');
    expect(task.description).toContain('checkouts/retire');
    expect(task.description).not.toContain('claim-ownership');
    expect(parkPerpetual).not.toHaveBeenCalled();
    expect(recordBranchReconcileOutcome).toHaveBeenLastCalledWith(APP.id, expect.objectContaining({
      remaining: expect.arrayContaining([expect.objectContaining({ branch: 'claim/issue-2', head: '2'.repeat(40), reason: 'retirement-review-pending' })]),
    }));
  });

  it.each([
    [{}, true], [{ reapSuperseded: false }, false], [{ cleanupMerged: false }, false],
  ])('retires verified-superseded branches unless a toggle refuses it: %j', async (taskMetadata, expected) => {
    getTaskInterval.mockResolvedValue({ type: 'on-demand', perpetual: true, drainDispatchCap: 5, taskMetadata: { branchesPerAgent: 3, ...taskMetadata } });
    await generate();
    expect(reconcileMock).toHaveBeenCalledWith(APP.repoPath, expect.objectContaining({ reapSuperseded: expected }));
  });

  it('does not generate repeated agents for a healthy open PR waiting for CI', async () => {
    reconcileMock.mockResolvedValue(scan({ inFlight: [{ branch: 'fix/waiting', state: 'IN_REVIEW', openPr: { url: 'https://github.com/example/repo/pull/9', isDraft: false } }] }));
    for (let i = 0; i < 70; i++) expect(await generate()).toBeNull();
    expect(recordPerpetualDispatch).not.toHaveBeenCalled();
    const parkedMessage = emitLog.mock.calls.findLast(([, message]) => message.includes('branch-reconcile parked'))?.[1];
    expect(parkedMessage).toContain('no coordinator task eligible; unresolved holds retained');
    expect(parkedMessage).not.toContain('nothing actionable');
    expect(parkedMessage).toContain('delivery branch(es) awaiting completion (delivery-ci-or-review-pending)');
    expect(parkedMessage).not.toContain('skipped by disabled action toggles');
    expect(recordBranchReconcileOutcome).toHaveBeenLastCalledWith(APP.id, expect.objectContaining({ remaining: expect.arrayContaining([
      expect.objectContaining({ branch: 'fix/waiting', reason: 'delivery-ci-or-review-pending' }),
    ]) }));
  });

  it.each([false, true])('does not grant merge-capable review work with autoMerge disabled (resolveConflicts=%s)', async resolveConflicts => {
    getTaskInterval.mockResolvedValue({ type: 'on-demand', taskMetadata: { autoMerge: false, resolveConflicts } });
    const branch = 'fix/no-auto-merge';
    const path = '/example/checkouts/held';
    reconcileMock.mockResolvedValue(scan({ inFlight: [], wip: [{ branch, worktreePath: path, rule: 'completion-policy', completionPolicyReason: 'pr-completion-review-required', openPr: { url: 'https://github.com/example/repo/pull/9', isDraft: false } }],
      worktreeInventory: [{ branch, path, head: 'a'.repeat(40), locked: false, managed: true }] }));
    inspectOpenDeliveryRepair.mockResolvedValue({ headSha: 'a'.repeat(40), evidence: { head: 'a'.repeat(40), conflicts: true } });
    expect(await generate()).toBeNull();
    expect(inspectOrQueueCompletedReview).not.toHaveBeenCalled();
    expect(recordPerpetualDispatch).not.toHaveBeenCalled();
    expect(recordBranchReconcileOutcome).toHaveBeenLastCalledWith(APP.id, expect.objectContaining({ remaining: expect.arrayContaining([
      expect.objectContaining({ branch, reason: 'auto-merge-disabled' }),
    ]) }));
  });

  it('holds a conflicted delivery for review only when conflict resolution is disabled', async () => {
    getTaskInterval.mockResolvedValue({ type: 'on-demand', taskMetadata: { resolveConflicts: false } });
    const branch = 'fix/conflicted';
    const path = '/example/checkouts/conflicted';
    reconcileMock.mockResolvedValue(scan({ inFlight: [{ branch, worktreePath: path, state: 'IN_REVIEW', openPr: { url: 'https://github.com/example/repo/pull/9', isDraft: false } }],
      worktreeInventory: [{ branch, path, head: 'a'.repeat(40), locked: false, managed: true }] }));
    inspectOpenDeliveryRepair.mockResolvedValue({ headSha: 'a'.repeat(40), evidence: { head: 'a'.repeat(40), conflicts: true } });
    expect(await generate()).toBeNull();
    expect(inspectOrQueueCompletedReview).not.toHaveBeenCalled();
    expect(recordBranchReconcileOutcome).toHaveBeenLastCalledWith(APP.id, expect.objectContaining({ remaining: expect.arrayContaining([
      expect.objectContaining({ branch, reason: 'conflict-resolution-disabled' }),
    ]) }));
  });

  it('keeps the delivery reason without queueing review when the checkout is locked', async () => {
    const branch = 'fix/locked-review';
    const path = '/example/checkouts/locked';
    reconcileMock.mockResolvedValue(scan({ inFlight: [{ branch, worktreePath: path, state: 'IN_REVIEW', openPr: { url: 'https://github.com/example/repo/pull/9', isDraft: false } }],
      worktreeInventory: [{ branch, path, head: 'a'.repeat(40), locked: true, managed: true }] }));
    inspectOpenDeliveryRepair.mockResolvedValue({ headSha: 'a'.repeat(40), reason: 'delivery-ci-or-review-pending' });
    expect(await generate()).toBeNull();
    expect(inspectOrQueueCompletedReview).not.toHaveBeenCalled();
    expect(recordBranchReconcileOutcome).toHaveBeenLastCalledWith(APP.id, expect.objectContaining({ remaining: expect.arrayContaining([
      expect.objectContaining({ branch, reason: 'delivery-ci-or-review-pending' }),
    ]) }));
  });

  it.each(['worktreeDirty', 'worktreeStatusUnavailable'])('does not route a review-held open PR through delivery when %s', async flag => {
    const branch = 'fix/held-open';
    const path = '/example/checkouts/held-open';
    reconcileMock.mockResolvedValue(scan({ inFlight: [], wip: [{ branch, worktreePath: path, rule: 'completion-policy', completionPolicyReason: 'pr-completion-review-required',
      [flag]: true, openPr: { url: 'https://github.com/example/repo/pull/9', isDraft: false } }],
      worktreeInventory: [{ branch, path, head: 'a'.repeat(40), locked: false, managed: true }] }));
    await generate();
    expect(inspectOpenDeliveryRepair).not.toHaveBeenCalled();
  });

  it('skips retirement preparation entirely when merged cleanup is disabled', async () => {
    getTaskInterval.mockResolvedValue({ type: 'on-demand', taskMetadata: { cleanupMerged: false } });
    const release = { branch: 'claim/issue-1', path: '/example/checkouts/1', head: 'a'.repeat(40), managed: true, locked: false };
    reconcileMock.mockResolvedValue(scan({ inFlight: [], wip: [{ branch: release.branch, worktreePath: release.path, tip: release.head,
      rule: 'completion-policy', completionPolicyReason: 'pr-completion-review-required' }], worktreeInventory: [release] }));
    await generate();
    expect(mergedPrRead).not.toHaveBeenCalled();
    expect(prepareRetirement).not.toHaveBeenCalled();
    expect(recordBranchReconcileOutcome).not.toHaveBeenCalledWith(APP.id, expect.objectContaining({ reason: 'preparing-retirement-reviews' }));
  });

  it('nudges no receipt with autoMerge off but still hands reconcile the saved pending-merge branches', async () => {
    getTaskInterval.mockResolvedValue({ type: 'on-demand', taskMetadata: { autoMerge: false } });
    const app = { ...APP, pendingMergePrs: [{ prNumber: 7, prUrl: 'https://github.com/example/repo/pull/7', prBranch: 'fix/pending' }] };
    admissionFixture.app = app;
    await prepareManagedAppImprovementTask('branch-reconcile', app, STATE, { skipPreconditions: true });
    expect(reconcileMock.mock.calls.at(-1)[1].pendingMergeBranches).toEqual(new Set(['fix/pending']));
    admissionFixture.app = null;
    await generate();
    expect(reconcileMock.mock.calls.at(-1)[1]).not.toHaveProperty('pendingMergeBranches');
  });

  it('routes a genuine missing-review obligation through the pinned review loop without a generic reconcile agent', async () => {
    const branch = 'fix/needs-review';
    const path = '/example/checkouts/review';
    const head = 'a'.repeat(40);
    reconcileMock.mockResolvedValue(scan({ inFlight: [{ branch, worktreePath: path, state: 'IN_REVIEW', openPr: { url: 'https://github.com/example/repo/pull/9', isDraft: false } }],
      worktreeInventory: [{ branch, path, head, locked: false, managed: true }] }));
    inspectOpenDeliveryRepair.mockResolvedValue({ headSha: head, reason: 'delivery-ci-or-review-pending' });
    inspectOrQueueCompletedReview.mockResolvedValue({ disposition: 'queued-review', reason: 'required-code-review-queued', taskId: 'exact-review' });
    expect(await generate()).toBeNull();
    expect(inspectOrQueueCompletedReview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repoPath: APP.repoPath, branch, worktreePath: path, headSha: head }));
    expect(recordPerpetualDispatch).not.toHaveBeenCalled();
    expect(recordBranchReconcileOutcome).toHaveBeenLastCalledWith(APP.id, expect.objectContaining({ remaining: expect.arrayContaining([
      expect.objectContaining({ branch, reason: 'required-code-review-queued' }),
    ]) }));
  });

  it.each(['completion-policy', 'merged-claim'])('a normal user reconcile drains %s retirement without generating an agent', async kind => {
    const release = { branch: 'claim/issue-1', path: '/example/checkouts/1', head: 'a'.repeat(40), managed: true, locked: false };
    const branch = { branch: release.branch, worktreePath: release.path, tip: release.head,
      rule: 'completion-policy', completionPolicyReason: 'pr-completion-review-required' };
    reconcileMock.mockResolvedValue(scan({ inFlight: [], wip: kind === 'completion-policy' ? [branch] : [],
      merged: kind === 'merged-claim' ? [{ ...branch, state: 'MERGED', isMerged: true }] : [],
      skipped: kind === 'merged-claim' ? [{ ...release, reason: 'claim-completion-unverified' }] : [], worktreeInventory: [release] }));
    mergedPrRead.mockResolvedValue('https://github.com/example/repo/pull/1');
    prepareRetirement.mockResolvedValue({ ok: true, review: { digest: 'd'.repeat(64), policy: { integratedCleanupHead: 'c'.repeat(40), policies: [{ id: 'completed-owner' }] },
      forge: { prHead: release.head }, comparison: { disposition: 'integrated', localPatch: '', difference: '' } } });
    expect(await generate({ onDemand: true })).toBeNull();
    expect(retireCheckout).toHaveBeenCalledOnce();
    expect(retireCheckout.mock.calls[0][0].review.acceptSuperseded).toBe(false);
    expect(reserveReview).not.toHaveBeenCalled();
    expect(recordPerpetualDispatch).not.toHaveBeenCalled();
    expect(recordBranchReconcileOutcome.mock.calls.at(-1)[1].remaining).toEqual([]);
    // The retired checkout is reported as cleaned, not silently dropped.
    expect(emitLog.mock.calls.findLast(([, message]) => message.includes('branch-reconcile parked'))?.[1]).toContain('(cleaned 1');
  });

  it('keeps an unresolved retirement visible after the checkout disappears on a later refill', async () => {
    const release = { branch: 'claim/issue-42', path: '/example/missing', head: 'a'.repeat(40), createdAt: '2026-10-20T00:00:00Z', reason: 'retirement-receipt-unverified' };
    getBranchReconcileOutcome.mockResolvedValue({ retirementObligations: [release], remaining: [] });
    reconcileMock.mockResolvedValue(scan({ inFlight: [], worktreeInventory: [] }));
    expect(await generate()).toBeNull();
    expect(recordBranchReconcileOutcome).toHaveBeenLastCalledWith(APP.id, expect.objectContaining({ remaining: [expect.objectContaining({ branch: release.branch, path: release.path, head: release.head, reason: release.reason })] }));
    expect(parkPerpetual).toHaveBeenLastCalledWith('branch-reconcile', APP.id, expect.objectContaining({
      reason: 'branches-blocked', skipCauses: { 'retirement-receipt-unverified': 1 },
    }));
    getBranchReconcileOutcome.mockResolvedValue({ retirementObligations: [release], retired: [{ ...release, branchDeleted: true, archiveDir: '/example/archive', retiredAt: '2026-10-20T00:01:00Z' }] });
    await generate();
    expect(parkPerpetual).toHaveBeenLastCalledWith('branch-reconcile', APP.id, expect.objectContaining({ reason: 'no-in-flight-branches' }));
  });

  it('folds the reconcile pre-step block into the prompt via {inFlightBranches}', async () => {
    const task = await generate();
    expect(task).not.toBeNull();
    // The resolver ran (a missing import would ReferenceError before this) …
    expect(reconcileMock).toHaveBeenCalledWith(APP.repoPath, expect.any(Object));
    // … the convergence gate ran and spent a dispatch …
    expect(recordPerpetualDispatch).toHaveBeenCalled();
    expect(recordBranchReconcileOutcome).toHaveBeenCalledWith(APP.id, expect.objectContaining({
      status: 'running', remaining: [{ branch: 'claim/issue-42', reason: 'actionable' }],
    }));
    expect(parkPerpetual).not.toHaveBeenCalled();
    // … and the renderer folded its block in, leaving no literal token behind.
    expect(task.description).not.toContain('{inFlightBranches}');
    expect(task.description).toContain('claim/issue-42');
    expect(task.metadata.perpetual).toBe(true);
  });

  it('returns null when the reconcile pre-step parks instead of dispatching', async () => {
    reconcileMock.mockResolvedValue(scan({ inFlight: [] }));
    expect(await generate()).toBeNull();
    expect(parkPerpetual).toHaveBeenCalled();
  });

  it('protects a live claim worktree by passing its recorded path token to reconcile', async () => {
    readAgentsStateForSafetyCheck.mockResolvedValue({ trusted: true, agents: {
      'agent-live': { id: 'agent-live', status: 'running', workspacePath: '/repo/data/cos/worktrees/claim-issue-99' },
    } });
    reconcileMock.mockResolvedValue(scan({ inFlight: [] }));

    await generate();

    expect(reconcileMock.mock.calls.at(-1)[1].activeAgentIds).toEqual(
      new Set(['agent-live', 'claim-issue-99'])
    );
  });

  it('does not reconcile when the live-agent state cannot be read', async () => {
    readAgentsStateForSafetyCheck.mockRejectedValue(new Error('state unavailable'));

    expect(await generate()).toBeNull();
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(parkPerpetual).toHaveBeenCalledWith('branch-reconcile', APP.id, { reason: 'owner-state-unavailable' });
    expect(recordPerpetualDispatch).not.toHaveBeenCalled();
  });
  it('reaches later branches across a cap and manual retry, then parks the exhausted sweep', async () => {
    const branches = ['__proto__', 'b', 'c', 'd'].map(name => ({ branch: name === '__proto__' ? name : `fix/${name}`, state: 'NEEDS_PR', tip: 'head-1', openPr: null }));
    let persisted = { signature: null, dispatchCount: 0 };
    getPerpetualDrainState.mockImplementation(async () => JSON.parse(JSON.stringify(persisted)));
    recordPerpetualDispatch.mockImplementation(async (_type, _app, signature, { branchAttempts }) => {
      persisted = { signature, dispatchCount: persisted.dispatchCount + 1, branchAttempts };
    });
    parkPerpetual.mockImplementation(async (_type, _app, { branchAttempts }) => {
      persisted = { ...persisted, signature: null, dispatchCount: 0 };
      if (branchAttempts === null) delete persisted.branchAttempts;
    });
    reconcileMock.mockResolvedValue(scan({ inFlight: branches,
      wip: [{ branch: 'fix/draft', openPr: { isDraft: true } }],
      detachedWorktrees: [{ path: '/scratch/checkout', reason: 'worktree-locked' }]
    }));

    const first = await generate();
    expect(first.description).toContain('__proto__');
    expect(first.description).toContain('fix/c');
    expect(first.description).not.toContain('fix/d');
    // The same persisted attempt map survives the real cap gate. Manual reset
    // also retains it (taskSchedule's persistence regression covers that write).
    expect(await applyPerpetualDrainCap(APP, 'branch-reconcile', { perpetual: true, drainDispatchCap: 1 }, {
      getPerpetualDrainState, parkPerpetual
    })).toEqual({ skip: true });
    const second = await generate();
    expect(second.description).toContain('fix/d');
    expect(second.description).not.toContain('__proto__');
    expect(await generate()).toBeNull();
    expect(parkPerpetual).toHaveBeenLastCalledWith('branch-reconcile', APP.id, expect.objectContaining({
      reason: 'no-progress', actionableCount: 4, branchAttempts: null,
      counts: { unchangedBranches: 4, heldBranches: 1, heldDetached: 1 },
      skipCauses: { 'unchanged-after-attempt': 4, 'draft-review-required': 1, 'worktree-locked': 1 }
    }));
    expect(recordPerpetualDispatch).toHaveBeenCalledTimes(2);
  });

  it('retries a changed revision without retrying an unchanged blocked prefix', async () => {
    getPerpetualDrainState.mockResolvedValue({
      signature: 'fix/a:NEEDS_PR:none:old-head', dispatchCount: 1,
      branchAttempts: { 'fix/a': 'fix/a:NEEDS_PR:none:old-head', 'fix/b': 'fix/b:NEEDS_PR:none:same-head', removed: 'stale' }
    });
    reconcileMock.mockResolvedValue(scan({ inFlight: [
      { branch: 'fix/a', state: 'NEEDS_PR', openPr: null, tip: 'new-head' },
      { branch: 'fix/b', state: 'NEEDS_PR', openPr: null, tip: 'same-head' }
    ] }));
    const task = await generate();
    expect(task.description).toContain('fix/a');
    expect(task.description).not.toContain('fix/b');
    expect(recordPerpetualDispatch).toHaveBeenLastCalledWith('branch-reconcile', APP.id, expect.stringContaining('new-head'), {
      branchAttempts: { 'fix/a': 'fix/a:NEEDS_PR:none:new-head', 'fix/b': 'fix/b:NEEDS_PR:none:same-head' }
    });
  });

  it('reports protected issue markers separately after local cleanup succeeded', async () => {
    reconcileMock.mockResolvedValue(scan({ inFlight: [], cleaned: ['claim/issue-42', 'next/issue-42'],
      claimMarkersHeld: [
        { branch: 'claim/issue-42', issue: 42, reason: 'claim-reservation-owner-unverified' },
        { branch: 'next/issue-42', issue: 42, reason: 'claim-reservation-owner-unverified' },
      ]
    }));
    expect(await generate()).toBeNull();
    expect(parkPerpetual).toHaveBeenCalledWith('branch-reconcile', APP.id, expect.objectContaining({
      reason: 'claim-markers-held', counts: { heldBranches: 0, heldDetached: 0, heldClaims: 1 },
      skipCauses: { 'claim-reservation-owner-unverified': 1 }
    }));
    expect(recordPerpetualDispatch).not.toHaveBeenCalled();
  });

  it('parks typed draft, owner, detached and cleanup blockers without treating them as an empty repo', async () => {
    reconcileMock.mockResolvedValue(scan({ inFlight: [],
      wip: [
        { branch: 'fix/draft', openPr: { isDraft: true } },
        { branch: 'fix/handoff', completionPolicyReason: 'human-handoff' },
        { branch: 'fix/policy', completionPolicyReason: 'policy-unavailable' }
      ],
      skipped: [
        { branch: 'fix/owned', reason: 'claim-owner-active' },
        { branch: 'fix/delete', reason: 'delete-failed: private diagnostic' },
        { branch: 'fix/backup', reason: 'backup-failed: /private/diagnostic', retryAt: '2030-01-02T00:00:00Z' },
        { path: '/scratch/checkout', detached: true, reason: 'worktree-locked' }
      ],
      detachedWorktrees: [{ path: '/scratch/checkout', reason: 'worktree-locked' }],
      superseded: [{ branch: 'fix/backup', holdReason: 'backup-failed: /private/diagnostic', holdRetryAt: '2030-01-01T00:00:00Z' }]
    }));
    expect(await generate()).toBeNull();
    expect(parkPerpetual).toHaveBeenCalledWith('branch-reconcile', APP.id, expect.objectContaining({
      reason: 'branches-blocked', counts: { heldBranches: 6, heldDetached: 1 },
      notLaterThan: '2030-01-01T00:00:00.000Z',
      skipCauses: { 'draft-review-required': 1, 'claim-owner-active': 1, 'branch-delete-failed': 1, 'worktree-locked': 1, 'backup-failed': 1, 'human-handoff': 1, 'policy-unavailable': 1 }
    }));
    expect(JSON.stringify(parkPerpetual.mock.calls)).not.toContain('/private/diagnostic');
    expect(recordPerpetualDispatch).not.toHaveBeenCalled();
  });

  it.each([
    { trusted: false, agents: {} },
    { trusted: true, agents: { owner: { id: 'owner', status: 'unknown' } } },
    { trusted: true, agents: { owner: { id: 'different-owner', status: 'running' } } },
    { trusted: true, agents: { owner: { id: 'owner', status: 'running', metadata: { claimBranches: 'claim/issue-99' } } } },
  ])('does not dispatch cleanup from untrusted or malformed persisted ownership: %j', async (snapshot) => {
    readAgentsStateForSafetyCheck.mockResolvedValue(snapshot);

    expect(await generate()).toBeNull();
    expect(reconcileMock).not.toHaveBeenCalled();
  });

});


// Regression: prompt-only branch assignments formerly reserved claimBranches
// successfully but never survived registration as a merge participant.
describe('scheduled reconciliation registration through handoff ownership', () => {
  const workspacePath = '/tmp/example-checkout';
  const branch = 'claim/issue-42';
  const ownership = (over = {}) => checkReconcileOwnership({ agentId: 'agent-reconcile', appId: APP.id,
    branch, worktreePath: workspacePath, ...over });
  // The resolved handoff owner, or null when the registered run is refused.
  const handoffOwner = async () => {
    const resolved = await resolveMergeHandoffOwner('agent-reconcile');
    return resolved.owns ? resolved : null;
  };
  const owner = () => admissionFixture.state.agents['agent-reconcile'];
  const register = async task => {
    admissionFixture.task = { ...parseTasksMarkdown(generateTasksMarkdown([{ ...task, description: task.description.split('\n')[0],
      metadata: { ...task.metadata, prompt: task.description } }], true))[0], taskType: 'internal' };
    await registerAgent('agent-reconcile', task.id, buildAgentRegistration({ task: admissionFixture.task,
      provider: { id: 'example-provider' }, workspacePath: APP.repoPath, sourceWorkspace: APP.repoPath,
      modelSelection: { tier: 'heavy', reason: 'test' }, prOpenedBy: 'portos', claimFlowTask: false }));
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    Object.assign(admissionFixture, { state: { agents: {}, stats: { agentsSpawned: 0 } }, task: null, app: APP,
      trees: [{ path: workspacePath, branch: `refs/heads/${branch}`, locked: false }], hold: null, branch,
      origin: { host: 'github.com', fullName: 'example/repo' } });
    readAgentsStateForSafetyCheck.mockImplementation(async () => ({ trusted: true, agents: structuredClone(admissionFixture.state.agents) }));
    getBranchReconcileOutcome.mockResolvedValue(null);
    recordBranchReconcileOutcome.mockImplementation(async (_id, update) => ({ ...update, retirementObligations: [] }));
    getPerpetualDrainState.mockResolvedValue({ signature: null, dispatchCount: 0 });
    recordPerpetualDispatch.mockResolvedValue(1);
    getTaskInterval.mockResolvedValue({ type: 'on-demand', taskMetadata: { branchesPerAgent: 1 } });
    reconcileMock.mockResolvedValue(scan({ inFlight: [{ branch, worktreePath: workspacePath, state: 'NEEDS_PR' },
      { branch: 'claim/issue-99', worktreePath: '/tmp/other-checkout', state: 'NEEDS_PR' }] }));
    await register(await generate());
  });

  it('persists only the selected assignment, reserves it, and resolves as the handoff owner', async () => {
    expect(owner().metadata.reconcileAssignment.targets).toEqual([{ branch, workspacePath, merge: true }]);
    expect(owner().metadata).toMatchObject({ configClaimFlow: false, isWorktree: false, configOpenPR: false, prOpenedBy: 'portos' });
    expect(await handoffOwner()).toBeNull();
    expect(await ownership()).toEqual({ admitted: true });
    const handoff = await handoffOwner();
    expect(handoff.workspacePath).toBe(workspacePath);
    expect(handoff.owns(branch)).toBe(true);
    expect(handoff.owns('claim/issue-99')).toBe(false);
  });

  it('refuses an unassigned branch even when caller paths and copied prose describe it', async () => {
    admissionFixture.trees.push({ path: '/tmp/other-checkout', branch: 'refs/heads/claim/issue-99' });
    expect(await ownership({ branch: 'claim/issue-99', worktreePath: '/tmp/other-checkout' }))
      .toMatchObject({ admitted: false, reason: 'reconcile-target-unverified' });
    delete owner().metadata.reconcileAssignment;
    delete admissionFixture.task.metadata.reconcileAssignment;
    expect(await ownership()).toMatchObject({ admitted: true });
    expect(owner().metadata.claimBranches).toEqual([branch]);
    expect(await resolveMergeHandoffOwner(owner().id)).toEqual({ refused: 'handoff-owner-unverified' });
  });

  it.each(['task-completed', 'task-missing', 'owner-completed', 'owner-missing', 'assignment-changed', 'checkout-changed',
    'repository-changed', 'app-changed', 'read-only', 'human-handoff', 'auto-merge-disabled', 'retirement-only',
    'policy-hold', 'policy-review', 'policy-unreadable', 'live-owner', 'locked-checkout', 'ownership-unreadable'])
  ('refuses %s after a successful reservation', async mode => {
    expect((await ownership()).admitted).toBe(true);
    expect(await handoffOwner()).not.toBeNull();
    if (mode === 'task-missing') admissionFixture.task = null;
    if (mode === 'task-completed') admissionFixture.task.status = 'completed';
    if (mode === 'owner-completed') owner().status = 'completed';
    if (mode === 'owner-missing') delete admissionFixture.state.agents['agent-reconcile'];
    if (mode === 'assignment-changed') admissionFixture.task.metadata.reconcileAssignment.targets[0].workspacePath = '/tmp/changed';
    if (mode === 'checkout-changed') admissionFixture.branch = 'main';
    if (mode === 'repository-changed') admissionFixture.origin = { host: 'github.com', fullName: 'example/other' };
    if (mode === 'app-changed') admissionFixture.app = { ...APP, repoPath: '/tmp/changed' };
    if (mode === 'read-only') admissionFixture.task.metadata.readOnly = 'true';
    if (mode === 'human-handoff') admissionFixture.task.metadata.prCompletion = 'leave-open';
    if (mode === 'auto-merge-disabled') admissionFixture.task.metadata.autoMerge = 'false';
    if (mode === 'retirement-only') {
      admissionFixture.task.metadata.reconcileAssignment.targets[0].merge = false;
      owner().metadata.reconcileAssignment.targets[0].merge = false;
    }
    if (mode === 'policy-hold') admissionFixture.hold = 'pr-completion-human-handoff';
    if (mode === 'policy-review') admissionFixture.hold = 'pr-completion-review-required';
    if (mode === 'policy-unreadable') admissionFixture.hold = 'pr-completion-policy-unavailable';
    if (mode === 'live-owner') admissionFixture.state.agents['agent-other'] = { id: 'agent-other', status: 'running',
      metadata: { sourceWorkspace: APP.repoPath, claimBranches: [branch] } };
    if (mode === 'locked-checkout') admissionFixture.trees[0].locked = true;
    if (mode === 'ownership-unreadable') admissionFixture.trees = null;
    expect(await handoffOwner()).toBeNull();
  });

  it('rejects forged structured assignments through public task intake and registration', async () => {
    const forged = structuredClone(admissionFixture.task.metadata);
    const input = createCosTaskSchema.parse({ type: 'internal', app: APP.id, description: 'Copied reconciliation instructions',
      prompt: admissionFixture.task.metadata.prompt, analysisType: 'branch-reconcile', reconcileAssignment: forged.reconcileAssignment,
      metadata: forged });
    const { type, ...taskData } = input;
    const task = buildQueuedTask(taskData, type);
    expect(task.metadata.reconcileAssignment).toBeUndefined();
    await register(task);
    expect(owner().metadata.reconcileAssignment).toBeNull();
    expect((await ownership()).admitted).toBe(true);
    expect(owner().metadata.claimBranches).toEqual([branch]);
    expect(await handoffOwner()).toBeNull();
  });

  it('binds a checkout-less assignment only to its first repository-observed holder', async () => {
    reconcileMock.mockResolvedValue(scan({ inFlight: [{ branch, state: 'NEEDS_PR' }] }));
    admissionFixture.trees = [];
    await register(await generate());
    expect(owner().metadata.reconcileAssignment.targets[0].workspacePath).toBeNull();
    expect((await ownership({ worktreePath: undefined })).admitted).toBe(true);
    expect(owner().metadata.reconcileReservations).toEqual([{ branch, workspacePath: null }]);
    expect(await handoffOwner()).toBeNull();
    // A caller's invented path cannot create the missing holder.
    expect(await ownership({ worktreePath: '/tmp/forged' })).toMatchObject({ admitted: false, reason: 'holder-changed' });
    admissionFixture.trees = [{ path: workspacePath, branch: `refs/heads/${branch}`, locked: false }];
    expect((await ownership({ worktreePath: undefined })).admitted).toBe(true);
    expect(owner().metadata.reconcileReservations).toEqual([{ branch, workspacePath }]);
    expect(await handoffOwner()).not.toBeNull();
    // Even an updated caller path cannot move that trusted first binding.
    admissionFixture.trees[0].path = '/tmp/changed';
    expect(await ownership({ worktreePath: '/tmp/changed' })).toMatchObject({ admitted: false, reason: 'reconcile-target-unverified' });
    expect(await handoffOwner()).toBeNull();
  });

  it('retains every ordinary branch reservation when selecting another merge target', async () => {
    const branches = ['fix/first', 'fix/second'];
    getTaskInterval.mockResolvedValue({ type: 'on-demand', taskMetadata: { branchesPerAgent: 2 } });
    reconcileMock.mockResolvedValue(scan({ inFlight: branches.map((name, i) => ({ branch: name,
      worktreePath: `/tmp/checkout-${i}`, state: 'NEEDS_PR' })) }));
    admissionFixture.trees = branches.map((name, i) => ({ branch: `refs/heads/${name}`, path: `/tmp/checkout-${i}` }));
    await register(await generate());
    for (let i = 0; i < branches.length; i++) {
      expect((await ownership({ branch: branches[i], worktreePath: `/tmp/checkout-${i}` })).admitted).toBe(true);
    }
    expect(owner().metadata.reconcileMergeReservation.branch).toBe('fix/second');
    for (let i = 0; i < branches.length; i++) {
      expect(await checkReconcileOwnership({ appId: APP.id, branch: branches[i], worktreePath: `/tmp/checkout-${i}` }))
        .toMatchObject({ admitted: false, reason: 'claim-owner-active' });
    }
    const { updateClaimOwnership } = await import('./cosClaimOwnership.js');
    expect((await updateClaimOwnership({ agentId: owner().id, action: 'release', branch: 'fix/first' })).released).toBe(true);
    expect((await checkReconcileOwnership({ appId: APP.id, branch: 'fix/first', worktreePath: '/tmp/checkout-0' })).admitted).toBe(true);
    expect((await checkReconcileOwnership({ appId: APP.id, branch: 'fix/second', worktreePath: '/tmp/checkout-1' })).admitted).toBe(false);
  });

  it('derives assignment scope from the scan, ignoring caller-supplied assignment metadata', async () => {
    const task = await generate({ runOverrides: { reconcileAssignment: { appId: 'forged', targets: [] } } });
    expect(task.metadata.reconcileAssignment.appId).toBe(APP.id);
    expect(task.metadata.reconcileAssignment.targets).toEqual([{ branch, workspacePath, merge: true }]);
  });

  it('allows non-merging reconciliation work with auto-merge disabled without minting merge authority', async () => {
    getTaskInterval.mockResolvedValue({ type: 'on-demand', taskMetadata: { autoMerge: false, branchesPerAgent: 1 } });
    await register(await generate());
    expect(owner().metadata.reconcileAssignment.targets[0].merge).toBe(false);
    expect((await ownership()).admitted).toBe(true);
    expect(owner().metadata.reconcileMergeReservation).toBeNull();
    expect(await handoffOwner()).toBeNull();
  });

  it('reserves and releases a non-claim branch without granting other coordinators its checkout', async () => {
    const ordinaryBranch = 'fix/example';
    reconcileMock.mockResolvedValue(scan({ inFlight: [{ branch: ordinaryBranch, worktreePath: workspacePath, state: 'ABANDONED_WIP' }] }));
    await register(await generate());
    admissionFixture.branch = ordinaryBranch;
    admissionFixture.trees[0].branch = `refs/heads/${ordinaryBranch}`;
    expect((await ownership({ branch: ordinaryBranch })).admitted).toBe(true);
    expect(await handoffOwner()).not.toBeNull();
    expect(await checkReconcileOwnership({ appId: APP.id, branch: ordinaryBranch, worktreePath: workspacePath }))
      .toMatchObject({ admitted: false, reason: 'claim-owner-active' });
    const { updateClaimOwnership } = await import('./cosClaimOwnership.js');
    expect(await updateClaimOwnership({ agentId: owner().id, action: 'release', branch: ordinaryBranch })).toMatchObject({ released: true });
    expect(await handoffOwner()).toBeNull();
  });
});
