import { describe, expect, it, vi } from 'vitest';

const issueWatcherMock = vi.hoisted(() => ({
  isTaskOutputPayload: vi.fn((payload) => Boolean(payload?.issueComments || payload?.pullRequests)),
  processTaskOutput: vi.fn(),
}));

vi.mock('./issueWatcher.js', () => issueWatcherMock);

import {
  ensurePrReviewerPipeline,
  isEligibilityPayload,
  isTaskOutputPayload,
  processTaskOutput,
} from './prReviewerPipeline.js';

const HEAD_SHA = 'a'.repeat(40);
const CONTENT_FINGERPRINT = 'b'.repeat(64);

const INTENT_FINGERPRINT = 'c'.repeat(64);

const eligibleFacts = {
  linkedIssueNumbers: [101],
  openLinkedIssueNumbers: [101],
  openerAssignedIssueNumbers: [101],
  issueLookupComplete: true,
  intentFingerprint: INTENT_FINGERPRINT,
};

function eligibilityTask(overrides = {}) {
  return {
    metadata: {
      issueWatcher: {
        strictPullRequestCoverage: true,
        pullRequests: [{
        number: 12,
          headSha: HEAD_SHA,
          contentFingerprint: CONTENT_FINGERPRINT,
          authorLogin: 'contributor',
          eligibilityFacts: eligibleFacts,
        }],
      },
      pipeline: {
        currentStage: 1,
        stages: [
          { role: 'security', promptKey: 'pr-reviewer-security' },
          { role: 'eligibility', promptKey: 'pr-reviewer-eligibility' },
        ],
      },
      ...overrides,
    },
  };
}

const decisionPayload = (overrides = {}) => ({
  eligible: true,
  decisions: [{
    number: 12,
    headSha: HEAD_SHA,
    eligible: true,
    reason: 'Linked issue and focused implementation.',
  }],
  ...overrides,
});

describe('ensurePrReviewerPipeline', () => {
  it('inserts the mandatory eligibility gate and preserves the former review pins as actions', () => {
    const metadata = {
      pipeline: {
        stages: [
          { promptKey: 'pr-reviewer-security', readOnly: true },
          { promptKey: 'pr-reviewer-review', providerId: 'codex-cli', model: 'gpt-5.6', effort: 'high' },
        ],
      },
    };

    ensurePrReviewerPipeline(metadata);

    expect(metadata.pipeline.stages).toEqual([
      expect.objectContaining({ role: 'security', promptKey: 'pr-reviewer-security', readOnly: true }),
      expect.objectContaining({ role: 'eligibility', promptKey: 'pr-reviewer-eligibility', readOnly: true }),
      expect.objectContaining({
        role: 'actions',
        promptKey: 'pr-reviewer-review',
        providerId: 'codex-cli',
        model: 'gpt-5.6',
        effort: 'high',
        executionProfile: 'public-review-actions',
      }),
    ]);
  });

  it('keeps a gate-only pipeline gate-only', () => {
    const metadata = {
      pipeline: {
        stages: [
          { role: 'security', promptKey: 'pr-reviewer-security' },
          { role: 'eligibility', promptKey: 'pr-reviewer-eligibility' },
        ],
      },
    };

    ensurePrReviewerPipeline(metadata);
    expect(metadata.pipeline.stages).toHaveLength(2);
    expect(metadata.pipeline.stages[1].role).toBe('eligibility');
  });
});

