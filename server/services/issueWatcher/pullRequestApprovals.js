/** Recheck screened pull requests and advance fresh and previously queued approvals through CI, rebase, and merge. */
import { MODEL_ABUSE_GUARD_MAX_INPUT_CHARS, issuePrerequisiteWaived, linkedIssueIntentFingerprint } from '../../lib/modelAbuseGuard.js';
import { PR_HANDBACK } from '../../lib/prHandbackPolicy.js';
import { mergePR } from '../git/prs.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from '../notifications.js';
import { normalizeEligibilityFacts } from '../modelAbuseGuard.js';
import { screenedPullRequestFingerprintMatches } from '../../lib/prReviewContent.js';
import { classifyChecks } from '../../lib/pullRequestReadiness.js';
import { sameLogin, isOpenIssue, runGh, runJson, apiArgs, readPullRequest, readBehindBy, updatePullRequestBranch } from './forgeClient.js';
import { readState, persistState, approvalEntries, approvalStatePatch } from './state.js';
import { createHandbackTracker, handbackStatePatch, applyPullRequestHandback } from './handbackAndVolunteers.js';

export const MAX_DIFF_CHARS = MODEL_ABUSE_GUARD_MAX_INPUT_CHARS;

export const MAX_PENDING_APPROVAL_TICKS = 12;

// Two paths reach the same outcome — the review pass and the merge poller both
// find an approved PR with a red check — so the hand-back reads identically
// whichever one got there first.
const CI_FAILING_HANDBACK_REASON = 'the PR was approved but CI is failing';

// GitHub holds the workflow runs of a first-time fork contributor until a
// maintainer clicks "Approve and run", so an approved external PR otherwise
// sits at zero checks and never merges. CI is deliberately NOT started before
// that point: an unreviewed or rejected PR must not spend runner minutes or
// get a foothold on the runners. Only once the coordinator has posted its own
// APPROVE on content it screened and reviewed does it approve the held runs
// itself — and never when the PR edits a workflow file, since that run would
// execute the contributor's workflow changes; those stay for a human.
const WORKFLOW_PATH_RE = /^\.github\/workflows\//;

const touchesWorkflowFiles = (pr) => (Array.isArray(pr?.files) ? pr.files : [])
  .some((file) => WORKFLOW_PATH_RE.test(String(file?.path || '')));

async function approveHeldWorkflowRuns(ctx, pr) {
  if (touchesWorkflowFiles(pr)) return 0;
  const runs = await runJson(apiArgs(ctx, `repos/${ctx.repoFullName}/actions/runs?head_sha=${pr.headRefOid}&status=action_required&per_page=20`), ctx);
  const held = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  let approved = 0;
  for (const run of held) {
    if (!Number.isInteger(run?.id)) continue;
    const ok = await runGh(apiArgs(ctx, `repos/${ctx.repoFullName}/actions/runs/${run.id}/approve`, { method: 'POST' }), ctx)
      .then(() => true)
      .catch(() => false);
    if (ok) approved += 1;
  }
  if (approved > 0) console.log(`✅ issue-watcher: approved ${approved} held workflow run(s) for PR #${pr.number}`);
  return approved;
}

function sameNumberList(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  return a.length === b.length && a.every((number, index) => number === b[index]);
}

/**
 * Re-fetch the issue facts that admitted a public PR immediately before an
 * action. Issue state and assignees can change while Stage 2/3 is running; an
 * old allowlist must never remain sufficient for a later review or merge.
 */
