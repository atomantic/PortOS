/**
 * Hold/retire permutations for checkout retirement, decided over inspected
 * state (#16115, #16153). The real-git contract for each outcome stays in
 * branchReconcile.ownership.test.js, heldCheckoutRecovery.test.js and
 * worktreeReap.test.js; these pin
 * every combination of holder, head, merge, dirt, lock, owner and completion
 * evidence, plus the order facts are read in (a hold must not pay for a later,
 * costlier read).
 */
import { describe, it, expect } from 'vitest';
import {
  decideBranchRetirement, decideDetachedRetirement, decideHeldCheckoutRetirement, decideInventoriedBranchRetirement, decideMergedCheckoutOwner,
  decideMergedDelivery, decideMergedWorktreeReap, decideMergedWorktreeRemoval, decidePendingMergeReceipt, decideWith, gatheredHoldReason,
  recoveryWorktreeReason, supersededPolicyHold,
  SHIPPED_CLAIM_IDLE_MS, STALE_CLAIM_IDLE_MS,
} from './branchRetirementDecision.js';
import { classifyBranches } from './branchReconcile.js';
import { classifyWorktreeDirt } from './worktreeManager.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-01-10T12:00:00.000Z');
const REPO = '/work/repo';
const MANAGED = `${REPO}/.claude/worktrees`;
const ROOTS = [{ path: MANAGED, requireAgentId: false }];
const HEAD = 'a'.repeat(40);
const MAIN_HEAD = 'b'.repeat(40);

const live = (id, metadata = {}, extra = {}) => ({ id, status: 'running', sourceWorkspace: REPO, workspacePath: REPO, metadata: { sourceWorkspace: REPO, ...metadata }, ...extra });

/** A merged retirement of `branch`, checked out at `path`, with every fact clean. */
function mergedCase(branch, path, { scan = {}, facts = {}, locked = false, ...input } = {}) {
  const holders = path === null ? [{ path: REPO, branch: 'refs/heads/main', head: MAIN_HEAD }]
    : [{ path: REPO, branch: 'refs/heads/main', head: MAIN_HEAD }, { path, branch: `refs/heads/${branch}`, head: HEAD, locked }];
  return {
    input: { repoPath: REPO, branch, mergedRetirement: true, activeAgentIds: new Set(), roots: ROOTS, nowMs: NOW,
      scan: { worktreePath: path, worktreeLocked: false, worktreeAgeMs: 30 * DAY, openPr: null, prStateUnavailable: false, tip: HEAD, ...scan }, ...input },
    facts: { agents: [], defaultBranch: 'main', head: HEAD, policyHold: null, holders, mergedAtHead: true, dirty: false,
      completionRecords: [], receipt: false, forgeMerge: null, githubOrigin: false, idleMs: null, ...facts },
  };
}

/** Run the decision the way the production driver does, recording what it asked for. */
function decide({ input, facts: answers }) {
  const facts = {};
  const asked = [];
  for (;;) {
    const step = decideBranchRetirement({ ...input, facts });
    if (!step.need) return { ...step, asked };
    if (!(step.need in answers)) throw new Error(`decision asked for an unsupplied fact: ${step.need}`);
    asked.push(step.need);
    facts[step.need] = answers[step.need];
  }
}
const reasonOf = c => decide(c).hold?.reason ?? 'retire';

