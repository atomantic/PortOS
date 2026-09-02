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
import { getOriginInfo } from '../lib/gitRemote.js';
import { githubApiHost, githubRepoSpec } from '../lib/workTracker.js';
import {
  MODEL_ABUSE_GUARD,
  MODEL_ABUSE_GUARD_MAX_INPUT_CHARS,
  modelAbuseContentFingerprint,
} from '../lib/modelAbuseGuard.js';
import { runModelAbuseScan } from './modelAbuseGuard.js';
import { safeJSONParse } from '../lib/fileUtils.js';

export const SECURITY_SCAN_MAX_OPEN_PRS = 200;
export const SECURITY_SCAN_MAX_DIFF_CHARS = MODEL_ABUSE_GUARD_MAX_INPUT_CHARS;
export const SECURITY_SCAN_MAX_REPORT_CHARS = 100_000;

const failure = (code, extra = {}) => ({ ok: false, passed: false, code, ...extra });
const isHeadRefOid = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const safeText = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';

/**
 * Find every currently-open PR from an external human contributor. This is a
 * public-metadata operation only; it does not fetch a branch or run code.
 */
export async function listExternalOpenPullRequests(app) {
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

  const raw = await execGh([
    'pr', 'list', '--repo', repoSpec,
    '--base', defaultBranch.trim(), '--state', 'open',
    '--limit', String(SECURITY_SCAN_MAX_OPEN_PRS),
    '--json', 'number,author,url,headRefOid,updatedAt,title,body',
  ]).catch(() => null);
  if (raw === null) return failure('security-scan-pr-list-failed');

  const parsed = safeJSONParse(raw, null);
  if (!Array.isArray(parsed)) return failure('security-scan-pr-list-unreadable');
  if (parsed.length >= SECURITY_SCAN_MAX_OPEN_PRS) return failure('security-scan-too-many-open-prs');

  const prs = parsed.map((pr) => ({
    number: pr?.number,
    authorLogin: pr?.author?.login,
    headRefOid: isHeadRefOid(pr?.headRefOid) ? pr.headRefOid : null,
    updatedAt: pr?.updatedAt || null,
    url: typeof pr?.url === 'string' ? pr.url : '',
    title: typeof pr?.title === 'string' ? pr.title : null,
    body: typeof pr?.body === 'string' ? pr.body : '',
  }));
  if (prs.some((pr) => (
    !Number.isInteger(pr.number)
    || pr.number < 1
    || typeof pr.authorLogin !== 'string'
    || !pr.authorLogin
    || typeof pr.title !== 'string'
  ))) {
    return failure('security-scan-pr-list-unreadable');
  }

  return {
    ok: true,
    repoSpec,
    repoFullName: origin.fullName,
    defaultBranch: defaultBranch.trim(),
    prs: prs.filter((pr) => String(pr.authorLogin).toLowerCase() !== String(selfLogin).toLowerCase()),
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
  guardRevision: verdict.revision || MODEL_ABUSE_GUARD.revision,
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
export async function runPrReviewerSecurityScan({ app, timeoutMs, target = null } = {}) {
  const resolvedTarget = target || await listExternalOpenPullRequests(app);
  if (!resolvedTarget.ok) return resolvedTarget;
  const scanKey = securityScanFingerprint(resolvedTarget);
  if (!scanKey) return failure('security-scan-target-unidentifiable');

  const reviewedPrs = [];
  const reviewInputs = [];
  let hasFindings = false;
  for (const pr of resolvedTarget.prs) {
    const diff = await execGh(['pr', 'diff', String(pr.number), '--repo', resolvedTarget.repoSpec]).catch(() => null);
    if (diff === null) return failure('security-scan-diff-unavailable', { reviewedPrs, scanKey });
    if (typeof diff !== 'string' || diff.length > SECURITY_SCAN_MAX_DIFF_CHARS) {
      return failure('security-scan-diff-too-large', { reviewedPrs, scanKey });
    }
    if (!diff.trim()) return failure('security-scan-empty-diff', { reviewedPrs, scanKey });

    const content = contentFor(pr, diff);
    if (content.length > SECURITY_SCAN_MAX_DIFF_CHARS) {
      return failure('security-scan-input-too-large', { reviewedPrs, scanKey });
    }
    const verdict = await runModelAbuseScan({ content, timeoutMs });
    if (!verdict.ok) return failure(verdict.code || 'security-scan-verdict-unavailable', { reviewedPrs, scanKey });

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
    guardModel: MODEL_ABUSE_GUARD.name,
    guardRevision: MODEL_ABUSE_GUARD.revision,
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
