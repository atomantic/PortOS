/**
 * Read-only model-abuse preflight for the pr-reviewer pipeline.
 *
 * The preflight reads public PR metadata and diffs through `gh`, then sends the
 * complete title/description/diff of each external PR to the dedicated local
 * model-abuse boundary. It never checks out or executes a contributor branch.
 * Only generic, validated safety metadata crosses into the ordinary code-review
 * stage; flagged content and classifier output do not.
 */

import { createHash } from 'node:crypto';
import { execGh, ensureForgeReachable } from './github.js';
import { getSelfLogin } from './prWatcher.js';
import { createGithubActorTrust } from './forgeActorTrust.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { githubApiHost, githubRepoSpec } from '../lib/workTracker.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import {
  MODEL_ABUSE_GUARD,
  MODEL_ABUSE_GUARD_MAX_INPUT_CHARS,
  LINKED_ISSUE_MAX_COUNT,
  linkedIssueIntentContent,
  linkedIssueIntentFingerprint,
  modelAbuseContentFingerprint,
  normalizeLinkedIssues,
} from '../lib/modelAbuseGuard.js';
import { screenUntrustedContent } from './untrustedContent.js';
import { safeJSONParse } from '../lib/fileUtils.js';

export const SECURITY_SCAN_MAX_OPEN_PRS = 200;
export const SECURITY_SCAN_MAX_DIFF_CHARS = MODEL_ABUSE_GUARD_MAX_INPUT_CHARS;
export const SECURITY_SCAN_MAX_REPORT_CHARS = 100_000;
const MAX_LINKED_ISSUES = 50;

const failure = (code, extra = {}) => ({ ok: false, passed: false, code, ...extra });
const isHeadRefOid = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const safeText = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const ELIGIBILITY_LOOKUP_CONCURRENCY = 4;

function issueNumbersFromText(value, repoFullName) {
  if (typeof value !== 'string' || !repoFullName) return [];
  const repo = String(repoFullName).toLowerCase();
  const numbers = new Set();
  // GitHub's closing/reference syntax is the useful signal here. Limit
  // repository-qualified references to this repository so a contributor's
  // unrelated cross-repo issue cannot become an eligibility fact.
  const referencePattern = /(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|relate[sd]?\s+to|ref(?:s)?|part\s+of)\s+)?(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*)?#(\d+)/gi;
  let match;
  while ((match = referencePattern.exec(value)) && numbers.size < MAX_LINKED_ISSUES) {
    const qualified = match[0].match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*#\d+$/i)?.[1];
    if (qualified && qualified.toLowerCase() !== repo) continue;
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b);
}

export function extractLinkedIssueNumbers(pr, repoFullName) {
  return [...new Set([
    ...issueNumbersFromText(pr?.title, repoFullName),
    ...issueNumbersFromText(pr?.body, repoFullName),
  ])].sort((a, b) => a - b).slice(0, MAX_LINKED_ISSUES);
}

/**
 * Resolve the issue facts that admit a PR, plus the intent evidence a reviewer
 * needs to answer "does this diff do what the issue asked?". Only OPEN linked
 * issues contribute intent — a closed issue is not a live requirement, and the
 * pre-action recheck recomputes the fingerprint from the same open set.
 */
async function resolveEligibilityFacts(pr, repoFullName, hostname) {
  const linkedIssueNumbers = extractLinkedIssueNumbers(pr, repoFullName);
  if (linkedIssueNumbers.length === 0) {
    return {
      facts: {
        linkedIssueNumbers: [],
        openLinkedIssueNumbers: [],
        openerAssignedIssueNumbers: [],
        issueLookupComplete: true,
        intentFingerprint: null,
      },
      linkedIssues: [],
      inputComplete: true,
    };
  }
  const openLinkedIssueNumbers = [];
  const openerAssignedIssueNumbers = [];
  const openIssues = [];
  let issueLookupComplete = true;
  for (const issueNumber of linkedIssueNumbers) {
    const raw = await execGh([
      'api', '--hostname', hostname, `repos/${repoFullName}/issues/${issueNumber}`,
    ]).catch(() => null);
    const issue = safeJSONParse(raw, null);
    if (!issue || issue.number !== issueNumber) {
      issueLookupComplete = false;
      continue;
    }
    const isIssue = !issue.pull_request;
    if (isIssue && String(issue.state).toLowerCase() === 'open') {
      openLinkedIssueNumbers.push(issueNumber);
      openIssues.push({ number: issueNumber, title: issue.title, body: issue.body });
      const assignedLogins = Array.isArray(issue.assignees)
        ? issue.assignees.map((assignee) => String(assignee?.login || '').toLowerCase()).filter(Boolean)
        : [];
      if (assignedLogins.includes(String(pr.authorLogin).toLowerCase())) {
        openerAssignedIssueNumbers.push(issueNumber);
      }
    }
  }
  const linkedIssues = normalizeLinkedIssues(openIssues);
  return {
    facts: {
      linkedIssueNumbers,
      openLinkedIssueNumbers,
      openerAssignedIssueNumbers,
      issueLookupComplete,
      intentFingerprint: linkedIssueIntentFingerprint(linkedIssues),
    },
    linkedIssues,
    inputComplete: openIssues.length <= LINKED_ISSUE_MAX_COUNT && !linkedIssues.some(issue => issue.truncated),
  };
}