describe('decideBranchRetirement — merged named branches', () => {
  // Every row was a real-git reconcile/cleanup case in branchReconcile.ownership.test.js.
  it.each([
    // [case, branch, path, overrides, expected]
    ['clean external checkout retires without a PR', 'feat/external', '/work/elsewhere/loose', {}, 'retire'],
    ['dirty external checkout is held', 'feat/fal-image-model-catalog', '/work/elsewhere/fal', { facts: { dirty: true } }, 'worktree-dirty'],
    ['locked external release checkout is held', 'release-prep/v9.9.9', '/work/elsewhere/release', { locked: true }, 'worktree-locked'],
    ['dirty old external workspace is held regardless of age', 'old-workspace', '/work/elsewhere/old', { facts: { dirty: true } }, 'worktree-dirty'],
    ['locked managed claim is held', 'claim/issue-6', `${MANAGED}/claim-issue-6`, { locked: true }, 'worktree-locked'],
    ['stale clean claim with no completion evidence is held', 'claim/issue-5', `${MANAGED}/claim-issue-5`, {}, 'claim-completion-unverified'],
    ['completed run receipt retires a fresh claim', 'claim/issue-11', `${MANAGED}/claim-issue-11`, { scan: { worktreeAgeMs: 0 }, facts: { receipt: true } }, 'retire'],
    ['forge-merged manual claim retires without a receipt', 'claim/issue-21', `${MANAGED}/claim-issue-21`,
      { scan: { worktreeAgeMs: 2 * HOUR }, facts: { forgeMerge: { mergedAt: new Date(NOW - 3 * HOUR).toISOString() } } }, 'retire'],
    ['manual claim the forge could not read is held', 'claim/issue-26', `${MANAGED}/claim-issue-26`, { scan: { worktreeAgeMs: 2 * HOUR } }, 'claim-completion-unverified'],
    // readMergedClaimEvidence returns null when the merged PR's head is not this head.
    ['manual claim whose merged PR has another head is held', 'claim/issue-27', `${MANAGED}/claim-issue-27`, { scan: { worktreeAgeMs: 2 * HOUR }, facts: { forgeMerge: null } }, 'claim-completion-unverified'],
    ['manual claim merged moments ago is held', 'claim/issue-28', `${MANAGED}/claim-issue-28`,
      { scan: { worktreeAgeMs: 2 * HOUR }, facts: { forgeMerge: { mergedAt: new Date(NOW).toISOString() } } }, 'claim-completion-unverified'],
    ['manual claim created moments ago is held', 'claim/issue-29', `${MANAGED}/claim-issue-29`,
      { scan: { worktreeAgeMs: 0 }, facts: { forgeMerge: { mergedAt: new Date(NOW - 3 * HOUR).toISOString() } } }, 'claim-completion-unverified'],
    ['old claim age alone never proves completion', 'claim/issue-55', `${MANAGED}/claim-issue-55`, { scan: { worktreeAgeMs: 30 * DAY } }, 'claim-completion-unverified'],
    ['unreadable completion records hold a claim', 'claim/issue-55', `${MANAGED}/claim-issue-55`, { facts: { completionRecords: null } }, 'claim-ownership-unreadable'],
    ['idle claim with no PR at its head retires on a GitHub origin', 'claim/issue-56', `${MANAGED}/claim-issue-56`, { facts: { githubOrigin: true, idleMs: 2 * HOUR } }, 'retire'],
    ['claim with no PR at its head stays held while recently active', 'claim/issue-56', `${MANAGED}/claim-issue-56`, { facts: { githubOrigin: true, idleMs: 10 * 60 * 1000 } }, 'claim-completion-unverified'],
    ['claim with an open PR is held', 'claim/issue-57', `${MANAGED}/claim-issue-57`, { scan: { openPr: { number: 57 } }, facts: { githubOrigin: true, idleMs: DAY } }, 'claim-completion-unverified'],
    ['claim whose PR state was not read is held', 'claim/issue-58', `${MANAGED}/claim-issue-58`, { scan: { prStateUnavailable: true }, facts: { githubOrigin: true, idleMs: DAY } }, 'claim-completion-unverified'],
    // deleteMergedBranches passes only `{ branch }`: no forge listing ran, so no "no open PR" answer exists.
    ['claim from an entry no forge listing produced is held', 'claim/issue-59', `${MANAGED}/claim-issue-59`,
      { scan: { openPr: undefined, prStateUnavailable: undefined, worktreePath: undefined }, facts: { githubOrigin: true, idleMs: DAY } }, 'claim-completion-unverified'],
    ['unmerged head is held', 'claim/issue-25', `${MANAGED}/claim-issue-25`, { facts: { mergedAtHead: false } }, 'not-merged-on-recheck'],
    ['unreadable status holds authored files', 'claim/issue-31', `${MANAGED}/claim-unreadable`, { facts: { dirty: null } }, 'worktree-status-unavailable'],
    ['dispatching agent tree is held', 'agent/dispatching', `${MANAGED}/agent-dispatching`, { activeAgentIds: new Set(['agent-dispatching']) }, 'worktree-active-agent'],
    ['agent tree retires once dispatch settles', 'agent/dispatching', `${MANAGED}/agent-dispatching`, {}, 'retire'],
    ['agent tree is held when liveness is unknown', 'agent/registering', `${MANAGED}/agent-registering`, { activeAgentIds: undefined }, 'worktree-agent-liveness-unknown'],
    ['human handoff policy holds a merged branch', 'fix/policy-held-tree', `${MANAGED}/policy-held`, { facts: { policyHold: 'pr-completion-human-handoff' } }, 'pr-completion-human-handoff'],
    ['dirty checkout at a merged PR head is disposable', 'fix/merged-pr', '/work/elsewhere/merged', { disposableHead: HEAD, facts: { dirty: true } }, 'retire'],
    ['dirty checkout whose merged PR is another head is held', 'fix/merged-pr', '/work/elsewhere/merged', { disposableHead: 'c'.repeat(40), facts: { dirty: true } }, 'worktree-dirty'],
    ['holder that moved since the scan is held', 'fix/moved', '/work/elsewhere/moved', { scan: { worktreePath: '/work/elsewhere/old-spot' } }, 'worktree-holder-changed'],
    ['branch checked out in the primary checkout is held', 'fix/primary', REPO, {}, 'currently-checked-out'],
    ['unreadable worktree list is held', 'fix/list', '/work/elsewhere/list', { facts: { holders: null } }, 'worktree-ownership-unreadable'],
    ['protected branch is held', 'main', '/work/elsewhere/main', {}, 'protected-branch'],
    ['resolved default branch is held', 'trunk', '/work/elsewhere/trunk', { facts: { defaultBranch: 'trunk' } }, 'protected-branch'],
    ['unreadable default branch is held', 'fix/x', '/work/elsewhere/x', { facts: { defaultBranch: null } }, 'default-branch-unavailable'],
    ['vanished branch head is held as unmerged', 'fix/gone', '/work/elsewhere/gone', { facts: { head: null } }, 'not-merged-on-recheck'],
  ])('%s', (_name, branch, path, overrides, expected) => {
    expect(reasonOf(mergedCase(branch, path, overrides))).toBe(expected);
  });

  it('holds a holder whose head moved after the merge recheck', () => {
    const c = mergedCase('claim/issue-11', `${MANAGED}/claim-issue-11`, { facts: { receipt: true } });
    c.facts.holders[1] = { ...c.facts.holders[1], head: 'd'.repeat(40) };
    expect(reasonOf(c)).toBe('worktree-holder-changed');
  });

  it('retires a branch with no checkout from the merge evidence alone', () => {
    expect(decide(mergedCase('fix/ref-only', null, { scan: { worktreePath: null } }))).toMatchObject({
      admit: { worktreePath: null, claimCompletion: null }, asked: ['agents', 'defaultBranch', 'head', 'policyHold', 'holders', 'mergedAtHead'],
    });
  });

  it('reports which completion evidence admitted a claim and what removal must re-prove', () => {
    const receipt = decide(mergedCase('claim/issue-11', `${MANAGED}/claim-issue-11`, { facts: { receipt: true } }));
    expect(receipt.admit).toMatchObject({ claimCompletion: 'receipt', expectedHead: HEAD, requireCleanWorktree: true, worktreePath: `${MANAGED}/claim-issue-11` });
    const forge = decide(mergedCase('claim/issue-21', `${MANAGED}/claim-issue-21`, { facts: { forgeMerge: { mergedAt: new Date(NOW - 3 * HOUR).toISOString() } } }));
    expect(forge.admit.claimCompletion).toBe('forge-merged');
    const disposable = decide(mergedCase('fix/merged-pr', '/work/elsewhere/merged', { disposableHead: HEAD, facts: { dirty: true } }));
    expect(disposable.admit.requireCleanWorktree).toBe(false);
  });

  describe('registered owners (re-read under the binding lock)', () => {
    it.each([
      ['a running claim bound to the branch', [live('agent-live-claim', { claimBranches: ['claim/issue-24'] })], 'claim/issue-24', 'claim-owner-active'],
      ['a paused owner of the branch', [live('agent-owner', { claimBranch: 'claim/issue-32' }, { status: 'paused' })], 'claim/issue-32', 'claim-owner-active'],
      ['a coordinator reservation', [live('agent-coordinator', { claimBranches: ['next/issue-33'] })], 'next/issue-33', 'claim-owner-active'],
      ['a newly claimed branch an empty snapshot missed', [live('new-owner', { claimBranches: ['fix/stale-owner-snapshot'] })], 'fix/stale-owner-snapshot', 'claim-owner-active'],
      ['an unreadable registry', null, 'fix/unknown-owner', 'claim-ownership-unreadable'],
      ['an owner whose status is unknown', [{ id: 'agent-unknown', status: 'unknown', workspacePath: '/work/elsewhere/unknown' }], 'fix/unknown-owner', 'claim-ownership-unreadable'],
      ['a run whose workspace is the checkout', [{ id: 'agent-new-owner', status: 'running', workspacePath: '/work/elsewhere/fallback' }], 'fix/fallback', 'claim-owner-active'],
    ])('holds for %s before reading anything else', (_name, agents, branch, expected) => {
      const path = branch === 'fix/fallback' ? '/work/elsewhere/fallback' : branch === 'fix/unknown-owner' ? '/work/elsewhere/unknown' : `${MANAGED}/${branch.replace('/', '-')}`;
      const result = decide(mergedCase(branch, path, { facts: { agents } }));
      expect(result.hold.reason).toBe(expected);
      expect(result.asked).toEqual(['agents']);
    });

    it('treats a live owner\'s workspace basename as a running agent', () => {
      const agents = [live('agent-elsewhere', {}, { workspacePath: '/other/agent-held' })];
      expect(reasonOf(mergedCase('agent/held', `${MANAGED}/agent-held`, { facts: { agents } }))).toBe('worktree-active-agent');
    });

    it('lets the sibling of an actively owned claim retire', () => {
      const agents = [live('agent-live-claim', { claimBranches: ['claim/issue-24'] })];
      expect(reasonOf(mergedCase('claim/issue-21', `${MANAGED}/claim-issue-21`, {
        scan: { worktreeAgeMs: 2 * HOUR }, facts: { agents, forgeMerge: { mergedAt: new Date(NOW - 3 * HOUR).toISOString() } },
      }))).toBe('retire');
    });
  });

  it('reads facts lazily: a lock never pays for a status read or forge call', () => {
    expect(decide(mergedCase('claim/issue-6', `${MANAGED}/claim-issue-6`, { locked: true })).asked).toEqual(['agents', 'defaultBranch', 'head', 'policyHold', 'holders', 'mergedAtHead']);
  });

  it('asks for forge evidence only after the receipt is missing, and the origin only without a merged PR', () => {
    expect(decide(mergedCase('claim/issue-11', `${MANAGED}/claim-issue-11`, { facts: { receipt: true } })).asked.slice(-3))
      .toEqual(['dirty', 'completionRecords', 'receipt']);
    expect(decide(mergedCase('claim/issue-5', `${MANAGED}/claim-issue-5`, { facts: { githubOrigin: true, idleMs: 0 } })).asked.slice(-4))
      .toEqual(['receipt', 'forgeMerge', 'githubOrigin', 'idleMs']);
    // A young checkout is held before any forge read.
    expect(decide(mergedCase('claim/issue-29', `${MANAGED}/claim-issue-29`, { scan: { worktreeAgeMs: 0 } })).asked.at(-1)).toBe('receipt');
  });
});

