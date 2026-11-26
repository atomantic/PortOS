/**
 * Lane-health metrics (#12088): what happened to the issues each audit lane filed.
 *
 * Lane-health metrics (#12088): `computeLaneHealth` counts, per audit lane (metric label,
 * `auditLanes`), the issues filed in a window and how they ended — completed, not planned/duplicate,
 * fix reverted (a `Revert` commit naming the PR or a SHA of it), re-filed (a new issue citing a
 * `path/to/file.ext` a closed one cited within 30 days); `laneHealthFor` picks one lane,
 * `describeLaneFlag` words a flag. Pure; `services/appLaneHealth.js` supplies the forge and git reads.
 *
 * Pure — the forge and git reads live in `services/appLaneHealth.js`; this module only counts and
 * matches, so revert and re-file detection can be pinned with fixtures.
 *
 * A lane is an audit definition's metric label (`auditCatalog.js`). An issue
 * belongs to every lane whose metric label it carries, except that a shared
 * category label (`code-quality`) yields to the more specific lane label an
 * issue also carries (`simplify`, `complexity`, …), so a simplify finding is
 * never double-counted as a code-quality one.
 */

import { auditDomainFor } from './auditDomains.js';
import { AUDIT_DEFINITIONS } from './auditCatalog.js';

export const LANE_HEALTH_WINDOW_DAYS = 60;
export const LANE_REFILE_WINDOW_DAYS = 30;
export const LANE_HEALTH_FLAGGED_LIMIT = 10;
const DAY_MS = 86_400_000;
const MIN_SHA_PREFIX = 7;

// These historical forge labels still identify findings from retired profiles.
export const HISTORICAL_LANE_LABELS = {
  'architecture-maintainability': ['code-quality', 'structural-drift', 'module-hygiene', 'typing'],
  'code-simplification': ['simplify', 'over-engineering', 'complexity', 'cognitive-load'],
  'ui-runtime-bugs': ['app-bug', 'ui-bug', 'console', 'ui-lifecycle'],
  'reliability-error-handling': ['resilience', 'runtime-safety', 'reliability', 'workflow', 'observability'],
  'data-integrity-safety': ['data-safety', 'data-integrity', 'upgrade-rehearsal'],
  'test-quality-coverage': ['test-gap', 'test-quality'],
  'performance-efficiency': ['perf', 'cost'],
  'infrastructure-environment': ['infrastructure', 'dev-environment'],
  'design-usability': ['design', 'ux', 'mobile'],
  'documentation-content': ['docs', 'copy'],
};

/** The audit lanes as `{ id, label, metricLabel, issueLabel }`, catalog order. */
export function auditLanes(definitions = AUDIT_DEFINITIONS) {
  return Object.entries(definitions)
    .filter(([, definition]) => definition?.filing?.metricLabel)
    .map(([id, { label, filing }]) => ({ id, label, metricLabel: filing.metricLabel, issueLabel: filing.issueLabel }));
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name) => typeof name === 'string')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

/** Lane ids an issue's labels attribute it to; the shared category label yields to a specific lane label. */
function attributeIssueLanes(issue, lanes = auditLanes()) {
  const labels = new Set(labelNames(issue?.labels));
  const carried = lanes.flatMap(lane => [lane.metricLabel, ...(HISTORICAL_LANE_LABELS[lane.id] || [])]
    .filter(label => labels.has(label)).map(label => ({ ...lane, matchedLabel: label })));
  return [...new Set(carried
    .filter(lane => !carried.some(other => other.matchedLabel !== lane.matchedLabel
      && (other.issueLabel === lane.matchedLabel
        || (other.matchedLabel === 'observability' && lane.matchedLabel === 'code-quality')
        || (other.matchedLabel === 'copy' && lane.matchedLabel === 'ux'))))
    .map(lane => lane.id))];
}

