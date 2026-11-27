/** Validate issue-watcher decisions against their screened revisions, apply forge actions, and record their results. */
import { detectDeterministicModelAbuseSignals } from '../../lib/modelAbuseGuard.js';
import { renderFinding, renderReviewBody, reviewReportText } from '../../lib/prReviewReport.js';
import { PR_HANDBACK, PR_REVIEW_OUTCOME } from '../../lib/prHandbackPolicy.js';
import { getAppById } from '../apps.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from '../notifications.js';
import { screenedPullRequestFingerprintMatches } from '../../lib/prReviewContent.js';
import { trimTo } from '../../lib/textUtils.js';
import { MAX_DIFF_CHARS, eligibilityFactsStillCurrent, notifyPendingApproval, advanceApprovedPullRequest, createDropLog, assessCurrentPullRequest } from './pullRequestApprovals.js';
import { MAX_PENDING_ISSUE_COMMENTS, issueCommentKey, issueAbuseInput, abuseFingerprint, issueAnalysisSchema } from './issueComments.js';
import { readState, persistState, approvalEntries, approvalStatePatch } from './state.js';
import { runGh, resolveContext, readPullRequest, postIssueReply, readCurrentIssueComment, submitReview, postReviewFallback } from './forgeClient.js';
import { createHandbackTracker, handbackStatePatch, applyPullRequestHandback } from './handbackAndVolunteers.js';

export const MAX_PENDING_ISSUE_COMMENT_TICKS = 12;

/** Changed RIGHT-side lines that GitHub accepts as inline review anchors. */
export function parseAddedDiffLines(diff) {
  const anchors = new Set();
  let path = null;
  let newLine = 0;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      path = raw === '/dev/null' ? null : raw.replace(/^b\//, '');
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!path || line.startsWith('diff --git ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) {
      anchors.add(`${path}\u0000RIGHT\u0000${newLine}`);
      newLine += 1;
    } else if (!line.startsWith('-') && !line.startsWith('\\ No newline')) {
      newLine += 1;
    }
  }
  return anchors;
}

function normalizeFinding(finding, anchors) {
  if (!finding || typeof finding !== 'object') return null;
  const path = trimTo(finding.path, 500);
  const side = String(finding.side || '').toUpperCase();
  const line = Number(finding.line);
  const rendered = renderFinding(finding);
  if (!path || side !== 'RIGHT' || !Number.isInteger(line) || line < 1 || !rendered) return null;
  if (!anchors.has(`${path}\u0000${side}\u0000${line}`)) return null;
  return {
    comment: { path, side, line, body: rendered.body },
    label: rendered.label,
  };
}

function normalizeReviewDecision(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.number)) return null;
  const verdict = ['approve', 'request_changes', 'defer'].includes(value.verdict) ? value.verdict : null;
  const ciPolicy = ['required', 'skippable'].includes(value.ciPolicy) ? value.ciPolicy : null;
  if (!verdict || !ciPolicy || typeof value.rebaseRequired !== 'boolean') return null;
  return {
    number: value.number,
    headSha: trimTo(value.headSha, 80),
    verdict,
    ciPolicy,
    rebaseRequired: value.rebaseRequired,
    findings: Array.isArray(value.findings) ? value.findings : [],
  };
}

export function isTaskOutputPayload(payload) {
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)
    && Array.isArray(payload.issueComments) && Array.isArray(payload.pullRequests));
}

function hasUnsafeGeneratedOutput(payload) {
  const generatedText = [
    ...payload.issueComments.map((item) => item?.body),
    ...payload.pullRequests.flatMap((item) => reviewReportText(item)),
  ];
  return generatedText.some((value) => detectDeterministicModelAbuseSignals(value).length > 0);
}

