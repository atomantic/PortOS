/**
 * `declaresNoCommitCriterion` — which tasks are exempt from the
 * commit success check.
 *
 * The exemption drives provider/model learning buckets: a wrongly-included task
 * scores every SUCCESSFUL run as a validation miss (#2696/#3273), and a wrongly
 * EXCLUDED one records a run that committed nothing as a pass.
 */

import { describe, it, expect } from 'vitest';
import { declaresNoCommitCriterion, isClaimFlowDispatch } from './taskTypeHooks.js';

const task = (metadata) => ({ id: 'task-1', metadata });

describe('declaresNoCommitCriterion', () => {
  it('holds an ordinary task to the commit check', () => {
    expect(declaresNoCommitCriterion(task({}))).toBe(false);
    expect(declaresNoCommitCriterion(task({ analysisType: 'security' }))).toBe(false);
  });

  it('exempts a discarded worktree, which cannot leave a commit by construction', () => {
    expect(declaresNoCommitCriterion(task({ discardWorktree: true }))).toBe(true);
    // Metadata round-trips through TASKS.md as text.
    expect(declaresNoCommitCriterion(task({ discardWorktree: 'true' }))).toBe(true);
  });

  it('exempts a no-code-output task, whose deliverable is an action not a commit (#4146)', () => {
    expect(declaresNoCommitCriterion(task({ noCodeOutput: true }))).toBe(true);
    expect(declaresNoCommitCriterion(task({ noCodeOutput: 'true' }))).toBe(true);
    // Creative Director tasks are the shipped instance: they run against the live
    // checkout (useWorktree:false) so workspacePath IS set, and their deliverable
    // is `PATCH /api/creative-director/:id/plan|treatment`. Commit-checking them
    // scored every successful run as a miss. Resolved the same way
    // agentPromptBuilder resolves noCodeOutput, so prompt and criterion agree.
    expect(declaresNoCommitCriterion(task({
      creativeDirector: { projectId: 'cd-1', kind: 'plan', runId: 'r1' },
    }))).toBe(true);
  });

  describe('tracker-filing runs', () => {
    it('exempts a SCHEDULED type whose dispatch derived a clean tree', () => {
      expect(declaresNoCommitCriterion(task({
        analysisType: 'reference-watch',
        worktreeChangesExpected: false,
      }))).toBe(true);
    });

    it('exempts a ONE-OFF run marked only by its resolved tracker', () => {
      // repoIntake.js's `repo-study` — no `analysisType`, because that would
      // enroll it in taskSchedule's per-type failure ledger and auto-park a
      // "type" no schedule owns.
      expect(declaresNoCommitCriterion(task({
        workTracker: 'github',
        worktreeChangesExpected: false,
      }))).toBe(true);
      expect(declaresNoCommitCriterion(task({
        workTracker: 'jira',
        worktreeChangesExpected: 'false',
      }))).toBe(true);
    });

    it('still holds a PLAN.md-tracker run to the check — it commits its items', () => {
      expect(declaresNoCommitCriterion(task({
        workTracker: 'plan',
        worktreeChangesExpected: true,
      }))).toBe(false);
    });

    it('does not exempt on `auto`, which is not a resolved tracker', () => {
      expect(declaresNoCommitCriterion(task({
        workTracker: 'auto',
        worktreeChangesExpected: false,
      }))).toBe(false);
    });

    // `worktreeChangesExpected` is a user-settable per-app taskMetadata override
    // accepted for EVERY task type; setting it there is asking to skip the TUI
    // clean-tree gate, not to disable success validation.
    it('exempts an audit type that opted into file-issues', () => {
      expect(declaresNoCommitCriterion(task({
        analysisType: 'security',
        fileIssues: true,
        worktreeChangesExpected: false,
      }))).toBe(true);
    });

    it('does not treat an audit type as tracker-filing when fileIssues is off', () => {
      // ux is in TRACKER_FILING_TASK_TYPES for back-compat; an explicit
      // fileIssues:false means this run is implementing, so the commit check stays.
      expect(declaresNoCommitCriterion(task({
        analysisType: 'ux',
        fileIssues: false,
        worktreeChangesExpected: false,
      }))).toBe(false);
    });

    it('does not exempt the flag alone, with no tracker-filing marker', () => {
      expect(declaresNoCommitCriterion(task({
        analysisType: 'security',
        worktreeChangesExpected: false,
      }))).toBe(false);
    });
  });
});

/**
 * `isClaimFlowDispatch` — the claim-flow predicate. Deliberately NOT folded into
 * `declaresNoCommitCriterion`: that predicate also gates the goal-fidelity gate's
 * no-diff bail, which claim flows must not take (their claim-worktree diff is what
 * the fidelity review reads). Its only consumers are the success-criteria commit
 * probe and the history-backfill fossil sanitizer.
 */
describe('isClaimFlowDispatch', () => {
  it('recognizes every claim-flow type on analysisType', () => {
    for (const analysisType of ['plan-task', 'claim-issue', 'claim-issue-gitlab', 'claim-issue-jira', 'claim-work']) {
      expect(isClaimFlowDispatch(task({ analysisType }))).toBe(true);
    }
  });

  it('recognizes the explicit claimFlow marker, boolean and string form', () => {
    expect(isClaimFlowDispatch(task({ claimFlow: true }))).toBe(true);
    expect(isClaimFlowDispatch(task({ claimFlow: 'true' }))).toBe(true);
  });

  it('resolves the archived-agent projection (taskAnalysisType) and a bare taskType', () => {
    expect(isClaimFlowDispatch(task({ taskAnalysisType: 'claim-issue' }))).toBe(true);
    expect(isClaimFlowDispatch({ id: 'task-1', taskType: 'claim-work' })).toBe(true);
  });

  it('does not treat an ordinary committing task as a claim flow', () => {
    expect(isClaimFlowDispatch(task({}))).toBe(false);
    expect(isClaimFlowDispatch(task({ analysisType: 'security' }))).toBe(false);
    expect(isClaimFlowDispatch(task({ claimFlow: 'false' }))).toBe(false);
    expect(isClaimFlowDispatch(task({ analysisType: 'branch-reconcile' }))).toBe(false);
  });

  it('is NOT a declaresNoCommitCriterion shape — the goal-fidelity gate depends on the distinction', () => {
    // If claim flows ever satisfy declaresNoCommitCriterion, the goal-fidelity
    // gate's no-diff bail (agentFinalization.js) fires before its claimFlow
    // branch and the claimed-issue review silently stops running.
    expect(declaresNoCommitCriterion(task({ analysisType: 'claim-issue' }))).toBe(false);
    expect(declaresNoCommitCriterion(task({ claimFlow: true }))).toBe(false);
  });
});
