/**
 * Tests for the CoS prompt PRE-STEP layer (`cosTaskPreStepBlocks.js`) — the
 * static prompt-fragment builders the claim prompts substitute (author filter,
 * exclude labels, swarm) and the shared perpetual-drain brakes.
 *
 * These moved here verbatim with their subjects when the pre-step layer was
 * split out of `cosTaskGenerator.js`; the assertions are unchanged. Source
 * guards that pin a call SHAPE rather than a file scan BOTH modules through
 * `LAYER_SRC`, because the generator still composes what lives here.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  applyPerpetualDrainCap,
  resolveIssueAuthorFilterBlock,
  resolveIssueExcludeLabelsBlock,
  resolveReconcileDrainGate,
  resolveSwarmBlock,
} from './cosTaskPreStepBlocks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GEN_SRC = readFileSync(join(__dirname, 'cosTaskGenerator.js'), 'utf-8');
const PRESTEP_SRC = readFileSync(join(__dirname, 'cosTaskPreStepBlocks.js'), 'utf-8');
// The CoS task-generation layer spans the selection engine and the pre-step
// module it composes. A guard about WHERE a call sits reads one file; a guard
// about the call's shape reads both, so moving code between them can neither
// break it nor silently disarm it.
const LAYER_SRC = `${GEN_SRC}\n${PRESTEP_SRC}`;

// #6112 — an abandoned volunteer claim is released deterministically, and the
// release must happen BEFORE the "no zombies → park" early return. A repo whose
// only stuck issues are abandoned claims has zero zombies on every pass, so a
// release ordered after the park would never run at all.
describe('issue-reconcile releases abandoned claims before it can park', () => {
  it('calls the releaser ahead of every parking / dispatch return', () => {
    const start = PRESTEP_SRC.indexOf('export async function resolveIssueReconcileBlock');
    const body = PRESTEP_SRC.slice(start, PRESTEP_SRC.indexOf('\n}', start));
    const releaseIdx = body.indexOf('releaseAbandonedClaims(result.abandoned');
    expect(releaseIdx, 'the pre-step must release abandoned claims').toBeGreaterThan(-1);
    expect(releaseIdx).toBeLessThan(body.indexOf("reason: 'no-zombie-issues'"));
    expect(releaseIdx).toBeLessThan(body.indexOf('resolveReconcileDrainGate('));
    // But never before the null guard: a transient/unsupported scan has no
    // `abandoned` set to read, and must skip without writing to the forge.
    expect(body.indexOf('if (!result) return { skip: true };')).toBeLessThan(releaseIdx);
  });
});

// The {issueAuthorFilter} directive is shared by the scheduled claim-work router
// AND the manual /do:next button (buildClaimWorkTask), so it is a standalone
// pure helper. These exercise it directly rather than via source string.
describe('resolveIssueAuthorFilterBlock', () => {
  it('returns the gh forge directive for the github claim body', () => {
    expect(resolveIssueAuthorFilterBlock('claim-issue', 'owner')).toContain('gh issue list');
    expect(resolveIssueAuthorFilterBlock('claim-issue', 'any')).toContain('regardless of who filed it');
    // 'self' = the --self security boundary: --author "@me", refuse third-party issues.
    expect(resolveIssueAuthorFilterBlock('claim-issue', 'self')).toContain('--author "@me"');
  });

  it('returns the glab forge directive for the gitlab claim body', () => {
    expect(resolveIssueAuthorFilterBlock('claim-issue-gitlab', 'owner')).toContain('glab issue list');
    expect(resolveIssueAuthorFilterBlock('claim-issue-gitlab', 'any')).toContain('regardless of who opened it');
    // 'self' resolves the authenticated glab username (no @me token on GitLab).
    expect(resolveIssueAuthorFilterBlock('claim-issue-gitlab', 'self')).toContain('glab api user');
  });

  it('tells the agent to build a trusted set and filter the listing in collaborators mode', () => {
    // Neither CLI's `--author` takes more than one account, so a prompt that
    // implied a multi-author query would send the agent in circles. Both blocks
    // must name the two-step recipe AND keep the boundary hard on failure.
    for (const [type, endpoint] of [
      ['claim-issue', 'repos/{owner}/{repo}/collaborators'],
      // members/all, so group-inherited members count as project members.
      ['claim-issue-gitlab', 'projects/:id/members/all']
    ]) {
      const block = resolveIssueAuthorFilterBlock(type, 'collaborators');
      expect(block).toContain(endpoint);
      expect(block).toContain('takes exactly ONE account');
      expect(block).toContain('do NOT silently fall back');
      if (type === 'claim-issue') {
        expect(block).toContain('if [ "$GH_HOST" = "ssh.github.com" ]');
      }
      // The endpoint the AGENT is told to call must be the one the work detector
      // actually calls — otherwise the claimable count PortOS shows and the set
      // the agent claims from silently diverge.
      expect(readFileSync(join(__dirname, 'perpetualWork.js'), 'utf-8')).toContain(endpoint);
    }
  });

  it('defaults to the gh block (harmless no-op) for plan/jira bodies and to self mode', () => {
    expect(resolveIssueAuthorFilterBlock('plan-task')).toContain('gh issue list');
    // Default (no mode) is the --self security boundary.
    expect(resolveIssueAuthorFilterBlock('claim-issue')).toContain('--author "@me"');
    // Unknown mode collapses to self, not owner/any/collaborators.
    expect(resolveIssueAuthorFilterBlock('claim-issue', 'bogus')).toContain('--author "@me"');
    // Including an inherited Object.prototype key, which a bare map lookup would
    // hand back as a "block".
    expect(resolveIssueAuthorFilterBlock('claim-issue', 'constructor')).toContain('--author "@me"');
  });
});

// {issueExcludeLabels} is the Phase 1 step 4 blocking-label directive — the fixed
// NON_ACTIONABLE_ISSUE_LABELS set (perpetualWork.js) plus any app-configured extras
// (e.g. `good first issue`), so the LIVE claim agent honors the same per-app
// exclusions the perpetual-drain detector applies.
describe('resolveIssueExcludeLabelsBlock', () => {
  it('renders the fixed base list with no configured extras (default, matches the prior static prompt text)', () => {
    const block = resolveIssueExcludeLabelsBlock();
    expect(block).toBe('`in-progress`, `blocked`, `needs-input`, `future`, `wontfix`, `question`, `discussion`');
  });

  it('appends configured extras after the fixed base list', () => {
    const block = resolveIssueExcludeLabelsBlock(['good first issue', 'help wanted']);
    expect(block).toBe('`in-progress`, `blocked`, `needs-input`, `future`, `wontfix`, `question`, `discussion`, `good first issue`, `help wanted`');
  });

  it('ignores non-string/empty entries and a non-array input', () => {
    expect(resolveIssueExcludeLabelsBlock(['ok', 42, '', null])).toBe(
      '`in-progress`, `blocked`, `needs-input`, `future`, `wontfix`, `question`, `discussion`, `ok`'
    );
    expect(resolveIssueExcludeLabelsBlock('not-an-array')).toBe(
      '`in-progress`, `blocked`, `needs-input`, `future`, `wontfix`, `question`, `discussion`'
    );
  });

  it('stays in sync with the NON_ACTIONABLE_ISSUE_LABELS set the perpetual-drain detector uses', () => {
    expect(PRESTEP_SRC).toContain("from './perpetualWork.js'");
  });

  it('buildClaimWorkTask threads the resolved block into the pinned-target constraint, not just the {issueExcludeLabels} placeholder', () => {
    expect(GEN_SRC).toContain('appendTargetWorkItemBlock(promptTaskType, targetRef, issueExcludeLabelsBlock)');
  });
});

// resolveSwarmBlock is prepended to the claim-issue prompt when swarmCount turns
// on `/do:next --swarm` mode. Like the author filter, it's a standalone pure
// helper shared by the scheduled router and the manual /do:next button.
describe('resolveSwarmBlock', () => {
  it('returns empty (off) below the swarm minimum', () => {
    expect(resolveSwarmBlock('claim-issue', 0)).toBe('');
    expect(resolveSwarmBlock('claim-issue', 1)).toBe('');
    expect(resolveSwarmBlock('claim-issue', undefined)).toBe('');
    expect(resolveSwarmBlock('claim-issue', 3.5)).toBe('');
  });

  it('returns a gh swarm directive for the github claim body', () => {
    const block = resolveSwarmBlock('claim-issue', 3);
    expect(block).toContain('SWARM MODE');
    expect(block).toContain('--swarm=3');
    expect(block).toContain('3 independent issues');
    expect(block).toContain('gh pr merge');
    // Ends with a separator so the single-issue body reads as the per-agent flow.
    expect(block.trimEnd().endsWith('---')).toBe(true);
  });

  it('instructs the orchestrator to still write the completion sentinel after a swarm run', () => {
    // Swarm work ships via PRs with no working-tree change, so without an
    // explicit instruction the orchestrator skips the completion sentinel and
    // the CoS task hangs as if it never finished. Phase C must point at the
    // sentinel — by reference, since the filename carries the agent id and the
    // exact path is handed over by the Completion Workflow section.
    const block = resolveSwarmBlock('claim-issue', 3);
    expect(block).toContain('completion sentinel');
    expect(block).toContain('Completion Workflow');
    // Naming a literal `.agent-done` here would send the orchestrator to a path
    // no poller watches.
    expect(block).not.toMatch(/\.agent-done/);
  });

  it('gives every fan-out agent its own scratch subdirectory', () => {
    // All fan-out agents share ONE session scratchpad and run byte-identical
    // instructions, so without an assigned per-agent directory two of them pick
    // the same obvious filename (pr-body.md) and clobber each other silently —
    // which once published one worker's PR body onto another worker's PR.
    const block = resolveSwarmBlock('claim-issue', 3);
    expect(block).toContain('<scratchpad>/issue-<num>/');
    expect(block).toMatch(/scratchpad root/i);
    // The scope is ALL temp files, not just the PR body that surfaced the bug.
    expect(block).toMatch(/ALL temp files/i);
    // CoS agents also run under codex/agy/grok/opencode, which inject no
    // scratchpad path. Without a named fallback such an agent picks its cwd —
    // the source repo the prompt otherwise forbids writing to.
    expect(block).toContain('$(mktemp -d)/issue-<num>');
  });

  it('instructs each agent to verify its own issue trailer after create and after each edit', () => {
    // Belt to the namespacing's braces: the PR-body flow is create-then-edit, so
    // a stale/foreign body can land minutes later during the review loop. `gh`
    // exits 0 either way, so only a read-back catches it.
    const block = resolveSwarmBlock('claim-issue', 3);
    expect(block).toContain('Closes #<num>');
    expect(block).toContain('Refs #<num>');
    expect(block).toMatch(/after each edit|after every edit/i);
  });

  it('reads the PR body back by branch, never by a number that could be the issue number', () => {
    // `<num>` is the ISSUE number everywhere else in this block, and an issue
    // number is not a PR number. Passing one to `gh pr view` reads the wrong
    // object (on GitLab, a real but unrelated MR) — so the agent "corrects" a
    // stranger's PR body, which is the very bug #3489 is about. Both CLIs infer
    // the PR/MR from the agent's own claim/issue-<num> branch, so no id is needed.
    const block = resolveSwarmBlock('claim-issue', 3);
    expect(block).toContain('gh pr view --json body -q .body');
    expect(block).not.toContain('gh pr view <num>');
    expect(block).not.toContain('gh pr view <pr-num>');
  });

  it('caps the rewrite-and-re-verify loop so one stuck agent cannot stall Phase C', () => {
    // Phase C waits on every agent, so an unbounded "rewrite from scratch file
    // and re-verify" blocks the whole batch's merges when the scratch file is
    // itself the wrong one and republishing can never satisfy the check.
    const block = resolveSwarmBlock('claim-issue', 3);
    expect(block).toMatch(/Cap this at 2 rewrites/i);
    expect(block).toMatch(/Never loop on it/i);
  });

  it('returns a glab/MR swarm directive for the gitlab claim body', () => {
    const block = resolveSwarmBlock('claim-issue-gitlab', 4);
    expect(block).toContain('--swarm=4');
    expect(block).toContain('glab mr merge');
    expect(block).toContain('open the MR');
    // The scratch/read-back guidance is forge-agnostic — the MR body read-back
    // uses the glab command, not the gh one.
    expect(block).toContain('<scratchpad>/issue-<num>/');
    // Same no-identifier rule as the gh path — and it matters MORE here: issue
    // iids and MR iids are separate sequences on GitLab, so an issue number
    // passed to `glab mr view` usually resolves to a real, unrelated MR.
    expect(block).toContain('glab mr view --output json | jq -r .description');
    expect(block).not.toContain('glab mr view <iid>');
    expect(block).not.toContain('gh pr view');
  });

  it('is a no-op for non-forge claim types (plan-task / jira have no swarm flow)', () => {
    expect(resolveSwarmBlock('plan-task', 6)).toBe('');
    expect(resolveSwarmBlock('claim-issue-jira', 6)).toBe('');
  });
});

// Source-level guard: the swarm block must be PREPENDED at both render sites
// (the scheduled dispatch and the manual buildClaimWorkTask), not gated behind
// an in-template placeholder — that's what keeps it an opt-in wrapper with no
// prompt-default version bump.
describe('swarm block wiring', () => {
  it('prepends resolveSwarmBlock(...) to the rendered prompt at both render sites', () => {
    const occurrences = LAYER_SRC.match(/resolveSwarmBlock\(promptTaskType, metadata\.swarmCount\)/g) || [];
    expect(occurrences.length).toBe(2);
    expect(GEN_SRC).toContain('`${swarmBlock}${template}`');
    expect(PRESTEP_SRC).toContain('`${swarmBlock}${promptTemplate}`');
  });
});

/**
 * The perpetual reconcile drains (branch- and issue-reconcile) re-issue themselves
 * after every completed run, so their brakes are all that stands between them and
 * a runaway. On 2026-08-12 the signature brake was missing in practice — the refill
 * rode the on-demand lane, which reset the convergence signature on every hop —
 * and ~40 branch-reconcile coordinators ran between 05:19 and 08:47 against the
 * same two branches. The consecutive-dispatch cap is NOT this gate's job any more
 * (#3848): it moved to applyPerpetualDrainCap so every perpetual drain gets it.
 */