describe('decideBranchRetirement — superseded (unmerged) retirement', () => {
  const superseded = (branch, path, { scan = {}, facts = {}, ...input } = {}) => ({
    input: { repoPath: REPO, branch, allowLiveClaim: true, unmanagedIdleMs: SHIPPED_CLAIM_IDLE_MS, headMustMatchScan: true,
      activeAgentIds: new Set(), roots: ROOTS, nowMs: NOW,
      scan: { worktreePath: path, worktreeLocked: false, worktreeAgeMs: 0, tip: HEAD, ...scan }, ...input },
    facts: { agents: [], defaultBranch: 'main', head: HEAD, policyHold: null, dirty: false, ...facts },
  });

  it.each([
    ['a clean managed claim retires once its policy clears', 'claim/issue-77', `${MANAGED}/claim-issue-77`, {}, 'retire'],
    ['a recorded review obligation holds', 'claim/issue-77', `${MANAGED}/claim-issue-77`, { facts: { policyHold: 'pr-completion-review-required' } }, 'pr-completion-review-required'],
    ['a human handoff holds', 'claim/issue-77', `${MANAGED}/claim-issue-77`, { facts: { policyHold: 'pr-completion-human-handoff' } }, 'pr-completion-human-handoff'],
    ['an unreadable checkout holds authored files', 'fix/superseded-unreadable', `${MANAGED}/superseded`, { facts: { dirty: null } }, 'worktree-status-unavailable'],
    ['a dirty checkout holds', 'fix/superseded-dirty', `${MANAGED}/superseded`, { facts: { dirty: true } }, 'worktree-dirty'],
    ['a head that moved after the verdict holds', 'fix/superseded-moved', `${MANAGED}/superseded`, { facts: { head: 'e'.repeat(40) } }, 'branch-head-changed'],
    ['a vanished head holds', 'fix/superseded-gone', `${MANAGED}/superseded`, { facts: { head: null } }, 'branch-head-unavailable'],
    ['a fresh checkout outside the managed roots holds', 'fix/tmp', '/tmp/agent-checkout', {}, 'worktree-unmanaged-location'],
    ['an idle checkout outside the managed roots retires', 'fix/tmp', '/tmp/agent-checkout', { scan: { worktreeAgeMs: 2 * HOUR } }, 'retire'],
    // These were real-git superseded cases in heldCheckoutRecovery.test.js.
    ['a live owner of the branch holds', 'feature/superseded', `${MANAGED}/superseded`, { facts: { agents: [live('new-owner', { claimBranches: ['feature/superseded'] })] } }, 'claim-owner-active'],
    ['a branch with no checkout retires', 'feature/no-worktree', null, {}, 'retire'],
  ])('%s', (_name, branch, path, overrides, expected) => {
    expect(reasonOf(superseded(branch, path, overrides))).toBe(expected);
  });

  it('dates an unmanaged-location hold so the caller can park until it lifts', () => {
    expect(decide(superseded('fix/tmp', '/tmp/agent-checkout', { scan: { worktreeAgeMs: HOUR / 2 } })).hold)
      .toEqual({ reason: 'worktree-unmanaged-location', retryAt: new Date(NOW + HOUR / 2).toISOString() });
  });

  it('dates a stale-claim grace hold when the caller does not waive live claims', () => {
    const c = superseded('claim/issue-78', `${MANAGED}/claim-issue-78`, { allowLiveClaim: false, scan: { worktreeAgeMs: STALE_CLAIM_IDLE_MS - DAY } });
    expect(decide(c).hold).toEqual({ reason: 'worktree-human-claim', retryAt: new Date(NOW + DAY).toISOString() });
  });
});