export async function eligibilityFactsStillCurrent(ctx, pr, target) {
  const expected = normalizeEligibilityFacts(target?.eligibilityFacts);
  const authorLogin = typeof target?.authorLogin === 'string' ? target.authorLogin.trim() : '';
  if (!authorLogin || !sameLogin(pr?.author?.login, authorLogin)) return false;
  // A targeted request waives the prerequisite, never intent already assessed.
  const waived = issuePrerequisiteWaived(expected);
  if (waived && !expected.intentFingerprint) return true;
  if (!expected.issueLookupComplete) return false;
  if (expected.linkedIssueNumbers.length === 0) return false;

  const issues = await Promise.all(expected.linkedIssueNumbers.map((number) => (
    runJson(apiArgs(ctx, `repos/${ctx.repoFullName}/issues/${number}`), ctx)
  )));
  if (issues.some((issue, index) => issue?.number !== expected.linkedIssueNumbers[index])) return false;

  const openIssues = issues.filter((issue) => (
    !issue.pull_request && isOpenIssue(issue)
  ));
  const openLinkedIssueNumbers = openIssues.map((issue) => issue.number);
  const openerAssignedIssueNumbers = openIssues
    .filter((issue) => Array.isArray(issue.assignees) && issue.assignees.some((assignee) => (
      sameLogin(assignee?.login, authorLogin)
    )))
    .map((issue) => issue.number);
  const actual = normalizeEligibilityFacts({
    linkedIssueNumbers: expected.linkedIssueNumbers,
    openLinkedIssueNumbers,
    openerAssignedIssueNumbers,
    issueLookupComplete: true,
  });
  if (!waived && (!sameNumberList(expected.linkedIssueNumbers, actual.linkedIssueNumbers)
    || !sameNumberList(expected.openLinkedIssueNumbers, actual.openLinkedIssueNumbers)
    || !sameNumberList(expected.openerAssignedIssueNumbers, actual.openerAssignedIssueNumbers)
    || expected.issueLookupComplete !== actual.issueLookupComplete)) return false;

  // The gate judged the diff against the issue text as it read at scan time. A
  // requirement that was rewritten since is a different requirement, so the old
  // verdict no longer covers it. Facts recorded before intent was screened
  // carry no fingerprint and keep their previous meaning.
  if (!expected.intentFingerprint) return true;
  const currentIntent = linkedIssueIntentFingerprint(openIssues.map((issue) => ({
    number: issue.number, title: issue.title, body: issue.body,
  })));
  return currentIntent === expected.intentFingerprint;
}

async function keepPendingApproval(app, approval, remaining, reason, { patch = {}, ctx = null, pr = null, tracker = null } = {}) {
  const next = { ...approval, ...patch, ticks: (approval.ticks || 0) + 1 };
  if (next.ticks >= MAX_PENDING_APPROVAL_TICKS) {
    await notifyPendingApproval(app, approval, `PortOS stopped polling after ${MAX_PENDING_APPROVAL_TICKS} checks because ${reason}.`);
    // Polling gave up, so this is the last moment anything is watching the PR.
    // Hand it over rather than leave an approved-but-unlandable PR unowned.
    // `pr` is null only when the forge read itself failed, and there is nothing
    // to decide from in that case.
    await applyPullRequestHandback({
      app, ctx, pr, tracker,
      authorLogin: approval.authorLogin,
      reason: `PortOS stopped polling because ${reason}`,
      notMergeReady: true,
    });
  } else {
    remaining.push(next);
  }
}