/**
 * The three facts that decide which of a repo's open PRs pr-reviewer may target:
 * the `gh` repo selector, the default branch it reviews against, and the login
 * whose own PRs are excluded. Split out of `listExternalOpenPullRequests` so a
 * caller that already HAS the PR rows — the PRs/MRs tab, deciding whether to
 * offer its per-row Review action — can answer "is this row reviewable?" from
 * the same source of truth instead of re-listing every PR or re-deriving the
 * rule and drifting from it.
 */
export async function resolvePrReviewerTargetScope(app) {
  const origin = await getOriginInfo(app?.repoPath).catch(() => null);
  const repoSpec = githubRepoSpec(origin);
  if (!repoSpec) return failure('security-scan-not-a-github-repo');

  const forge = await ensureForgeReachable('pr-reviewer security scan', {
    hostname: githubApiHost(origin.host),
  });
  if (!forge.ok) return failure('security-scan-forge-unreachable');

  const defaultBranch = await execGh([
    'repo', 'view', repoSpec, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name',
  ]).catch(() => null);
  if (!defaultBranch?.trim()) return failure('security-scan-default-branch-unresolved');

  const selfLogin = await getSelfLogin(githubApiHost(origin.host));
  if (!selfLogin) return failure('security-scan-self-login-unavailable');

  return {
    ok: true,
    repoSpec,
    repoFullName: origin.fullName,
    hostname: githubApiHost(origin.host),
    defaultBranch: defaultBranch.trim(),
    selfLogin,
    actorTrust: await createGithubActorTrust({ runGh: execGh, host: githubApiHost(origin.host), repoFullName: origin.fullName, currentUser: selfLogin }),
  };
}

/**
 * Whether one already-listed PR row is a pr-reviewer target, per a resolved
 * scope. Mirrors exactly what `listExternalOpenPullRequests` keeps — open
 * against the default branch, opened by someone other than the signed-in
 * account — so a UI gated on this and the route's authoritative check agree.
 */
export async function isReviewablePullRequest(scope, pullRequest) {
  const author = pullRequest?.author;
  return scope?.ok === true
    && pullRequest?.baseBranch === scope.defaultBranch
    && typeof author === 'string'
    && author.length > 0
    && author.toLowerCase() !== String(scope.selfLogin).toLowerCase()
    && !(await scope.actorTrust?.isTrusted(author));
}