/** The ledger entry a fresh APPROVE hands to `advanceApprovedPullRequest`. */
function approvalRecordFor(pr, target, decision) {
  return {
    number: pr.number,
    headSha: pr.headRefOid,
    contentFingerprint: target.contentFingerprint,
    authorLogin: target.authorLogin,
    eligibilityFacts: target.eligibilityFacts,
    url: pr.url,
    ciPolicy: decision.ciPolicy,
    rebaseRequired: decision.rebaseRequired,
    reviewedAt: new Date().toISOString(),
    ticks: 0,
  };
}

/**
 * Anchor the reviewer's findings to the diff and decide whether its verdict
 * can become a GitHub APPROVE.
 */
function reviewPlanFor(decision, diff, target) {
  const anchors = parseAddedDiffLines(diff);
  const normalizedFindings = decision.findings.map((finding) => normalizeFinding(finding, anchors)).filter(Boolean);
  const hasInvalidFinding = normalizedFindings.length !== decision.findings.length;
  const diffInsufficient = target.diffTruncated || diff.length > MAX_DIFF_CHARS;
  return {
    normalizedFindings,
    findings: normalizedFindings.map(({ comment }) => comment),
    hasInvalidFinding,
    // Every finding blocks, valid or not: a legacy blocking:false is a severity
    // hint, never permission to approve past a finding.
    canApprove: decision.verdict === 'approve'
      && !diffInsufficient
      && decision.findings.length === 0,
  };
}

/**
 * Post the review for a PR the coordinator will not approve, then hand the PR
 * to whoever can act on it. `{ reviewed, handedBack }` report what happened.
 */
async function postNonApprovingReview({ app, ctx, pr, raw, decision, review, target, handbacks, drops, recheck }) {
  const { normalizedFindings, findings, hasInvalidFinding } = review;
  if (!await recheck()) return { reviewed: false, handedBack: false };
  const downgraded = hasInvalidFinding && decision.verdict !== 'request_changes';
  const shouldRequestChanges = decision.verdict === 'request_changes' || decision.findings.length > 0;
  const summary = renderReviewBody({
    report: raw,
    verdict: shouldRequestChanges ? 'request_changes' : 'defer',
    findings: normalizedFindings,
    downgraded,
  });
  const posted = shouldRequestChanges
    ? await submitReview(ctx, pr.number, pr.headRefOid, { body: summary, event: 'REQUEST_CHANGES', comments: findings })
      || await submitReview(ctx, pr.number, pr.headRefOid, { body: summary, event: 'COMMENT', comments: findings })
    : await submitReview(ctx, pr.number, pr.headRefOid, { body: summary, event: 'COMMENT', comments: findings })
      || await postReviewFallback(ctx, pr.number, summary);
  if (!posted) {
    drops.record(pr.number, 'GitHub rejected the review comment');
    return { reviewed: false, handedBack: false };
  }
  // The review is posted and the PR is going nowhere on its own. Hand it to
  // whoever can act on it — a remediation agent when the head branch is
  // writable and the findings are concrete, the opener otherwise.
  const handback = await applyPullRequestHandback({
    app, ctx, pr, tracker: handbacks,
    authorLogin: target.authorLogin,
    reason: 'the review reported blocking findings',
    reviewOutcome: shouldRequestChanges ? PR_REVIEW_OUTCOME.REQUEST_CHANGES : PR_REVIEW_OUTCOME.DEFER,
    downgraded,
  });
  return { reviewed: true, handedBack: handback !== PR_HANDBACK.NONE };
}

/**
 * Re-verify one reviewed PR against the content the security scan screened,
 * with a single exit carrying the reason.
 *
 * These checks are what stand between a model's verdict and a real merge, and
 * they are the reason the loop can silently do nothing. Keeping them in one
 * place means the NEXT guard added here cannot forget to name itself — which is
 * exactly how the last one got lost.
 */
