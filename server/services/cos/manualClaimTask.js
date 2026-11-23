import { ServerError } from '../../lib/errorHandler.js';
import { titleMarksEpic } from '../../lib/dispatchLabels.js';
import { workTrackerLabel } from '../../lib/workTracker.js';
import { prepareAppIssueClaim } from '../appIssues.js';
import { buildClaimWorkTask } from './cosTaskClaimWork.js';

/** The targeted or next-item claim used by both Issues and the GitHub inbox. */
export async function buildManualClaimTask(appObj, workflow, claimOptions, { expectedGithubIssue } = {}) {
  const { useWorktree, openPR, worktreeChangesExpected } = workflow.settings;
  const { target, issueContext } = claimOptions;
  // A manual forge claim is verified by prepareAppIssueClaim below before the
  // task is queued, so the prompt can skip repeating that work. A non-epic
  // title is assumed optimistically; a label-only epic rebuilds the full prompt.
  const forgeTarget = /^#?\d+$/.test(String(target ?? '').trim());
  let claim = await buildClaimWorkTask(appObj, {
    ...claimOptions,
    ...(forgeTarget ? { preverified: true, nonEpic: !titleMarksEpic(issueContext?.title) } : {})
  });
  const checkExpectedTarget = candidate => {
    if (expectedGithubIssue && (candidate.tracker !== 'github' || candidate.target !== target)) {
      throw new ServerError('This app is not configured to claim this GitHub issue', { status: 409, code: 'CLAIM_TRACKER_MISMATCH' });
    }
  };
  checkExpectedTarget(claim);
  if (claim.target && ['github', 'gitlab'].includes(claim.tracker)) {
    const preflight = await prepareAppIssueClaim(appObj, claim.target, claim.tracker, { includePreflight: true, ...(expectedGithubIssue ? { expectedGithubIssue } : {}) });
    const epic = preflight?.epic === true;
    const needsRebuild = Boolean(
      (epic && !titleMarksEpic(issueContext?.title))
      || preflight?.commentsClear
      || preflight?.linkedWorkClear
      || preflight?.forgeContext
      || preflight?.linkedItems?.length
      || (!issueContext && preflight?.issueContext)
    );
    if (needsRebuild) {
      claim = await buildClaimWorkTask(appObj, {
        ...claimOptions,
        issueContext: issueContext || preflight?.issueContext,
        preverified: true,
        nonEpic: !epic,
        // Inbox work can wait in the queue. Keep the existing live comment
        // screen available if someone posts after the operator presses Claim.
        commentsClear: !expectedGithubIssue && preflight?.commentsClear === true,
        linkedWorkClear: preflight?.linkedWorkClear === true,
        forgeContext: preflight?.forgeContext || null,
        linkedItems: preflight?.linkedItems || null,
      });
      checkExpectedTarget(claim);
    }
  }
  const scope = claim.target
    ? `claim ${workTrackerLabel(claim.tracker)} item ${claim.target}`
    : `claim next ${workTrackerLabel(claim.tracker)} item`;
  return {
    description: `${workflow.label} for ${appObj.name} — ${scope} and ship it`,
    // The claim body is the agent's PROMPT, not a human note (#4153) — see
    // server/lib/cos/cosTaskPrompt.js for the field split.
    prompt: claim.prompt,
    // claim.taskMetadata overrides the catalog posture only where it carries a
    // key. All current claim flows (plan-task / claim-issue / claim-issue-gitlab
    // / claim-issue-jira) self-manage their worktree + MR/PR, so false/false
    // remains the CoS provisioning posture. `claimFlow` is a separate
    // lifecycle marker so the prompt builder cannot mistake false/false for a
    // commit-only handoff. The spread stays for a future delegated type that
    // needs CoS-managed isolation. `worktreeChangesExpected` is one such key: the
    // claim flow derives it from the app's RESOLVED work tracker (a file
    // tracker commits its checklist, a forge tracker doesn't), which is more
    // specific than the catalog's commit-shaped default, so the spread wins.
    taskMetadata: {
      useWorktree,
      openPR,
      worktreeChangesExpected,
      ...(claim.target ? { claimTarget: claim.target } : {}),
      ...claim.taskMetadata,
      claimFlow: true
    },
  };
}
