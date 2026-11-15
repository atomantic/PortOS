/**
 * Hold/retire permutations for checkout retirement, decided over inspected
 * state (#16115). The real-git contract for each outcome stays in
 * branchReconcile.ownership.test.js; these pin every combination of holder,
 * head, merge, dirt, lock, owner and completion evidence, plus the order facts
 * are read in (a hold must not pay for a later, costlier read).
 */
import { describe, it, expect } from 'vitest';
import {
  decideBranchRetirement, decideDetachedRetirement, gatheredHoldReason, recoveryWorktreeReason, supersededPolicyHold,
  SHIPPED_CLAIM_IDLE_MS, STALE_CLAIM_IDLE_MS,
} from './branchRetirementDecision.js';
import { classifyBranches } from './branchReconcile.js';

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
      admit: { worktreePath: null, archiveTree: null, claimCompletion: null }, asked: ['agents', 'defaultBranch', 'head', 'policyHold', 'holders', 'mergedAtHead'],
    });
  });

  it('reports which completion evidence admitted a claim and what removal must re-prove', () => {
    const receipt = decide(mergedCase('claim/issue-11', `${MANAGED}/claim-issue-11`, { facts: { receipt: true } }));
    expect(receipt.admit).toMatchObject({ claimCompletion: 'receipt', expectedHead: HEAD, requireCleanWorktree: true,
      archiveTree: { path: `${MANAGED}/claim-issue-11`, head: HEAD } });
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