async function verifyScreenedPullRequest(ctx, raw, expectedPullRequests) {
  const decision = normalizeReviewDecision(raw);
  if (!decision) {
    return { number: raw?.number ?? '?', reason: 'the reviewer returned a decision this hook could not validate' };
  }
  const { number } = decision;
  const target = expectedPullRequests.get(number);
  if (!target || decision.headSha !== target.headSha) {
    return { number, reason: 'it is not the screened PR/commit this run was handed' };
  }
  const pr = await readPullRequest(ctx, number);
  if (!pr) return { number, reason: 'it could not be read from GitHub' };
  if (pr.state !== 'OPEN' || pr.headRefOid !== target.headSha) {
    return { number, reason: 'it closed or moved to a new head commit during the review' };
  }
  const diff = await runGh(['pr', 'diff', String(number), '--repo', ctx.repoSpec], ctx).catch(() => null);
  if (diff === null) return { number, reason: 'its diff could not be re-read for verification' };
  // A PR description can change without changing its head SHA. Require the
  // exact content screened before cognition, not merely the same revision,
  // before any review, rebase, or merge action.
  if (!screenedPullRequestFingerprintMatches(target.contentFingerprint, pr, diff)) {
    // `pr` rides along so the notification can still link to it.
    return { number, pr, reason: 'its content no longer matches what the security scan screened', notify: true };
  }
  const assessment = await assessCurrentPullRequest(ctx, pr, diff);
  if (!assessment.ok) {
    return { number, pr, reason: 'the current security-model assessment did not pass', notify: true };
  }
  return { ok: true, decision, target, pr, diff, assessment };
}