describe('supersededPolicyHold', () => {
  const REVIEW = 'pr-completion-review-required';
  it.each([
    ['reaps past a completed review obligation that never recorded a PR', { hold: REVIEW, detail: { reason: REVIEW, unshipped: true } }, null],
    ['keeps a superseded branch whose review obligation recorded a PR', { hold: REVIEW, detail: { reason: REVIEW, unshipped: false } }, REVIEW],
    ['keeps a superseded branch whose obligation detail is unreadable', { hold: REVIEW, detail: null }, REVIEW],
    ['keeps a superseded branch whose detail names another hold', { hold: REVIEW, detail: { reason: 'pr-completion-policy-unreadable', unshipped: true } }, REVIEW],
    ['keeps a superseded branch under a human handoff without reading detail', { hold: 'pr-completion-human-handoff' }, 'pr-completion-human-handoff'],
    ['keeps a superseded branch with an open PR without reading detail', { hold: REVIEW, openPr: { number: 7 } }, REVIEW],
    ['never waives an obligation for a merged retirement', { hold: REVIEW, superseded: false }, REVIEW],
  ])('%s', (_name, input, expected) => {
    expect(supersededPolicyHold({ superseded: true, ...input })).toEqual({ hold: expected });
  });

  it('asks for the obligation detail only when the waiver could apply', () => {
    expect(supersededPolicyHold({ hold: REVIEW, superseded: true })).toEqual({ need: 'detail' });
  });
});

describe('decideDetachedRetirement', () => {
  const detached = (overrides = {}, dirty = false) => {
    const input = { path: `${MANAGED}/clean-detached`, locked: false, activeAgentIds: new Set(), ageMs: 0, roots: ROOTS, scanDirtyPaths: [], nowMs: NOW, ...overrides };
    const first = decideDetachedRetirement(input);
    return first.need ? decideDetachedRetirement({ ...input, facts: { dirty } }) : first;
  };

  it.each([
    ['clean managed detached checkout retires', {}, false, null],
    ['unreadable detached checkout is held', {}, null, 'worktree-status-unavailable'],
    ['unreadable gather of a detached checkout is held', { scanDirtyPaths: null }, false, 'worktree-status-unavailable'],
    ['dirty detached checkout is held', {}, true, 'worktree-dirty'],
    ['dirt seen by the gather holds', { scanDirtyPaths: ['wip.txt'] }, false, 'worktree-dirty'],
    ['locked detached checkout is held', { locked: true }, false, 'worktree-locked'],
    ['unreadable registry holds', { ownersReadable: false }, false, 'claim-ownership-unreadable'],
    ['detached checkout outside the managed roots is held', { path: '/work/elsewhere/detached' }, false, 'worktree-unmanaged-location'],
    ['live agent detached checkout is held', { path: `${MANAGED}/agent-live`, activeAgentIds: new Set(['agent-live']) }, false, 'worktree-active-agent'],
  ])('%s', (_name, overrides, dirty, expected) => {
    const step = detached(overrides, dirty);
    expect(step.hold?.reason ?? null).toBe(expected);
    if (!expected) expect(step).toEqual({ admit: true });
  });
});

describe('gatheredHoldReason and dispatch classification', () => {
  const entry = { branch: 'claim/issue-1', hasUpstream: true, hasOrigin: true, isMerged: false, hasWorktree: false, worktreeDirty: false,
    ahead: 1, behind: 0, openPr: { number: 1, mergeable: 'MERGEABLE' }, prStateUnavailable: false };
  const classify = pendingMergeBranches => classifyBranches([{ ...entry, liveOwnerReason: gatheredHoldReason({ branch: entry.branch, pendingMergeBranches }) }])[0];

  it.each([
    ['no app to ask', undefined, { state: 'IN_REVIEW' }],
    ['an empty merge queue', new Set(), { state: 'IN_REVIEW' }],
    ['a branch queued for the merge coordinator', new Set(['claim/issue-1']), { state: 'WIP', liveOwnerReason: 'pending-merge-queued' }],
    ['an unreadable merge queue', null, { state: 'WIP', liveOwnerReason: 'pending-merge-unavailable' }],
  ])('%s', (_name, pendingMergeBranches, expected) => {
    expect(classify(pendingMergeBranches)).toMatchObject(expected);
  });

  it('ranks a live owner over a claim owner, the merge queue and unreadable status', () => {
    const all = { liveOwnerReason: 'worktree-locked', claimOwnerReason: 'claim-owner-active', pendingMergeBranches: null, branch: 'b', worktreeStatusUnavailable: true };
    expect(gatheredHoldReason(all)).toBe('worktree-locked');
    expect(gatheredHoldReason({ ...all, liveOwnerReason: null })).toBe('claim-owner-active');
    expect(gatheredHoldReason({ ...all, liveOwnerReason: null, claimOwnerReason: null })).toBe('pending-merge-unavailable');
    expect(gatheredHoldReason({ branch: 'b', worktreeStatusUnavailable: true })).toBe('worktree-status-unavailable');
    expect(gatheredHoldReason({ branch: 'b' })).toBeNull();
  });

  it.each([
    ['a dirty claim with no commits becomes abandoned work for a coordinator', { worktreeDirty: true, dirtyPaths: ['wip.txt'], isMerged: true, ahead: 0, abandonedClaimWorktree: true, hasWorktree: true, openPr: null }, 'ABANDONED_WIP'],
    ['committed claim work with no forge stays held as WIP', { hasOrigin: false, hasUpstream: false, isMerged: false, ahead: 1, hasWorktree: true, openPr: null }, 'WIP'],
  ])('%s', (_name, overrides, state) => {
    expect(classifyBranches([{ ...entry, liveOwnerReason: null, ...overrides }])[0].state).toBe(state);
  });
});

