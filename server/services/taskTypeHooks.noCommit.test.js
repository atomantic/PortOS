/**
 * `declaresNoCommitCriterion` — which tasks are exempt from the
 * commit success check.
 *
 * The exemption drives provider/model learning buckets: a wrongly-included task
 * scores every SUCCESSFUL run as a validation miss (#2696/#3273), and a wrongly
 * EXCLUDED one records a run that committed nothing as a pass.
 */

import { describe, it, expect } from 'vitest';
import { declaresNoCommitCriterion } from './taskTypeHooks.js';

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
    it('does not exempt the flag alone, with no tracker-filing marker', () => {
      expect(declaresNoCommitCriterion(task({
        analysisType: 'security',
        worktreeChangesExpected: false,
      }))).toBe(false);
    });
  });
});