export async function processPendingApprovals(app, ctx) {
  const approvals = approvalEntries(readState(app));
  const remaining = [];
  const drops = createDropLog();
  const handbacks = createHandbackTracker(app);
  for (let approval of approvals) {
    const pr = await readPullRequest(ctx, approval.number);
    if (!pr) {
      await keepPendingApproval(app, approval, remaining, 'it could not be read from GitHub', { tracker: handbacks });
      continue;
    }
    if (pr.state !== 'OPEN') continue;
    // Upgrade old queues before any further wait/action: GitHub auto-merge
    // would otherwise bypass the current content and security-model gates.
    if (approval.autoMergeEnabled) {
      const disabled = await runGh(['pr', 'merge', String(pr.number), '--repo', ctx.repoSpec, '--disable-auto'], ctx)
        .then(() => true, () => false);
      if (!disabled) {
        // An armed remote action must remain tracked even when the ordinary
        // polling budget expires. Notify once, then keep retrying revocation.
        if (!approval.autoMergeRevocationFailed) {
          await notifyPendingApproval(app, approval, 'GitHub auto-merge could not be disabled for security reassessment. Disable it on the PR; PortOS will keep trying.');
        }
        remaining.push({ ...approval, autoMergeRevocationFailed: true });
        continue;
      }
      approval = { ...approval, autoMergeEnabled: false };
    }
    if (pr.headRefOid !== approval.headSha) {
      drops.record(pr.number, 'a new head commit replaced the approved one');
      continue;
    }
    const approvedDiff = await runGh(['pr', 'diff', String(pr.number), '--repo', ctx.repoSpec], ctx).catch(() => null);
    if (
      typeof approvedDiff !== 'string'
      || approvedDiff.length > MAX_DIFF_CHARS
      || !screenedPullRequestFingerprintMatches(approval.contentFingerprint, pr, approvedDiff)
    ) {
      // A maintainer can edit the title/body or a contributor can replace the
      // head after the review. An old approval is never enough to merge the
      // new content, so discard the pending action and require a fresh run.
      drops.record(pr.number, 'its content no longer matches the approved revision');
      continue;
    }
    const assessment = await assessCurrentPullRequest(ctx, pr, approvedDiff);
    if (!assessment.ok) {
      await keepPendingApproval(app, approval, remaining, 'the current security-model assessment did not pass');
      continue;
    }
    if (approval.eligibilityFacts !== undefined
      && !await eligibilityFactsStillCurrent(ctx, pr, approval)) {
      await notifyPendingApproval(app, approval, 'The linked issue state or assignee changed, so the previous approval was discarded.');
      continue;
    }
    const outcome = await advanceApprovedPullRequest({
      app, ctx, pr, approval, handbacks, source: 'queued',
      recheck: () => assessment.stillCurrent(),
    });
    if (outcome.kind === 'hold') {
      await keepPendingApproval(app, outcome.approval, remaining, outcome.reason, { ctx, pr, tracker: handbacks });
    }
  }
  const handbackPatch = handbackStatePatch(handbacks);
  if (approvals.length) {
    const changes = new Map(approvals.map(({ number }) => [number, null]));
    for (const entry of remaining) changes.set(entry.number, entry);
    await persistState(app.id, (state) => ({
      ...approvalStatePatch(state, approvals, changes),
      ...(typeof handbackPatch === 'function' ? handbackPatch(state) : handbackPatch),
    }));
  }
}

export async function notifyPendingApproval(app, approval, description) {
  return addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    priority: PRIORITY_LEVELS.HIGH,
    title: `Issue Watcher PR #${approval.number} needs attention`,
    description,
    link: approval.url,
    metadata: { appId: app.id, issueWatcherPrNumber: approval.number },
  }).catch((err) => {
    console.error(`❌ issue-watcher: failed to notify about PR #${approval.number}: ${err.message}`);
    return null;
  });
}

/**
 * Where the two landing paths genuinely differ, carried as data so the ladder
 * in `advanceApprovedPullRequest` exists once. `fresh` is an APPROVE posted in
 * this pass, `queued` one polled from the persisted ledger. Unifying any row is
 * a policy change, not a refactor.
 *
 * - `releaseHeldRuns`: a fresh approval releases held fork CI right after its
 *   own APPROVE; a queued one only while its rollup is still empty.
 * - `dropStale`: a fresh approval that fails its pre-mutation recheck is
 *   abandoned (and rechecked again before it may enter the ledger at all); a
 *   queued one waits another tick, which re-verifies it from scratch.
 * - `ciHoldPatch`: fields a fresh approval settles when it is first queued.
 */
const APPROVAL_LANDING = {
  fresh: {
    releaseHeldRuns: 'after-approve',
    dropStale: true,
    ciHoldPatch: { autoMergeEnabled: false, rebaseRequired: false },
    ciFailedNotice: 'CI reported a failing status, so PortOS did not merge this approved PR.',
  },
  queued: {
    releaseHeldRuns: 'on-empty-rollup',
    dropStale: false,
    ciHoldPatch: {},
    ciFailedNotice: 'CI reported a failing status, so PortOS stopped automatic merge polling.',
  },
};

const DROPPED = Object.freeze({ kind: 'dropped' });

/**
 * Advance one approved PR through rebase → CI → merge, or park it.
 *
 * Every forge mutation on the untrusted PR (update-branch, merge) is preceded
 * by the caller's `recheck` — its current eligibility and security-assessment
 * guard — at exactly one call site each. Returns a disposition:
 * `merged` | `rebased` (a fresh review must follow) | `handed-back` (CI
 * failed; `handedBack` says whether anyone took it) | `dropped` | `hold`
 * (`approval` is the entry to keep polling, `reason` why it is waiting).
 */