describe('recoveryWorktreeReason', () => {
  it.each([
    [{ prunable: true, locked: true, managed: true }, 'worktree-prunable'],
    [{ prunable: false, locked: true, managed: false }, 'worktree-locked'],
    [{ prunable: false, locked: false, managed: false }, 'worktree-unmanaged-location'],
    [{ prunable: false, locked: false, managed: true }, 'checkout-retained'],
  ])('%o → %s', (tree, expected) => {
    expect(recoveryWorktreeReason(tree)).toBe(expected);
  });
});

// Held-checkout recovery (#16153). Every row was a real-git case in
// heldCheckoutRecovery.test.js; that suite keeps one real-git contract per
// outcome and destructive refusal.
const HELD = '/work/elsewhere/held';
const LOCK = 'synthetic external owner';

/** Run a decide-or-ask decision the way heldCheckoutRecovery's driver does. */
function drive(decision, input, answers) {
  const facts = {};
  const asked = [];
  for (;;) {
    const step = decision({ ...input, facts });
    if (!step.need) return { ...step, asked };
    if (!(step.need in answers)) throw new Error(`decision asked for an unsupplied fact: ${step.need}`);
    asked.push(step.need);
    facts[step.need] = answers[step.need];
  }
}
const verdict = step => step.hold?.reason ?? 'retire';

describe('decideHeldCheckoutRetirement', () => {
  const owners = { agents: [], runtimeAgentIds: new Set(), completionHold: null };
  /** A locked, inventoried checkout of `feature/held` whose commits are on main, with every fact clean. */
  const held = ({ release = {}, tree = {}, facts = {}, ...input } = {}) => {
    const r = { path: HELD, head: HEAD, branch: 'feature/held', locked: true, lockReason: LOCK, ...release };
    const listed = { path: r.path, branch: r.branch ? `refs/heads/${r.branch}` : null, head: r.head, locked: r.locked, lockReason: r.lockReason, ...tree };
    return drive(decideHeldCheckoutRetirement, { repoPath: REPO, release: r, ...input }, {
      trees: [{ path: REPO, branch: 'refs/heads/main', head: MAIN_HEAD }, listed],
      samePhysical: true, identity: 'checkout-1', mergeEvidence: true, clean: true, ...owners, ...facts,
    });
  };
  const exact = { deliveredHead: HEAD, disposableHead: HEAD };
  const contained = { deliveredHead: HEAD, disposableHead: null };

  it.each([
    // [removed real-git case, overrides, verdict]
    ['clean squash-merged checkout retires with its branch', {}, 'retire'],
    ['completion-review obligation settles in one step once merged', { facts: { completionHold: 'pr-completion-review-required' } }, 'retire'],
    ['unmerged completion-review checkout beside a PR merged at another head', { facts: { mergeEvidence: false, completionHold: 'pr-completion-review-required' } }, 'not-merged-on-recheck'],
    ['unmerged work is refused', { release: { locked: false, lockReason: null }, facts: { mergeEvidence: false } }, 'not-merged-on-recheck'],
    ['clean checkout contained in a later merged PR head retires', contained, 'retire'],
    ['dirty checkout contained in a later merged PR head is held', { ...contained, facts: { clean: false } }, 'worktree-dirty'],
    ['dirty checkout whose PR merged at its exact head retires', { ...exact, facts: { clean: false, mergeEvidence: false } }, 'retire'],
    ['dirty exact delivery with a submodule retires unlocked too', { ...exact, release: { locked: false, lockReason: null }, facts: { clean: false } }, 'retire'],
    ['dirty checkout whose PR merged at another head is held', { facts: { clean: false } }, 'worktree-dirty'],
    ['dirty locked detached checkout is held', { release: { branch: null }, facts: { clean: false } }, 'worktree-dirty'],
    ['unreadable status holds', { facts: { clean: null } }, 'worktree-status-unavailable'],
    ['a lock changed since the inventory is an ownership change', { tree: { lockReason: 'new owner took over' } }, 'checkout-lock-changed'],
    ['a lock released since the inventory is an ownership change', { tree: { locked: false, lockReason: null } }, 'checkout-lock-changed'],
    ['a moved HEAD since the inventory is an ownership change', { tree: { head: 'e'.repeat(40) } }, 'checkout-head-changed'],
    ['a receipt checkout whose head moved after the handoff', { ...exact, release: { locked: false, lockReason: null }, tree: { head: 'e'.repeat(40) } }, 'checkout-head-changed'],
    ['a switched branch is an ownership change', { tree: { branch: 'refs/heads/feature/other' } }, 'checkout-branch-changed'],
    ['a lexically equal spelling of a different physical checkout', { release: { path: `${HELD}/.` }, tree: { path: HELD }, facts: { samePhysical: false } }, 'checkout-identity-changed'],
    ['another spelling of the same physical checkout retires', { release: { path: `${HELD}/.` }, tree: { path: HELD } }, 'retire'],
    ['a checkout Git no longer lists', { tree: { path: '/work/elsewhere/other' } }, 'checkout-not-found'],
    ['an unreadable worktree list', { facts: { trees: null } }, 'worktree-ownership-unreadable'],
    ['the primary checkout', { release: { path: REPO }, facts: { trees: [{ path: REPO, branch: 'refs/heads/feature/held', head: HEAD, locked: true, lockReason: LOCK }] } }, 'checkout-primary'],
    ['a prunable registration', { tree: { prunable: true } }, 'worktree-prunable'],
    ['an unreadable checkout identity', { facts: { identity: null } }, 'checkout-identity-changed'],
    ['a recreated checkout at the inventoried path', { release: { checkoutIdentity: 'checkout-0' } }, 'checkout-identity-changed'],
    ['a manual completion handoff', { facts: { completionHold: 'pr-completion-human-handoff' } }, 'pr-completion-human-handoff'],
    ['unreadable completion policy', { facts: { completionHold: 'pr-completion-policy-unavailable' } }, 'pr-completion-policy-unavailable'],
    ['an unreadable owner registry', { facts: { agents: null } }, 'claim-ownership-unreadable'],
    ['a live run whose workspace is the checkout', { facts: { agents: [{ id: 'agent-live', status: 'running', workspacePath: HELD }] } }, 'claim-owner-active'],
    ['a live claim bound to the branch', { facts: { agents: [live('new-owner', { claimBranches: ['feature/held'] })] } }, 'claim-owner-active'],
    ['a running agent in a managed agent checkout', { release: { path: `${MANAGED}/agent-1234abcd` }, facts: { runtimeAgentIds: new Set(['agent-1234abcd']) } }, 'worktree-active-agent'],
  ])('%s', (_name, overrides, expected) => {
    expect(verdict(held(overrides))).toBe(expected);
  });

  it('admits the listed registration under the release spelling with the identity it read', () => {
    expect(held({ release: { path: `${HELD}/.` }, tree: { path: HELD } }).admit).toEqual({
      tree: { path: `${HELD}/.`, branch: 'refs/heads/feature/held', head: HEAD, locked: true, lockReason: LOCK }, checkoutIdentity: 'checkout-1',
    });
  });

  it('reads facts lazily: a registration change reads nothing else, dirt reads no owner, delivery skips local merge evidence', () => {
    expect(held({ tree: { head: 'e'.repeat(40) } }).asked).toEqual(['trees']);
    expect(held({ facts: { clean: false } }).asked).toEqual(['trees', 'identity', 'mergeEvidence', 'clean']);
    expect(held(exact).asked).toEqual(['trees', 'identity', 'clean', 'agents', 'runtimeAgentIds', 'completionHold']);
    // The physical check runs only for a different spelling; a detached checkout has no policy to read.
    expect(held({ release: { path: `${HELD}/.` }, tree: { path: HELD } }).asked.slice(0, 2)).toEqual(['trees', 'samePhysical']);
    expect(held({ release: { branch: null } }).asked.at(-1)).toBe('runtimeAgentIds');
  });

  it('asks for the physical identity of the listed spelling', () => {
    const step = decideHeldCheckoutRetirement({ repoPath: REPO, release: { path: `${HELD}/.`, head: HEAD, branch: null, locked: false, lockReason: null },
      facts: { trees: [{ path: REPO }, { path: HELD, head: HEAD, branch: null }] } });
    expect(step).toEqual({ need: 'samePhysical', path: HELD });
  });

  it('counts a nested repository as uncommitted work', () => {
    // `git status` lists a nested repository as an untracked directory.
    expect(classifyWorktreeDirt('?? nested/\n').clean).toBe(false);
  });
});