// A repository-relative source path with at least one directory and an
// extension, as the audit filing contract's `path/to/file.js:LINE` writes it.
// Must follow a boundary character so URL path segments never match.
const FILE_REFERENCE = /(?:^|[\s`'"([<,;])\.?\/?((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?(?=$|[\s`'"),\]>:;.!?])/g;

// A path with a `..` segment is a broken traversal (`./../lib/x.js`), never a
// repository-relative citation. The match includes its boundary character, so
// test the whole match as well as the captured path.
const TRAVERSAL = /(?:^|[^\w.-])\.\.\//;

/** Sorted unique `path/to/file.ext` references cited in an issue body or title. */
export function extractFileReferences(text) {
  if (typeof text !== 'string' || !text) return [];
  const paths = new Set();
  for (const match of text.matchAll(FILE_REFERENCE)) {
    const segments = match[1].split('/');
    if (TRAVERSAL.test(match[0]) || segments.includes('..')) continue;
    const path = segments.filter((segment, index) => !(segment === '.' && index === 0)).join('/');
    if (path.includes('/')) paths.add(path);
  }
  return [...paths].sort();
}

const AUDIT_KEY = /<!--\s*portos-audit:([^:\s>]+):([^\s>]+?)\s*-->/g;

/** Sorted unique `category:key` pairs from `<!-- portos-audit:<category>:<key> -->` markers in a body. */
export function extractAuditKeys(body) {
  if (typeof body !== 'string' || !body) return [];
  return [...new Set([...body.matchAll(AUDIT_KEY)].map((match) => `${match[1]}:${match[2]}`))].sort();
}

const SOLUTION_HEADING = /^#{1,6}[ \t]*(?:impact|fix|proposed fix|acceptance)\b/im;

/**
 * File references from the title plus the problem part of the body — the text
 * before an Impact / Fix / Proposed Fix / Acceptance heading, or the whole body
 * when it has none. Fix and context citations of hub files are not the defect.
 */
export function extractProblemFileReferences(title, body) {
  const text = typeof body === 'string' ? body : '';
  const cut = text.search(SOLUTION_HEADING);
  return extractFileReferences(`${title || ''}\n${cut >= 0 ? text.slice(0, cut) : text}`);
}

const TITLE_STOPWORDS = new Set(['with', 'from', 'that', 'this', 'when', 'were', 'have', 'into', 'then', 'than', 'only', 'does', 'over', 'under', 'after', 'before', 'their', 'there', 'which', 'while', 'using', 'used', 'uses', 'should', 'would', 'could', 'fix', 'fixes', 'issue', 'finding']);
const titleTokens = (title) => new Set(String(title || '').toLowerCase().split(/[^a-z0-9]+/)
  .filter((token) => token.length >= 4 && !TITLE_STOPWORDS.has(token)));
const MIN_SHARED_TITLE_TOKENS = 2;

const shaTokens = (text) => [...String(text || '').matchAll(/\b[0-9a-f]{7,40}\b/g)].map((match) => match[0]);

/**
 * Does this commit revert the pull request? Its subject starts with `Revert`
 * and its message names the PR (`#N`) or a prefix of at least seven hex digits
 * of the merge SHA or one of the PR's own commits — a rebase-merged PR has no
 * merge commit of its own, so the revert body's "This reverts commit <sha>"
 * names one of the PR's commits instead.
 */
function isRevertOf(commit, pullRequest) {
  if (!/^\s*revert\b/i.test(String(commit?.subject || ''))) return false;
  const text = `${commit.subject || ''}\n${commit.body || ''}`;
  if (pullRequest?.number != null && new RegExp(`(?<![\\w#])#${pullRequest.number}(?!\\d)`).test(text)) return true;
  const shas = [pullRequest?.mergeCommit, ...(pullRequest?.commitShas || [])]
    .filter((sha) => typeof sha === 'string' && sha.length >= MIN_SHA_PREFIX)
    .map((sha) => sha.toLowerCase());
  if (!shas.length) return false;
  return shaTokens(text.toLowerCase()).some((token) => shas.some((sha) => sha.startsWith(token) || token.startsWith(sha)));
}

const parseTime = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const closeReason = (issue) => {
  const reason = String(issue?.stateReason || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (reason === 'not_planned') return 'not-planned';
  if (reason === 'duplicate') return 'duplicate';
  if (reason === 'completed' || reason === '') return 'completed';
  return null;
};

const isClosed = (issue) => {
  const state = String(issue?.state || '').toLowerCase();
  return state === 'closed' || (state === '' && parseTime(issue?.closedAt) !== null);
};

function revertsFor(issue, pullRequestsByNumber, commits) {
  const reverts = [];
  for (const number of issue.linkedPullRequests || []) {
    const pullRequest = pullRequestsByNumber.get(number) || { number };
    const revert = commits.find((commit) => isRevertOf(commit, pullRequest));
    if (revert) reverts.push({ pullRequest: number, commit: revert.sha || null });
  }
  return reverts;
}

/**
 * @param {object} input
 * @param {object[]} input.issues - `{ number, title, labels, createdAt, closedAt, state, stateReason, body, url, linkedPullRequests: number[] }`;
 *   include issues closed up to `refileDays` before the window so a re-file of one is seen.
 * @param {object[]} input.pullRequests - `{ number, mergeCommit, commitShas }` merged in the window.
 * @param {object[]} input.commits - `{ sha, subject, body }` on the default branch in the window.
 * @param {number} [input.from] - epoch ms; defaults to `now - windowDays`. A caller whose
 *   issue read was truncated passes the oldest created time it covered so counts stay honest.
 * @returns {{ windowDays, refileDays, from, to, lanes: object[] }} one row per lane, catalog order.
 */
export function computeLaneHealth({
  issues = [],
  pullRequests = [],
  commits = [],
  lanes = auditLanes(),
  now = Date.now(),
  windowDays = LANE_HEALTH_WINDOW_DAYS,
  refileDays = LANE_REFILE_WINDOW_DAYS,
  from = now - windowDays * DAY_MS,
  flaggedLimit = LANE_HEALTH_FLAGGED_LIMIT,
} = {}) {
  const pullRequestsByNumber = new Map(pullRequests.filter((pr) => pr?.number != null).map((pr) => [pr.number, pr]));
  const refileMs = refileDays * DAY_MS;
  const byLane = new Map(lanes.map((lane) => [lane.id, []]));
  for (const issue of issues) {
    for (const id of attributeIssueLanes(issue, lanes)) byLane.get(id)?.push(issue);
  }

  const rows = lanes.map((lane) => {
    const laneIssues = byLane.get(lane.id)
      .filter((issue) => parseTime(issue.createdAt) !== null)
      .sort((a, b) => parseTime(a.createdAt) - parseTime(b.createdAt) || (a.number ?? 0) - (b.number ?? 0));
    const closedRefs = laneIssues
      .filter((issue) => isClosed(issue) && parseTime(issue.closedAt) !== null)
      .map((issue) => ({
        issue,
        closedAt: parseTime(issue.closedAt),
        reason: closeReason(issue),
        paths: extractProblemFileReferences(issue.title, issue.body),
        keys: extractAuditKeys(issue.body),
        tokens: titleTokens(issue.title),
        reverted: null,
      }));
    const wasReverted = (entry) => {
      entry.reverted ??= revertsFor(entry.issue, pullRequestsByNumber, commits).length > 0;
      return entry.reverted;
    };
    const inWindow = laneIssues.filter((issue) => {
      const created = parseTime(issue.createdAt);
      return created >= from && created <= now;
    });

    const counts = { filed: inWindow.length, completed: 0, notPlanned: 0, open: 0, reverted: 0, refiled: 0 };
    const flagged = [];
    for (const issue of inWindow) {
      const reasons = [];
      if (isClosed(issue)) {
        const reason = closeReason(issue);
        // A duplicate close is the forge's own "already filed" verdict; it
        // counts beside not-planned because the lane repeated itself either way.
        if (reason === 'not-planned' || reason === 'duplicate') {
          counts.notPlanned += 1;
          reasons.push({ kind: 'not-planned', stateReason: reason });
        } else if (reason === 'completed') {
          counts.completed += 1;
        }
        const reverts = revertsFor(issue, pullRequestsByNumber, commits);
        if (reverts.length) {
          counts.reverted += 1;
          reasons.push({ kind: 'reverted', pullRequest: reverts[0].pullRequest, commit: reverts[0].commit });
        }
      } else {
        counts.open += 1;
      }
      const created = parseTime(issue.createdAt);
      const paths = extractProblemFileReferences(issue.title, issue.body);
      const keys = extractAuditKeys(issue.body);
      const tokens = titleTokens(issue.title);
      const sharedPath = (entry) => entry.paths.find((path) => paths.includes(path));
      // Same finding again: an exact audit key, a path an earlier close rejected
      // or had reverted, or a completed fix to the same file on the same topic.
      // A shared hub file alone is not a repeat.
      const refiledOf = (entry) => {
        if (entry.keys.some((key) => keys.includes(key))) return { key: entry.keys.find((key) => keys.includes(key)), path: sharedPath(entry) };
        const path = sharedPath(entry);
        if (!path) return null;
        if (entry.reason !== 'completed' || wasReverted(entry)) return { path };
        const shared = [...entry.tokens].filter((token) => tokens.has(token)).length;
        return shared >= MIN_SHARED_TITLE_TOKENS ? { path } : null;
      };
      let earlier = null;
      for (const entry of closedRefs) {
        if (entry.issue === issue || entry.issue.number === issue.number
          || entry.closedAt > created || created - entry.closedAt > refileMs) continue;
        const hit = refiledOf(entry);
        if (hit) { earlier = { entry, hit }; break; }
      }
      if (earlier) {
        counts.refiled += 1;
        const { hit } = earlier;
        reasons.push({ kind: 're-filed', of: earlier.entry.issue.number, ...(hit.path && { path: hit.path }), ...(hit.key && { key: hit.key }) });
      }
      if (reasons.length) {
        flagged.push({ number: issue.number, title: String(issue.title || '').trim(), url: issue.url || null, reasons });
      }
    }
    // Newest first, so the agent sees what it most recently got wrong.
    flagged.reverse();
    return { id: lane.id, label: lane.label, metricLabel: lane.metricLabel,
      ...counts, flagged: flagged.slice(0, flaggedLimit), flaggedTotal: flagged.length };
  });

  return { windowDays, refileDays, from: new Date(from).toISOString(), to: new Date(now).toISOString(), lanes: rows };
}

/** One lane's row, by task type, from a computed report. */
export function laneHealthFor(report, taskType) {
  return report?.lanes?.find((lane) => lane.id === auditDomainFor(taskType)) || null;
}

/** Plain-prose reason for a flagged issue, the same in the prompt block and the UI. */
export function describeLaneFlag(reason) {
  if (reason?.kind === 'not-planned') return reason.stateReason === 'duplicate' ? 'closed as duplicate' : 'closed as not planned';
  if (reason?.kind === 'reverted') return `fix reverted${reason.pullRequest != null ? ` (PR #${reason.pullRequest})` : ''}`;
  if (reason?.kind === 're-filed') return `re-filed${reason.of != null ? ` after #${reason.of}` : ''}${reason.path ? ` on ${reason.path}` : ''}`;
  return 'flagged';
}