describe('resolveReconcileDrainGate', () => {
  // Stand-in for the injected taskSchedule module.
  const fakeSchedule = ({ signature = null, dispatchCount = 0 } = {}) => ({
    getPerpetualDrainState: vi.fn(async () => ({ signature, dispatchCount })),
    parkPerpetual: vi.fn(async () => {}),
    recordPerpetualDispatch: vi.fn(async () => dispatchCount + 1)
  });
  const app = { id: 'app-1', name: 'App One' };
  const ctx = (over = {}) => ({
    signature: 'a:NEEDS_PR:none', actionableCount: 1,
    label: '🔀 branch-reconcile', unit: 'branch(es)', ...over
  });

  it('dispatches when the set advanced', async () => {
    const ts = fakeSchedule({ signature: 'a:NEEDS_PR:none|b:IN_REVIEW:5', dispatchCount: 2 });
    expect(await resolveReconcileDrainGate(ts, 'branch-reconcile', app, ctx())).toBe(true);
    expect(ts.parkPerpetual).not.toHaveBeenCalled();
    // One write carries all three facts (park cleared, signature recorded, dispatch spent).
    expect(ts.recordPerpetualDispatch).toHaveBeenCalledWith('branch-reconcile', 'app-1', 'a:NEEDS_PR:none');
  });

  it('parks no-progress on an unchanged set, clearing signature + counter in the park write', async () => {
    const ts = fakeSchedule({ signature: 'a:NEEDS_PR:none', dispatchCount: 1 });
    expect(await resolveReconcileDrainGate(ts, 'branch-reconcile', app, ctx())).toBe(false);
    expect(ts.parkPerpetual).toHaveBeenCalledWith('branch-reconcile', 'app-1', {
      reason: 'no-progress', actionableCount: 1, signature: null
    });
    expect(ts.recordPerpetualDispatch).not.toHaveBeenCalled();
  });

  // Exactly one implementation of the cap survives, and it is not this one — an
  // advanced set dispatches here no matter how much budget has been spent, because
  // applyPerpetualDrainCap already ran (and returned) at the choke point.
  it('no longer applies a dispatch cap of its own', async () => {
    const ts = fakeSchedule({ signature: 'stale-sig', dispatchCount: 99 });
    expect(await resolveReconcileDrainGate(ts, 'branch-reconcile', app, ctx({ actionableCount: 3 }))).toBe(true);
    expect(ts.parkPerpetual).not.toHaveBeenCalled();
  });
});

