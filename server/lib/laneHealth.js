/**
 * Lane-health metrics (#12088): what happened to the issues each audit lane
 * filed. Pure — the forge and git reads live in `services/appLaneHealth.js`;
 * this module only counts and matches, so revert and re-file detection can be
 * pinned with fixtures.
 *
 * A lane is an audit definition's metric label (`auditCatalog.js`). An issue
 * belongs to every lane whose metric label it carries, except that a shared
 * category label (`code-quality`) yields to the more specific lane label an
 * issue also carries (`simplify`, `complexity`, …), so a simplify finding is
 * never double-counted as a code-quality one.
 */

import { AUDIT_DEFINITIONS } from './auditCatalog.js';

export const LANE_HEALTH_WINDOW_DAYS = 60;
export const LANE_REFILE_WINDOW_DAYS = 30;
export const LANE_HEALTH_FLAGGED_LIMIT = 10;
const DAY_MS = 86_400_000;
const MIN_SHA_PREFIX = 7;

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
  const carried = lanes.filter((lane) => labels.has(lane.metricLabel));
  return carried
    .filter((lane) => !carried.some((other) => other !== lane && other.issueLabel === lane.metricLabel && other.metricLabel !== lane.metricLabel))
    .map((lane) => lane.id);
}

// A repository-relative source path with at least one directory and an
// extension, as the audit filing contract's `path/to/file.js:LINE` writes it.
// Must follow a boundary character so URL path segments never match.
const FILE_REFERENCE = /(?:^|[\s`'"(\[<,;])\.?\/?((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?(?=$|[\s`'"),\]>:;.!?])/g;

/** Sorted unique `path/to/file.ext` references cited in an issue body or title. */
function extractFileReferences(text) {
  if (typeof text !== 'string' || !text) return [];
  const paths = new Set();
  for (const match of text.matchAll(FILE_REFERENCE)) paths.add(match[1]);
  return [...paths].sort();
}

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
    for (const laneId of attributeIssueLanes(issue, lanes)) byLane.get(laneId).push(issue);
  }

  const rows = lanes.map((lane) => {
    const laneIssues = byLane.get(lane.id)
      .filter((issue) => parseTime(issue.createdAt) !== null)
      .sort((a, b) => parseTime(a.createdAt) - parseTime(b.createdAt) || (a.number ?? 0) - (b.number ?? 0));
    const closedRefs = laneIssues
      .filter((issue) => isClosed(issue) && parseTime(issue.closedAt) !== null)
      .map((issue) => ({ issue, closedAt: parseTime(issue.closedAt), paths: extractFileReferences(`${issue.title || ''}\n${issue.body || ''}`) }))
      .filter((entry) => entry.paths.length);
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
      const paths = extractFileReferences(`${issue.title || ''}\n${issue.body || ''}`);
      const earlier = paths.length
        ? closedRefs.find((entry) => entry.issue !== issue && entry.issue.number !== issue.number
            && entry.closedAt <= created && created - entry.closedAt <= refileMs
            && entry.paths.some((path) => paths.includes(path)))
        : null;
      if (earlier) {
        counts.refiled += 1;
        reasons.push({ kind: 're-filed', of: earlier.issue.number, path: earlier.paths.find((path) => paths.includes(path)) });
      }
      if (reasons.length) {
        flagged.push({ number: issue.number, title: String(issue.title || '').trim(), url: issue.url || null, reasons });
      }
    }
    // Newest first, so the agent sees what it most recently got wrong.
    flagged.reverse();
    return { id: lane.id, label: lane.label, metricLabel: lane.metricLabel, ...counts, flagged: flagged.slice(0, flaggedLimit), flaggedTotal: flagged.length };
  });

  return { windowDays, refileDays, from: new Date(from).toISOString(), to: new Date(now).toISOString(), lanes: rows };
}

/** One lane's row, by task type, from a computed report. */
export function laneHealthFor(report, taskType) {
  return report?.lanes?.find((lane) => lane.id === taskType) || null;
}

/** Plain-prose reason for a flagged issue, the same in the prompt block and the UI. */
export function describeLaneFlag(reason) {
  if (reason?.kind === 'not-planned') return reason.stateReason === 'duplicate' ? 'closed as duplicate' : 'closed as not planned';
  if (reason?.kind === 'reverted') return `fix reverted${reason.pullRequest != null ? ` (PR #${reason.pullRequest})` : ''}`;
  if (reason?.kind === 're-filed') return `re-filed${reason.of != null ? ` after #${reason.of}` : ''}${reason.path ? ` on ${reason.path}` : ''}`;
  return 'flagged';
}