export async function listExternalOpenPullRequests(app) {
  const scope = await resolvePrReviewerTargetScope(app);
  if (!scope.ok) return scope;
  const { repoSpec, repoFullName, hostname, defaultBranch, actorTrust } = scope;

  const raw = await execGh([
    'pr', 'list', '--repo', repoSpec,
    '--base', defaultBranch, '--state', 'open',
    '--limit', String(SECURITY_SCAN_MAX_OPEN_PRS),
    '--json', 'number,author,url,headRefOid,updatedAt,title,body',
  ]).catch(() => null);
  if (raw === null) return failure('security-scan-pr-list-failed');

  const parsed = safeJSONParse(raw, null);
  if (!Array.isArray(parsed)) return failure('security-scan-pr-list-unreadable');
  if (parsed.length >= SECURITY_SCAN_MAX_OPEN_PRS) return failure('security-scan-too-many-open-prs');

  const listedPrs = parsed.map((pr) => ({
    number: pr?.number,
    authorLogin: pr?.author?.login,
    headRefOid: isHeadRefOid(pr?.headRefOid) ? pr.headRefOid : null,
    updatedAt: pr?.updatedAt || null,
    url: typeof pr?.url === 'string' ? pr.url : '',
    title: typeof pr?.title === 'string' ? pr.title : null,
    body: typeof pr?.body === 'string' ? pr.body : '',
  }));
  if (listedPrs.some((pr) => (
    !Number.isInteger(pr.number)
    || pr.number < 1
    || typeof pr.authorLogin !== 'string'
    || !pr.authorLogin
    || typeof pr.title !== 'string'
  ))) {
    return failure('security-scan-pr-list-unreadable');
  }

  const trusted = await mapWithConcurrency(listedPrs, ELIGIBILITY_LOOKUP_CONCURRENCY, pr => actorTrust.isTrusted(pr.authorLogin));
  const externalPrs = listedPrs.filter((_, index) => !trusted[index]);
  const prs = await mapWithConcurrency(externalPrs, ELIGIBILITY_LOOKUP_CONCURRENCY, async (pr) => {
    const { facts, linkedIssues, inputComplete } = await resolveEligibilityFacts(pr, repoFullName, hostname);
    return { ...pr, eligibilityFacts: facts, linkedIssues, inputComplete };
  });

  return {
    ok: true,
    repoSpec,
    repoFullName,
    defaultBranch: defaultBranch.trim(),
    prs,
  };
}

/**
 * Return a stable identity for the public PR set that was scanned. A new head
 * commit produces a new identity, while an unresolved result for the same set
 * does not cause a scheduler to assume that content was safely screened.
 */