export async function advanceApprovedPullRequest({ app, ctx, pr, approval, handbacks, recheck, source }) {
  const policy = APPROVAL_LANDING[source];
  // `held` parks the approval as-is; `hold` first re-guards it when a stale
  // approval must drop; `refused` answers a failed pre-mutation recheck.
  const held =(reason, patch = {}) => ({ kind: 'hold', reason, approval: { ...approval, ...patch } });
  const hold = async (reason, patch) => (policy.dropStale && !await recheck() ? DROPPED : held(reason, patch));
  const refused = (reason, patch) => (policy.dropStale ? DROPPED : held(reason, patch));

  if (policy.releaseHeldRuns === 'after-approve') await approveHeldWorkflowRuns(ctx, pr);
  if (approval.rebaseRequired) {
    const behindBy = await readBehindBy(ctx, pr);
    if (behindBy === null) return hold('its base relationship could not be read');
    if (behindBy > 0) {
      if (!await recheck()) return refused('its required rebase could not be applied');
      if (await updatePullRequestBranch(ctx, pr.number, pr.headRefOid)) return { kind: 'rebased' };
      return held('its required rebase could not be applied');
    }
  }

  const checkRollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const checks = classifyChecks(checkRollup);
  if (checks === 'failed') {
    await notifyPendingApproval(app, approval, policy.ciFailedNotice);
    // Dropped from the poll list, so this is the PR's last owner-less moment.
    const handback = await applyPullRequestHandback({
      app, ctx, pr, tracker: handbacks,
      authorLogin: approval.authorLogin,
      reason: CI_FAILING_HANDBACK_REASON,
      notMergeReady: true,
    });
    return { kind: 'handed-back', handedBack: handback !== PR_HANDBACK.NONE };
  }
  // A run GitHub is still holding for approval also shows up as no checks;
  // this PR already carries the coordinator's APPROVE, so release it.
  if (policy.releaseHeldRuns === 'on-empty-rollup' && checkRollup.length === 0) await approveHeldWorkflowRuns(ctx, pr);
  // An empty rollup is ambiguous immediately after review: CI may simply not
  // have attached yet. A low-risk PR may skip CI only after two consecutive
  // scheduled observations see no checks. Active checks are never waived.
  const maySkipEmptyChecks = approval.ciPolicy === 'skippable'
    && checkRollup.length === 0
    && approval.noChecksObserved === true;
  const ciHold = { ...policy.ciHoldPatch, noChecksObserved: approval.noChecksObserved === true || checkRollup.length === 0 };
  if ((checks === 'green' || maySkipEmptyChecks) && pr.mergeable === 'MERGEABLE') {
    if (!await recheck()) return refused('CI or mergeability did not settle', ciHold);
    const merged = await mergePR(app.repoPath, approval.number, { expectedHeadSha: approval.headSha, forgeAccount: app.forgeAccount || null }).catch(() => ({ success: false }));
    if (merged.success) return { kind: 'merged' };
  }
  // PortOS owns the wait so a later merge must pass fresh security checks.
  return hold('CI or mergeability did not settle', ciHold);
}

/**
 * Records a completed review decision that was thrown away, and why.
 *
 * Every guard in the action loop fails closed by skipping the PR, which is the
 * right posture and a terrible signal: the pipeline reported three green stages
 * over a PR it had not touched, and nothing anywhere named the reason. A
 * fingerprint builder that had drifted out of sync with the preflight's looked
 * exactly like "the contributor pushed mid-review" — from the outside, both are
 * silence (#7323). So a drop is logged AND carried in the hook's result, which
 * is what the pipeline hands back as the stage's own outcome.
 */
export function createDropLog() {
  const dropped = [];
  return {
    dropped,
    record(number, reason) {
      dropped.push({ number, reason });
      console.warn(`⚠️ issue-watcher: no action on PR #${number} — ${reason}`);
    },
  };
}

export async function assessCurrentPullRequest(ctx, pr, diff) {
  const { assessPullRequestForAction } = await import('../prReviewerSecurity.js');
  return assessPullRequestForAction({
    pr, diff, repoFullName: ctx.repoFullName,
    readPr: () => readPullRequest(ctx, pr.number),
    readDiff: () => runGh(['pr', 'diff', String(pr.number), '--repo', ctx.repoSpec], ctx).catch(() => null),
    readIssue: (number) => runJson(apiArgs(ctx, `repos/${ctx.repoFullName}/issues/${number}`), ctx),
  }).catch(() => ({ ok: false }));
}