describe('pr-reviewer eligibility output', () => {
  // A "Review this PR" click waives the linked-open-issue prerequisite (the
  // maintainer is spending the review deliberately), but ONLY via the fact the
  // preflight stamps — the model cannot grant it, and it still must judge the
  // change itself.
  it('honors the maintainer-targeted waiver from the server facts, never from the model', async () => {
    const targetedFacts = {
      linkedIssueNumbers: [],
      openLinkedIssueNumbers: [],
      openerAssignedIssueNumbers: [],
      issueLookupComplete: true,
      maintainerTargeted: true,
    };
    const task = eligibilityTask();
    task.metadata.issueWatcher.pullRequests[0].eligibilityFacts = targetedFacts;

    const accepted = await processTaskOutput({ appId: 'app-example', success: true, payload: decisionPayload(), task });
    expect(accepted).toMatchObject({ action: 'eligibility-evaluated', accepted: true, terminal: false });
    expect(accepted.taskMetadata.prReviewerEligibility.eligibleNumbers).toEqual([12]);

    // The model's own "not eligible" still wins for a targeted PR.
    const rejected = await processTaskOutput({
      appId: 'app-example',
      success: true,
      payload: decisionPayload({ eligible: false, decisions: [{ number: 12, headSha: HEAD_SHA, eligible: false, reason: 'placeholder change' }] }),
      task,
    });
    expect(rejected.taskMetadata.prReviewerEligibility.eligibleNumbers).toEqual([]);

    // Without the stamp, the same fact set (no linked issue) is still ineligible
    // whatever the model says.
    const sweep = eligibilityTask();
    sweep.metadata.issueWatcher.pullRequests[0].eligibilityFacts = { ...targetedFacts, maintainerTargeted: false };
    const swept = await processTaskOutput({ appId: 'app-example', success: true, payload: decisionPayload(), task: sweep });
    expect(swept.taskMetadata.prReviewerEligibility.eligibleNumbers).toEqual([]);
  });

  it('returns only the eligible allowlist and carries the server facts into validation', async () => {
    const result = await processTaskOutput({
      appId: 'app-example',
      success: true,
      payload: decisionPayload(),
      task: eligibilityTask(),
    });

    expect(result).toMatchObject({ action: 'eligibility-evaluated', accepted: true, terminal: false });
    expect(result.taskMetadata.issueWatcher.pullRequests).toEqual([{
      number: 12,
      headSha: HEAD_SHA,
      contentFingerprint: CONTENT_FINGERPRINT,
      authorLogin: 'contributor',
      // Facts are re-normalized on the read path, so the waiver flag is explicit.
      eligibilityFacts: { ...eligibleFacts, maintainerTargeted: false },
      diffTruncated: false,
    }]);
    expect(result.taskMetadata.prReviewerEligibility).toMatchObject({
      complete: true,
      eligibleNumbers: [12],
      rejectedNumbers: [],
    });
    expect(result.taskMetadata.prReviewerEligibility.decisions[0]).toEqual({
      number: 12,
      headSha: HEAD_SHA,
      eligible: true,
    });
    expect(result.taskMetadata.prReviewerEligibility.decisions[0]).not.toHaveProperty('reason');
  });

  it('forces a model-positive decision false when programmatic issue facts do not qualify', async () => {
        const task = eligibilityTask();
    task.metadata.issueWatcher.pullRequests[0].eligibilityFacts = {
      ...eligibleFacts,
      openerAssignedIssueNumbers: [],
    };

    const result = await processTaskOutput({
      appId: 'app-example',
      success: true,
      payload: decisionPayload(),
      task,
    });

    expect(result).toMatchObject({ accepted: true, terminal: true });
    expect(result.taskMetadata.prReviewerEligibility.eligibleNumbers).toEqual([]);
    expect(result.taskMetadata.prReviewerEligibility.rejectedNumbers).toEqual([12]);
  });

  // The gate's whole intent judgment rests on the screened issue text. No
  // fingerprint means none reached it, so an `eligible` answer was a guess.
  it('forces a model-positive decision false when no screened issue intent reached the gate', async () => {
    const task = eligibilityTask();
    task.metadata.issueWatcher.pullRequests[0].eligibilityFacts = {
      ...eligibleFacts,
      intentFingerprint: null,
    };

    const result = await processTaskOutput({
      appId: 'app-example',
      success: true,
      payload: decisionPayload(),
      task,
    });

    expect(result).toMatchObject({ accepted: true, terminal: true });
    expect(result.taskMetadata.prReviewerEligibility.eligibleNumbers).toEqual([]);
    expect(result.taskMetadata.prReviewerEligibility.rejectedNumbers).toEqual([12]);
  });

  it('does not trust open or assigned issue IDs that are not linked to the PR', async () => {
    const task = eligibilityTask();
    task.metadata.issueWatcher.pullRequests[0].eligibilityFacts = {
      ...eligibleFacts,
      linkedIssueNumbers: [],
    };

    const result = await processTaskOutput({
      appId: 'app-example',
      success: true,
      payload: decisionPayload(),
      task,
    });

    expect(result).toMatchObject({ accepted: true, terminal: true });
    expect(result.taskMetadata.prReviewerEligibility.eligibleNumbers).toEqual([]);
    expect(result.taskMetadata.prReviewerEligibility.rejectedNumbers).toEqual([12]);
  });

  it('fails closed when the model omits an expected decision', async () => {
    const task = eligibilityTask();
    task.metadata.issueWatcher.pullRequests.push({
      number: 13,
      headSha: 'c'.repeat(40),
      contentFingerprint: 'd'.repeat(64),
      authorLogin: 'another-contributor',
      eligibilityFacts: eligibleFacts,
    });

    const result = await processTaskOutput({
      appId: 'app-example',
      success: true,
      payload: decisionPayload(),
      task,
    });

    expect(result).toMatchObject({ accepted: false, reason: 'eligibility-response-incomplete' });
  });
});