describe('decideMergedCheckoutOwner', () => {
  const owner = (input, facts) => verdict(drive(decideMergedCheckoutOwner, { repoPath: REPO, ...input },
    { agents: [], runtimeAgentIds: new Set(), completionHold: null, ...facts }));

  it.each([
    ['an owner arriving before removal holds the checkout', { path: HELD, branch: null }, { agents: [{ id: 'agent-live', status: 'running', workspacePath: HELD }] }, 'claim-owner-active'],
    ['a removed checkout\'s branch with no owner is free', { path: null, branch: 'feature/held' }, {}, 'retire'],
    ['a running agent named by its CoS branch holds the branch', { path: null, branch: 'cos/task-1/agent-1234abcd' }, { runtimeAgentIds: new Set(['agent-1234abcd']) }, 'branch-active-agent'],
    ['a human handoff keeps the branch after its checkout is gone', { path: null, branch: 'feature/held' }, { completionHold: 'pr-completion-human-handoff' }, 'pr-completion-human-handoff'],
  ])('%s', (_name, input, facts, expected) => {
    expect(owner(input, facts)).toBe(expected);
  });
});

describe('decidePendingMergeReceipt', () => {
  const release = { path: HELD, head: HEAD, branch: 'feature/receipt', locked: false, lockReason: null };
  const receipt = ({ forge = { prHead: HEAD }, ...input } = {}) => drive(decidePendingMergeReceipt, { release, expectedHeadSha: HEAD, ...input }, { forge });

  it.each([
    ['a PR merged at another head', { forge: { prHead: 'f'.repeat(40) } }, 'receipt-pr-head-changed'],
    ['a forge refusal keeps its own reason', { forge: { error: new Error('merged-pr-remote-head-changed') } }, 'merged-pr-remote-head-changed'],
    ['any other forge failure is unverified, never a raw error', { forge: { error: new Error('private diagnostic') } }, 'receipt-pr-merge-unverified'],
    ['a locked receipt checkout', { release: { ...release, locked: true, lockReason: 'owner' } }, 'receipt-checkout-locked'],
    ['a receipt for another head', { expectedHeadSha: 'e'.repeat(40) }, 'receipt-checkout-head-unverified'],
    ['a receipt without a full head', { expectedHeadSha: 'abc123' }, 'receipt-checkout-head-unverified'],
    ['a receipt without a branch', { release: { ...release, branch: null } }, 'receipt-checkout-head-unverified'],
  ])('holds %s', (_name, input, expected) => {
    expect(verdict(receipt(input))).toBe(expected);
  });

  it('hands retirement an exact or a contained delivery, reading the forge only once the receipt matches', () => {
    expect(receipt()).toEqual({ admit: { delivery: 'exact' }, asked: ['forge'] });
    expect(receipt({ forge: { prHead: 'c'.repeat(40), scopeProof: 'ancestor-of-delivered-head', deliveredAncestorHead: HEAD } }).admit).toEqual({ delivery: 'contained' });
    expect(receipt({ expectedHeadSha: 'e'.repeat(40) }).asked).toEqual([]);
  });
});

describe('decideMergedDelivery', () => {
  const merged = (clean, ancestry, delivery) => drive(decideMergedDelivery, { clean, ancestry }, { delivery }).merged;

  it.each([
    ['merged and clean, without asking the forge', true, true, undefined, true],
    ['unmerged with no delivery', true, false, 'none', false],
    ['unknown when the forge cannot be read', true, false, null, null],
    ['merged with uncommitted work and no exact delivery', false, true, 'none', false],
    ['merged with uncommitted work at the exact merged head', false, true, 'exact', true],
    ['contained in a later merged head and clean', true, false, 'contained', true],
    ['contained in a later merged head with uncommitted work', false, false, 'contained', false],
    ['merged work whose status cannot be read', null, true, 'none', null],
  ])('%s', (_name, clean, ancestry, delivery, expected) => {
    expect(merged(clean, ancestry, delivery)).toBe(expected);
  });
});