/**
 * The ONE consecutive-dispatch cap, at the choke point every spawn engine funnels
 * through. Per type so a bound that suits the reconcile scans (a handful of
 * branches a day) cannot throttle a healthy claim-issue drain to five issues a
 * window — the claim drains ship with no cap at all and stay unbounded (#3848).
 */
describe('applyPerpetualDrainCap', () => {
  const fakeSchedule = (dispatchCount = 0) => ({
    INTERVAL_TYPES: { ON_DEMAND: 'on-demand', CRON: 'cron' },
    getPerpetualDrainState: vi.fn(async () => ({ signature: null, dispatchCount })),
    parkPerpetual: vi.fn(async () => {})
  });
  const app = { id: 'app-1', name: 'App One' };
  // The drain signal is the orthogonal `perpetual` flag, not the cadence type.
  const perpetual = (over = {}) => ({ type: 'on-demand', perpetual: true, ...over });

  it('parks drain-cap once the budget is spent, clearing the signature in the park write', async () => {
    const ts = fakeSchedule(5);
    expect(await applyPerpetualDrainCap(app, 'branch-reconcile', perpetual({ drainDispatchCap: 5 }), ts)).toEqual({ skip: true });
    // The counter is zeroed by parkPerpetual's default — every park ends a window.
    expect(ts.parkPerpetual).toHaveBeenCalledWith('branch-reconcile', 'app-1', {
      reason: 'drain-cap', signature: null
    });
  });

  it('reads a hand-edited numeric string as the cap rather than silently unbounding the guard', async () => {
    const ts = fakeSchedule(5);
    expect(await applyPerpetualDrainCap(app, 'branch-reconcile', perpetual({ drainDispatchCap: '5' }), ts)).toEqual({ skip: true });
  });

  it('spends exactly CAP dispatches before capping', async () => {
    const outcomes = [];
    for (let dispatchCount = 0; dispatchCount <= 5; dispatchCount += 1) {
      outcomes.push((await applyPerpetualDrainCap(app, 'branch-reconcile', perpetual({ drainDispatchCap: 5 }), fakeSchedule(dispatchCount))).skip);
    }
    expect(outcomes).toEqual([false, false, false, false, false, true]);
  });

  // The whole reason the cap is per-type: an uncapped claim drain must keep going.
  it('never parks a perpetual type with no cap configured, however many hops it has taken', async () => {
    for (const drainDispatchCap of [undefined, null, '', 'nope', 0, -1]) {
      const ts = fakeSchedule(500);
      expect(await applyPerpetualDrainCap(app, 'claim-issue', perpetual({ drainDispatchCap }), ts)).toEqual({ skip: false });
      expect(ts.parkPerpetual).not.toHaveBeenCalled();
      // Unbounded types must not even pay for the state read.
      expect(ts.getPerpetualDrainState).not.toHaveBeenCalled();
    }
  });

  it('ignores non-perpetual intervals entirely', async () => {
    const ts = fakeSchedule(500);
    expect(await applyPerpetualDrainCap(app, 'security', { type: 'cron', cronExpression: '0 7 * * *', drainDispatchCap: 5 }, ts)).toEqual({ skip: false });
    expect(ts.getPerpetualDrainState).not.toHaveBeenCalled();
    // A reconcile task WITHOUT the flag is no longer special-cased by name.
    expect(await applyPerpetualDrainCap(app, 'branch-reconcile', { type: 'on-demand', drainDispatchCap: 5 }, ts)).toEqual({ skip: false });
  });

  it('applies the cap to a cron-scheduled perpetual drain, not just an on-demand one', async () => {
    const ts = fakeSchedule(5);
    const cronDrain = { type: 'cron', cronExpression: '0 7 * * *', perpetual: true, drainDispatchCap: 5 };
    expect(await applyPerpetualDrainCap(app, 'branch-reconcile', cronDrain, ts)).toEqual({ skip: true });
  });
});