describe('pr-reviewer output routing', () => {
  it('routes the final actions stage to the deterministic issue-watcher coordinator', async () => {
    issueWatcherMock.processTaskOutput.mockResolvedValueOnce({ action: 'reviewed', accepted: true });
    const task = {
      metadata: {
        pipeline: {
          currentStage: 2,
          stages: [
            { role: 'security' },
            { role: 'eligibility' },
            { role: 'actions' },
          ],
        },
      },
    };
    const args = { appId: 'app-example', success: true, payload: { pullRequests: [] }, task };

    await expect(processTaskOutput(args, { execGh: vi.fn() }))
      .resolves.toEqual({ action: 'reviewed', accepted: true });
    expect(issueWatcherMock.processTaskOutput).toHaveBeenCalledWith({
      ...args,
      requireEligibilityFacts: true,
    }, { execGh: expect.any(Function) });
  });

  it('fails a stage PERMANENTLY when its agent wrote no parseable output', async () => {
    // #6124: an empty run used to be retried through a fresh task id, so the
    // stage re-spawned ~20 times in five minutes while the churn park only logged.
    await expect(processTaskOutput({ appId: 'app-example', success: false, payload: null, task: eligibilityTask() }))
      .resolves.toEqual({
        action: 'no-op',
        accepted: false,
        permanent: true,
        reason: 'stage-produced-no-output',
        message: 'The pr-reviewer eligibility stage agent finished without writing any parseable output',
      });
  });

  it('fails an exit-zero actions stage permanently too, without consulting issue-watcher', async () => {
    const task = {
      metadata: {
        pipeline: {
          currentStage: 2,
          stages: [{ role: 'security' }, { role: 'eligibility' }, { role: 'actions' }],
        },
      },
    };

    issueWatcherMock.processTaskOutput.mockClear();
    const outcome = await processTaskOutput({ appId: 'app-example', success: true, payload: null, task }, { execGh: vi.fn() });

    expect(outcome).toMatchObject({ accepted: false, permanent: true, reason: 'stage-produced-no-output' });
    expect(issueWatcherMock.processTaskOutput).not.toHaveBeenCalled();
  });

  it('keeps a RETRYABLE rejection for a payload that arrived but failed validation', async () => {
    // Only "no payload at all" is permanent — a malformed envelope may parse on
    // a re-run, so it must not block the task on its first failure.
    const outcome = await processTaskOutput({
      appId: 'app-example', success: true, payload: { eligible: true, decisions: 'nope' }, task: eligibilityTask(),
    });

    expect(outcome.accepted).toBe(false);
    expect(outcome.permanent).toBeUndefined();
  });

  it('recognizes both the binary gate envelope and the action envelope', () => {
    expect(isEligibilityPayload(decisionPayload())).toBe(true);
    expect(isTaskOutputPayload(decisionPayload())).toBe(true);
    expect(isTaskOutputPayload({ issueComments: [], pullRequests: [] })).toBe(true);
    expect(isEligibilityPayload({ decisions: [] })).toBe(false);
  });
});