describe('decideInventoriedBranchRetirement', () => {
  const branch = 'feature/inventoried';
  const inventoried = ({ delivered = false, facts = {} } = {}) => drive(decideInventoriedBranchRetirement, { repoPath: REPO, branch, head: HEAD, delivered }, {
    inventoryRow: true, defaultBranch: 'main', holders: [{ path: REPO, branch: 'refs/heads/main' }], presence: true, symbolicExit: 1, tip: HEAD,
    mergeEvidence: true, agents: [], runtimeAgentIds: new Set(), completionHold: null, ...facts,
  });

  it.each([
    ['a merged ref is deleted', {}, 'retire'],
    ['an unmerged ref is kept', { facts: { mergeEvidence: false } }, 'not-merged-on-recheck'],
    ['an already-absent ref without the forge\'s merge is kept visible', { facts: { presence: false } }, 'not-merged-on-recheck'],
    ['an already-absent ref the forge delivered settles', { delivered: true, facts: { presence: false } }, 'retire'],
    ['a row the inventory no longer names', { facts: { inventoryRow: false } }, 'release-not-in-inventory'],
    ['an unreadable default branch', { facts: { defaultBranch: null } }, 'default-branch-unavailable'],
    ['the resolved default branch', { facts: { defaultBranch: branch } }, 'protected-branch'],
    ['a branch checked out again', { facts: { holders: [{ path: HELD, branch: `refs/heads/${branch}` }] } }, 'branch-has-new-holder'],
    ['an unreadable worktree list', { facts: { holders: null } }, 'branch-has-new-holder'],
    ['unverifiable ref presence', { facts: { presence: null } }, 'branch-ref-presence-unverified'],
    ['a symbolic ref at the branch name', { facts: { symbolicExit: 0 } }, 'branch-ref-presence-unverified'],
    ['a ref that moved or was recreated', { facts: { tip: 'e'.repeat(40) } }, 'branch-ref-changed-or-recreated'],
    ['a live claim on the branch', { facts: { agents: [live('new-owner', { claimBranches: [branch] })] } }, 'claim-owner-active'],
  ])('%s', (_name, overrides, expected) => {
    expect(verdict(inventoried(overrides))).toBe(expected);
  });

  it('reports a missing ref, and reads local merge evidence only without the forge\'s delivery', () => {
    expect(inventoried({ delivered: true, facts: { presence: false } }).admit).toEqual({ missing: true });
    expect(inventoried().admit).toEqual({ missing: false });
    expect(inventoried({ delivered: true }).asked).not.toContain('mergeEvidence');
    expect(inventoried({ facts: { presence: false } }).asked).toEqual(['inventoryRow', 'defaultBranch', 'holders', 'presence']);
  });
});

// The early merged-worktree reaper (#16153). Every row was a real-git case in
// worktreeReap.test.js; that suite keeps one real-git contract per outcome and
// destructive refusal.
describe('decideMergedWorktreeReap', () => {
  const COS = '/data/cos/worktrees';
  const tree = (name, branch, extra = {}) => ({ path: `${MANAGED}/${name}`, branch: `refs/heads/${branch}`, head: HEAD, locked: false, ...extra });
  const reap = ({ tree: t = tree('merged', 'merged-br'), facts = {}, ...input } = {}) => drive(decideMergedWorktreeReap, {
    tree: t, defaultBranch: 'main', currentBranch: 'main', worktreesDir: COS, claudeTreesRoot: MANAGED, includeClaudeTrees: true,
    activeAgentIds: new Set(), ...input,
  }, { dirty: false, disposableHead: false, mergeEvidence: true, ...facts });

  it.each([
    // [removed real-git case, overrides, verdict]
    ['a merged clean .claude tree is reaped', {}, 'retire'],
    ['a merged branch whose checkout vanished (its status reads empty) is reaped', { facts: { dirty: false } }, 'retire'],
    ['an unmerged tree is preserved', { facts: { mergeEvidence: false } }, 'unmerged'],
    ['a merged tree with uncommitted changes is preserved', { facts: { dirty: true } }, 'uncommitted'],
    ['a dirty tree whose PR merged at its exact head is reaped', { facts: { dirty: true, disposableHead: true } }, 'retire'],
    ['a dirty tree whose PR merged at another head is preserved', { facts: { dirty: true, disposableHead: false } }, 'uncommitted'],
    ['a fresh-from-main tree with uncommitted changes is preserved', { facts: { dirty: true, mergeEvidence: false } }, 'uncommitted'],
    ['a locked merged tree is preserved', { tree: tree('locked', 'locked-br', { locked: true }) }, 'worktree-locked'],
    ['an active agent\'s merged tree is skipped', { tree: tree('agent-active', 'active-br'), activeAgentIds: new Set(['agent-active']) }, 'worktree-active-agent'],
    ['an agent tree holds while liveness is unknown', { tree: tree('agent-abc12345', 'cos/task-1/agent-abc12345'), activeAgentIds: null }, 'worktree-agent-liveness-unknown'],
    ['a merged clean agent tree is reaped', { tree: tree('agent-abc12345', 'cos/task-1/agent-abc12345') }, 'retire'],
    ['a human /claim tree is never reaped, even merged and clean', { tree: tree('claim-issue-42', 'claim/issue-42') }, 'worktree-human-claim'],
    ['a claim-shaped tree in the CoS root lacks an agent id', { tree: { ...tree('x', 'claim/issue-42'), path: `${COS}/claim-issue-42` } }, 'worktree-missing-agent-id'],
    ['a merged tree outside the managed roots is preserved', { tree: { ...tree('x', 'loose-br'), path: '/work/elsewhere/loose' } }, 'worktree-unmanaged-location'],
    ['a merged clean gh-pages tree is protected', { tree: tree('pages', 'gh-pages') }, 'protected'],
    ['a custom default branch is protected', { tree: tree('trunk', 'trunk'), defaultBranch: 'trunk' }, 'protected'],
    ['the source workspace\'s checked-out branch is protected', { currentBranch: 'merged-br' }, 'protected'],
    ['.claude trees are excluded on request', { includeClaudeTrees: false }, 'claude-tree-excluded'],
    ['a CoS agent tree is still reaped when .claude trees are excluded', { tree: { ...tree('x', 'cos/task-1/agent-abc12345'), path: `${COS}/agent-abc12345` }, includeClaudeTrees: false }, 'retire'],
    ['an unreadable status holds', { facts: { dirty: null } }, 'status-failed'],
    ['a detached checkout has no branch', { tree: tree('detached', 'x', { branch: undefined, detached: true }) }, 'no-branch'],
    ['a bare entry has no branch', { tree: tree('bare', 'x', { bare: true }) }, 'no-branch'],
  ])('%s', (_name, overrides, expected) => {
    expect(verdict(reap(overrides))).toBe(expected);
  });

  it('names the held branch only when the entry has one, and admits dirt only at an exact merged head', () => {
    expect(reap({ tree: tree('detached', 'x', { branch: undefined, detached: true }) }).branch).toBeNull();
    expect(reap({ tree: tree('locked', 'locked-br', { locked: true }) }).branch).toBe('locked-br');
    expect(reap().admit).toEqual({ branch: 'merged-br', disposable: false });
    expect(reap({ facts: { dirty: true, disposableHead: true } }).admit).toEqual({ branch: 'merged-br', disposable: true });
  });

  it('reads facts lazily: a lock or live owner reads nothing, a clean tree asks no forge, dirt reads no merge evidence', () => {
    expect(reap({ tree: tree('locked', 'locked-br', { locked: true }) }).asked).toEqual([]);
    expect(reap({ tree: tree('agent-active', 'active-br'), activeAgentIds: new Set(['agent-active']) }).asked).toEqual([]);
    expect(reap().asked).toEqual(['dirty', 'mergeEvidence']);
    expect(reap({ facts: { dirty: true } }).asked).toEqual(['dirty', 'disposableHead']);
    expect(reap({ facts: { dirty: null } }).asked).toEqual(['dirty']);
  });

  it('counts lockfile-only churn as uncommitted work', () => {
    // The reaper never discards lockfiles the way removeWorktree() does.
    expect(classifyWorktreeDirt(' M package-lock.json\n').clean).toBe(false);
  });
});