export function securityScanFingerprint(target) {
  if (!target?.ok || !Array.isArray(target.prs)) return null;
  if (target.prs.some((pr) => !Number.isInteger(pr?.number) || !isHeadRefOid(pr.headRefOid))) return null;
  const identity = {
    repoFullName: target.repoFullName || null,
    defaultBranch: target.defaultBranch || null,
    prs: target.prs
      .map((pr) => ({ number: pr.number, headRefOid: pr.headRefOid }))
      .sort((a, b) => a.number - b.number),
    eligibilityFacts: target.prs
      .map((pr) => ({ number: pr.number, facts: pr.eligibilityFacts || null }))
      .sort((a, b) => a.number - b.number),
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

const reportChars = (reports) => JSON.stringify(reports).length;

const formatSecurityFindings = (findings) => findings.map((finding) => (
  `${finding.severity} — ${finding.location}: ${finding.reason}`
)).join('\n');

const contentFor = (pr, diff) => [
  'Pull request title:',
  pr.title,
  'Pull request description:',
  pr.body,
  'Complete unified diff:',
  diff,
].join('\n\n');

const contentFingerprintFor = (pr, diff) => modelAbuseContentFingerprint(
  'pull-request',
  { number: pr?.number, headSha: pr?.headRefOid },
  contentFor(pr, diff),
);

const reportFor = (pr, diff, verdict) => ({
  number: pr.number,
  url: pr.url,
  headRefOid: pr.headRefOid,
  contentFingerprint: contentFingerprintFor(pr, diff),
  updatedAt: pr.updatedAt,
  passed: verdict.safe === true,
  safe: verdict.safe === true,
  findings: verdict.safe === true ? 'No model-abuse findings.' : formatSecurityFindings(verdict.findings || []),
  securityFindings: Array.isArray(verdict.findings) ? verdict.findings : [],
  guardId: verdict.guardId || MODEL_ABUSE_GUARD.id,
  guardModel: verdict.model || MODEL_ABUSE_GUARD.name,
  guardRevision: verdict.revision ?? null,
  layers: verdict.layers || null,
  chunkCount: Number.isInteger(verdict.chunkCount) ? verdict.chunkCount : null,
  minBenignScore: Number.isFinite(verdict.minBenignScore) ? verdict.minBenignScore : null,
});

/**
 * Scan every currently-open external PR in order. The complete input is sent
 * to the dedicated classifier, not a promptable chat endpoint. Any unavailable
 * or malformed verdict fails closed; reports collected before that point remain
 * generic and are useful to the human-facing status view only.
 */
export async function runPrReviewerSecurityScan({ app, target = null } = {}) {
  const resolvedTarget = target || await listExternalOpenPullRequests(app);
  if (!resolvedTarget.ok) return resolvedTarget;
  const scanKey = securityScanFingerprint(resolvedTarget);
  if (!scanKey) return failure('security-scan-target-unidentifiable');

  const reviewedPrs = [];
  const reviewInputs = [];
  let hasFindings = false;
  // Named by the verdicts, not the module constant: a scan that ran only the
  // deterministic layer must not be recorded as classified by Prompt Guard.
  let guardModel = MODEL_ABUSE_GUARD.name;
  let guardRevision = MODEL_ABUSE_GUARD.revision;
  for (const pr of resolvedTarget.prs) {
    if (pr.inputComplete === false || pr.linkedIssues?.some(issue => issue.truncated)) return failure('security-scan-linked-issue-too-large', { reviewedPrs, scanKey });
    const diff = await execGh(['pr', 'diff', String(pr.number), '--repo', resolvedTarget.repoSpec]).catch(() => null);
    if (diff === null) return failure('security-scan-diff-unavailable', { reviewedPrs, scanKey });
    if (typeof diff !== 'string' || diff.length > SECURITY_SCAN_MAX_DIFF_CHARS) {
      return failure('security-scan-diff-too-large', { reviewedPrs, scanKey });
    }
    if (!diff.trim()) return failure('security-scan-empty-diff', { reviewedPrs, scanKey });

    // The linked issue's own text is contributor-authored public content, and it
    // is about to be quoted to a downstream reviewer as the requirement the diff
    // is judged against. It crosses the boundary in the same pass as the PR — an
    // injected issue body flags the PR rather than reaching a reviewer as the
    // thing it is supposed to trust. The verdict is one status for the whole
    // PR, so a second classifier subprocess per PR would buy nothing: findings
    // are deliberately generic either way. Freshness stays anchored on both
    // halves separately — the diff by `contentFingerprint`, the issue text by
    // `eligibilityFacts.intentFingerprint`.
    const intentContent = linkedIssueIntentContent(pr.linkedIssues);
    const content = intentContent ? `${contentFor(pr, diff)}\n\n${intentContent}` : contentFor(pr, diff);
    if (content.length > SECURITY_SCAN_MAX_DIFF_CHARS) {
      return failure('security-scan-input-too-large', { reviewedPrs, scanKey });
    }
    const screened = await screenUntrustedContent({ content, source: 'github-pr' });
    const verdict = screened.screening || screened;
    if (!verdict.ok) return failure(verdict.code || 'security-scan-verdict-unavailable', { reviewedPrs, scanKey });
    guardModel = verdict.model || guardModel;
    guardRevision = verdict.revision ?? null;

    const report = reportFor(pr, diff, verdict);
    reviewedPrs.push(report);
    if (reportChars(reviewedPrs) > SECURITY_SCAN_MAX_REPORT_CHARS) {
      return failure('security-scan-report-too-large', { reviewedPrs, scanKey });
    }
    if (!report.safe) hasFindings = true;
    else reviewInputs.push({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      authorLogin: pr.authorLogin,
      url: pr.url,
      headSha: pr.headRefOid,
      baseRefName: resolvedTarget.defaultBranch,
      eligibilityFacts: pr.eligibilityFacts,
      linkedIssues: pr.linkedIssues || [],
      behindBy: null,
      files: [],
      additions: 0,
      deletions: 0,
      diff,
    });
  }

  return {
    ok: true,
    passed: !hasFindings,
    code: hasFindings ? 'security-scan-findings' : 'security-scan-passed',
    guardId: MODEL_ABUSE_GUARD.id,
    guardModel,
    guardRevision,
    repoFullName: resolvedTarget.repoFullName,
    defaultBranch: resolvedTarget.defaultBranch,
    scanKey,
    reviewedPrs,
    reports: reviewedPrs,
    reviewInputs,
  };
}

export function summarizeSecurityScanReport(report) {
  return {
    number: report?.number || null,
    safe: report?.safe === true,
    findingCount: Array.isArray(report?.securityFindings) ? report.securityFindings.length : 0,
    guardId: safeText(report?.guardId, 100) || MODEL_ABUSE_GUARD.id,
  };
}