/** Strict issue coverage: a schema-valid decision for every handed comment, each exactly once. */
function coversExpectedIssueComments(payload, expectedIssueComments) {
  if (!issueAnalysisSchema.safeParse(payload).success) return false;
  const ids = new Set(expectedIssueComments.map(issueCommentKey));
  const seen = new Set();
  return payload.issueComments.length === ids.size && payload.issueComments.every((item) => {
    const key = issueCommentKey(item);
    if (!ids.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Strict pull request coverage: no issue comments, and exactly one decision per
 * handed PR at its screened head, each of which carries a screened fingerprint.
 */
function coversExpectedPullRequests(payload, expectedPullRequests) {
  const seen = new Set();
  return payload.issueComments.length === 0
    && payload.pullRequests.length === expectedPullRequests.size
    && payload.pullRequests.every((raw) => {
      const decision = normalizeReviewDecision(raw);
      if (!decision || seen.has(decision.number)) return false;
      seen.add(decision.number);
      const target = expectedPullRequests.get(decision.number);
      return Boolean(target && decision.headSha === target.headSha && target.contentFingerprint);
    });
}

/** Post the decided replies to comments whose content still matches what was screened. */
async function answerIssueComments(ctx, expectedComments, commentDecisions) {
  const handledCommentKeys = new Set();
  let replies = 0;
  for (const [key, item] of expectedComments) {
    const decision = commentDecisions.get(key);
    if (!decision || !['reply', 'none'].includes(decision.action)) continue;
    const current = await readCurrentIssueComment(ctx, item);
    if (!current || !item.contentFingerprint || abuseFingerprint(current, issueAbuseInput(current)) !== item.contentFingerprint) continue;
    if (decision.action === 'reply') {
      const posted = trimTo(decision.body, 5_000) && await postIssueReply(ctx, { ...current, body: decision.body });
      if (!posted) continue;
      replies += 1;
    }
    handledCommentKeys.add(key);
  }
  return { replies, handledCommentKeys };
}

/**
 * Verify, review and (when approved) land one PR decision, recording its approval disposition.
 */
async function reviewScreenedPullRequest({ app, ctx, raw, expectedPullRequests, drops, handbacks, approvalChanges, requireEligibilityFacts }) {
  const verified = await verifyScreenedPullRequest(ctx, raw, expectedPullRequests);
  if (!verified.ok) {
    drops.record(verified.number, verified.reason);
    if (verified.notify) {
      await notifyPendingApproval(app, { number: verified.number, url: verified.pr?.url || null },
        `The review finished, but ${verified.reason}, so PortOS took no action on it.`);
    }
    return { reviewed: false, handedBack: false, landing: null };
  }
  const { decision, target, pr, diff, assessment } = verified;
  const skipped = () => ({ reviewed: false, handedBack: false, landing: null });
  const eligibilityRequired = requireEligibilityFacts
    || Object.hasOwn(target, 'eligibilityFacts');
  const eligibilityStillCurrent = async () => {
    if (!await assessment.stillCurrent()) {
      drops.record(decision.number, 'the assessed contribution or CI changed before action');
      return false;
    }
    if (!eligibilityRequired) return true;
    const current = await eligibilityFactsStillCurrent(ctx, pr, target);
    if (!current) {
      approvalChanges.set(pr.number, null);
      drops.record(decision.number, 'the linked issue state or author assignment changed since the eligibility gate ran');
    }
    return current;
  };
  const review = reviewPlanFor(decision, diff, target);
  if (!review.canApprove) {
    const outcome = await postNonApprovingReview({
      app, ctx, pr, raw, decision, review, target, handbacks, drops, recheck: eligibilityStillCurrent,
    });
    return { reviewed: outcome.reviewed, handedBack: outcome.handedBack, landing: null };
  }
  if (!await eligibilityStillCurrent()) return skipped();
  // Every accepted finding is blocking, so an approvable review never carries inline comments.
  const approved = await submitReview(ctx, pr.number, pr.headRefOid, {
    body: renderReviewBody({ report: raw, verdict: 'approve' }),
    event: 'APPROVE',
  });
  if (!approved) {
    drops.record(decision.number, 'GitHub rejected the approving review, so no CI approval or merge could follow');
    return skipped();
  }
  const landing = await advanceApprovedPullRequest({
    app, ctx, pr, handbacks, source: 'fresh',
    approval: approvalRecordFor(pr, target, decision),
    recheck: eligibilityStillCurrent,
  });
  if (landing.kind === 'hold') approvalChanges.set(pr.number, landing.approval);
  if (landing.kind === 'merged' || landing.kind === 'handed-back') approvalChanges.set(pr.number, null);
  return { reviewed: true, handedBack: false, landing };
}

/** Age the still-unanswered handed comments; those past the retry budget time out. */
function agePendingIssueComments(latestState, handledCommentKeys, expectedComments) {
  const timedOutComments = [];
  const pendingIssueComments = (Array.isArray(latestState.pendingIssueComments) ? latestState.pendingIssueComments : [])
    .flatMap((item) => {
      const key = issueCommentKey(item);
      const expected = expectedComments.get(key);
      if (!expected || (expected.contentFingerprint
        && expected.contentFingerprint !== abuseFingerprint(item, issueAbuseInput(item)))) return [item];
      if (handledCommentKeys.has(key)) return [];
      const next = { ...item, ticks: (item.ticks || 0) + 1 };
      if (next.ticks < MAX_PENDING_ISSUE_COMMENT_TICKS) return [next];
      timedOutComments.push(next);
      return [];
    });
  return { pendingIssueComments, timedOutComments };
}

async function notifyTimedOutIssueComments(appId, timedOutComments) {
  if (timedOutComments.length === 0) return;
  await addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    priority: PRIORITY_LEVELS.HIGH,
    title: `${timedOutComments.length} Issue Watcher comment${timedOutComments.length === 1 ? '' : 's'} need attention`,
    description: `PortOS stopped retrying after ${MAX_PENDING_ISSUE_COMMENT_TICKS} incomplete reasoning or reply attempts.`,
    link: timedOutComments[0].commentUrl,
    metadata: { appId, issueWatcherCommentCount: timedOutComments.length },
  }).catch((err) => {
    console.error(`❌ issue-watcher: failed to notify about timed-out issue comments: ${err.message}`);
    return null;
  });
}

/** Validated reply/review/rebase/merge pass run after cognition. */
export async function processTaskOutput({ appId, success, payload, task, requireEligibilityFacts = false } = {}) {
  if (!appId || !success) return { action: 'no-op', reason: !success ? 'agent-failed' : 'missing-app' };
  if (!isTaskOutputPayload(payload)) return { action: 'no-op', reason: 'unparseable-response' };
  // A compromised reviewer must not be able to smuggle an instruction through
  // its own summary/comment text. Validate the complete generated envelope
  // before reading fresh forge state or performing any mutation; one unsafe
  // field invalidates the whole batch rather than allowing earlier decisions
  // to be posted before a later one is inspected.
  if (hasUnsafeGeneratedOutput(payload)) return { action: 'no-op', reason: 'unsafe-model-output' };
  const expected = task?.metadata?.issueWatcher;
  if (!expected || !Array.isArray(expected.issueComments) || !Array.isArray(expected.pullRequests)) {
    return { action: 'no-op', reason: 'missing-hook-metadata' };
  }
  if (expected.strictIssueCoverage === true && !coversExpectedIssueComments(payload, expected.issueComments)) {
    return { action: 'no-op', reason: 'incomplete-issue-response' };
  }
  const expectedPullRequests = new Map(expected.pullRequests.map((item) => [item.number, item]));
  if (expected.strictPullRequestCoverage === true && !coversExpectedPullRequests(payload, expectedPullRequests)) {
    return { action: 'no-op', reason: 'incomplete-pull-request-response' };
  }
  const app = await getAppById(appId);
  const ctx = app ? await resolveContext(app) : null;
  if (!app || !ctx || ctx.repoFullName !== expected.repoFullName) return { action: 'no-op', reason: 'repo-unavailable' };

  const expectedComments = new Map(expected.issueComments.map((item) => [issueCommentKey(item), item]));
  const commentDecisions = new Map(payload.issueComments.map((item) => [issueCommentKey(item), item]));
  const { replies, handledCommentKeys } = await answerIssueComments(ctx, expectedComments, commentDecisions);
  const commentsHandled = handledCommentKeys.size === expectedComments.size
    && commentDecisions.size === expectedComments.size;

  const approvalChanges = new Map();
  const drops = createDropLog();
  const handbacks = createHandbackTracker(app);
  // One disposition per approved PR; the result counts are tallied from them.
  const landings = [];
  let reviewed = 0;
  let handedBack = 0;
  for (const raw of payload.pullRequests) {
    const step = await reviewScreenedPullRequest({
      app, ctx, raw, expectedPullRequests, drops, handbacks, approvalChanges, requireEligibilityFacts,
    });
    if (step.reviewed) reviewed += 1;
    if (step.handedBack) handedBack += 1;
    if (step.landing) landings.push(step.landing);
  }

  let timedOutComments = [];
  const handbackPatch = handbackStatePatch(handbacks);
  await persistState(appId, (state) => {
    const aged = agePendingIssueComments(state, handledCommentKeys, expectedComments);
    timedOutComments = aged.timedOutComments;
    return {
      ...approvalStatePatch(state, approvalEntries(readState(app)), approvalChanges),
      pendingIssueComments: aged.pendingIssueComments,
      issueSnapshots: Object.fromEntries([
        ...Object.entries(state.issueSnapshots || {}),
        ...[...handledCommentKeys].filter((key) => key.endsWith(':0')).map((key) => {
          const item = expectedComments.get(key);
          return [String(item.issueNumber), item.contentFingerprint];
        }),
      ].slice(-MAX_PENDING_ISSUE_COMMENTS)),
      lastCheckedAt: new Date().toISOString(),
      lastError: commentsHandled ? null : 'issue-response-incomplete',
      ...(typeof handbackPatch === 'function' ? handbackPatch(state) : handbackPatch),
    };
  });
  await notifyTimedOutIssueComments(appId, timedOutComments);
  const landed = (kind) => landings.filter((outcome) => outcome.kind === kind).length;
  return {
    action: 'processed',
    replies,
    reviewed,
    rebased: landed('rebased'),
    merged: landed('merged'),
    handedBack: handedBack + landings.filter((outcome) => outcome.handedBack).length,
    commentsHandled,
    dropped: drops.dropped,
  };
}