describe('decideMergedWorktreeRemoval', () => {
  const PATH = `${MANAGED}/merged`;
  const scanned = { path: PATH, branch: 'refs/heads/merged-br', head: HEAD };
  const remove = ({ holder = { ...scanned, locked: false }, disposable = false, facts = {} } = {}) => drive(decideMergedWorktreeRemoval, {
    tree: scanned, holder, sourceWorkspace: REPO, disposable, worktreesDir: '/data/cos/worktrees', claudeTreesRoot: MANAGED,
  }, { agents: [], policyHold: null, activeAgentIds: new Set(), dirty: false, mergeEvidence: true, ...facts });

  it.each([
    ['the scanned holder still merged and clean is removed', {}, 'retire'],
    ['a holder Git no longer lists', { holder: null }, 'worktree-holder-changed'],
    ['a holder that switched branch', { holder: { ...scanned, branch: 'refs/heads/other' } }, 'worktree-holder-changed'],
    ['a run registered in the checkout', { facts: { agents: [{ id: 'agent-live', status: 'running', workspacePath: PATH }] } }, 'claim-owner-active'],
    ['a live claim bound to the branch', { facts: { agents: [live('new-owner', { claimBranches: ['merged-br'] })] } }, 'claim-owner-active'],
    ['an unreadable owner registry', { facts: { agents: null } }, 'claim-ownership-unreadable'],
    ['a completion handoff', { facts: { policyHold: 'pr-completion-human-handoff' } }, 'pr-completion-human-handoff'],
    ['a lock taken since the scan', { holder: { ...scanned, locked: true } }, 'worktree-locked'],
    ['an agent dispatched into the tree since the scan', { facts: { activeAgentIds: new Set(['merged']) } }, 'worktree-active-agent'],
    ['fresh status that cannot be read', { facts: { dirty: null } }, 'worktree-status-unavailable'],
    ['a clean tree that became dirty', { facts: { dirty: true } }, 'worktree-dirty'],
    ['disposable dirt while the holder is still at the merged head', { disposable: true, facts: { dirty: true } }, 'retire'],
    ['disposable dirt at the merged head spelled in another case', { disposable: true, holder: { ...scanned, head: HEAD.toUpperCase() }, facts: { dirty: true } }, 'retire'],
    ['disposable dirt after the holder\'s head moved', { disposable: true, holder: { ...scanned, head: 'e'.repeat(40) }, facts: { dirty: true } }, 'worktree-dirty'],
    ['merge evidence that no longer holds', { facts: { mergeEvidence: false } }, 'unmerged'],
  ])('%s', (_name, overrides, expected) => {
    expect(verdict(remove(overrides))).toBe(expected);
  });

  it('reads facts lazily: a changed holder reads nothing, an owner reads no policy, a lock reads no status', () => {
    expect(remove({ holder: null }).asked).toEqual([]);
    expect(remove({ facts: { agents: null } }).asked).toEqual(['agents']);
    expect(remove({ holder: { ...scanned, locked: true } }).asked).toEqual(['agents', 'policyHold', 'activeAgentIds']);
    expect(remove().asked).toEqual(['agents', 'policyHold', 'activeAgentIds', 'dirty', 'mergeEvidence']);
    expect(remove({ facts: { dirty: true } }).asked).not.toContain('mergeEvidence');
  });
});

describe('decideWith', () => {
  it('reads each asked fact once, in order, and records a failed read as null', async () => {
    const reads = [];
    const step = await decideWith(facts => {
      if (facts.first === undefined) return { need: 'first' };
      if (facts.second === undefined) return { need: 'second' };
      return { done: [facts.first, facts.second] };
    }, {
      first: async () => { reads.push('first'); return undefined; },
      second: (facts, asking) => { reads.push(`${asking.need}:${facts.first}`); return false; },
    });
    expect(step).toEqual({ done: [null, false] });
    expect(reads).toEqual(['first', 'second:null']);
  });
});
