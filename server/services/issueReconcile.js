/**
 * Issue Reconciler — deterministic core.
 *
 * Finds ZOMBIE issues: open + `in-progress` (claimed-and-being-worked) yet with
 * their linked PR already MERGED and NO live claim anywhere (no open PR, no
 * local/remote/CoS claim branch, no active CoS agent). A zombie is an issue a
 * partial ship left stranded — the claim queue skips `in-progress`, so its
 * remaining scope is never re-picked and never finished.
 *
 * The scheduler runs the deterministic scan here (gh + git only — no LLM), then
 * hands the zombie set to a coordinator CoS agent that reads each issue + its
 * merged PR and applies the partial-ship hybrid (close + file a scoped follow-up
 * when the remainder is separable, or comment "done/remaining" + release the
 * claim when it's a continuation). This module never spawns an agent, so it
 * stays pure enough to unit-test — mirroring `branchReconcile.js`.
 *
 * PEER SAFETY differs from branch-reconcile. Branch-reconcile only ever touches
 * LOCAL refs, so a peer's branch is structurally invisible. Issue state, by
 * contrast, is SHARED GitHub state across every federated peer. So the live-claim
 * guard deliberately consults REMOTE refs and OPEN PRs too — a claim in flight on
 * another machine shows up here as an `origin/*` ref or an open PR, and must
 * suppress the zombie classification. Close/unlabel are idempotent across peers;
 * the one real race (two machines filing a duplicate follow-up) is deduped by the
 * coordinator, not here.
 */

import { execGit } from '../lib/execGit.js';
import { execGh } from './github.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';

// Bound the gh queries (single-user repos never realistically truncate at 200).
const GH_LIST_LIMIT = 200;

// The `in-progress` label = "claimed and being worked". Kept as a constant so
// the scan, the classifier docs, and any future config share one spelling.
export const IN_PROGRESS_LABEL = 'in-progress';

/**
 * Extract the issue number a git ref claims, or null. Recognizes both claim
 * conventions:
 *   - human / TUI:  `claim/issue-<num>`
 *   - CoS sub-agent: `cos/<task>/issue-<num>/<agent>`
 * The number must be a whole path segment (terminated by `/` or end-of-ref), so
 * `issue-222` never matches inside `issue-2220`. Remote-tracking refs
 * (`origin/claim/issue-<num>`) match the same way — the `refs/remotes/origin/`
 * prefix is just more leading segments.
 * @param {string} refName
 * @returns {number|null}
 */
export function issueNumberFromRef(refName) {
  const m = /(?:^|\/)issue-(\d+)(?=\/|$)/.exec(refName || '');
  return m ? Number(m[1]) : null;
}

/**
 * Does a PR body reference issue #num as a whole token? `#222` must not match
 * inside `#2220`, so the digits are followed by a non-digit boundary. Matches
 * plain `#num` as well as `Closes/Fixes/Resolves/Refs #num`.
 * @param {string} body
 * @param {number} num
 * @returns {boolean}
 */
export function bodyReferencesIssue(body, num) {
  if (!body || !Number.isInteger(num)) return false;
  return new RegExp(`#${num}(?!\\d)`).test(body);
}

/**
 * Does a PR (by head ref OR body) reference issue #num?
 * @param {{headRefName?:string, body?:string}} pr
 * @param {number} num
 * @returns {boolean}
 */
export function prReferencesIssue(pr, num) {
  if (!pr) return false;
  if (issueNumberFromRef(pr.headRefName) === num) return true;
  return bodyReferencesIssue(pr.body, num);
}

/**
 * Pure classifier: map one issue's facts to a reconcile state. First match wins.
 *   ZOMBIE  — merged PR shipped for it, no live claim, no active agent → heal
 *   LIVE    — an open PR / claim branch / active agent still owns it     → leave
 *   STALLED — no merged PR and no live claim (claimed but nothing shipped)→ report
 * Only issues that already carry `in-progress` are ever passed in.
 * @param {{ hasMergedPr:boolean, hasLiveClaim:boolean, hasActiveAgent:boolean }} input
 * @returns {'ZOMBIE'|'LIVE'|'STALLED'}
 */
export function classifyIssue({ hasMergedPr, hasLiveClaim, hasActiveAgent }) {
  if (hasLiveClaim || hasActiveAgent) return 'LIVE';
  if (hasMergedPr) return 'ZOMBIE';
  return 'STALLED';
}

/**
 * Classify a list of gathered issue inputs. Pure.
 * @param {object[]} inputs - each from `gatherIssueState`
 * @returns {object[]} inputs with a `state` field added
 */
export function classifyIssues(inputs) {
  return inputs.map((input) => ({ ...input, state: classifyIssue(input) }));
}

/**
 * Every issue number that has a LIVE claim ref (local OR remote). A live ref
 * means some machine (this one or a peer) is mid-claim, so the issue is NOT a
 * zombie even if a different PR already merged.
 * @param {string} repoPath
 * @returns {Promise<Set<number>>}
 */
async function getLiveClaimIssueNums(repoPath) {
  const { stdout } = await execGit(
    ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/'],
    repoPath,
    { ignoreExitCode: true }
  ).catch(() => ({ stdout: '' }));
  const nums = new Set();
  for (const line of (stdout || '').split('\n')) {
    const num = issueNumberFromRef(line.trim());
    if (num != null) nums.add(num);
  }
  return nums;
}

/**
 * Fetch issue/PR facts from GitHub. Returns null on any gh failure or non-GitHub
 * remote (degrade: the caller treats null as "nothing to reconcile / transient").
 * @param {string} repoPath
 * @returns {Promise<{fullName:string, inProgress:object[], mergedPrs:object[], openPrs:object[]}|null>}
 */
async function getGithubState(repoPath) {
  const origin = await getOriginInfo(repoPath).catch(() => null);
  if (!origin?.isGithub || !origin.fullName) return null;
  const { fullName } = origin;

  const [issuesRaw, mergedRaw, openRaw] = await Promise.all([
    execGh(['issue', 'list', '--repo', fullName, '--state', 'open',
      '--label', IN_PROGRESS_LABEL, '--limit', String(GH_LIST_LIMIT),
      '--json', 'number,title,labels,assignees,url']).catch(() => null),
    execGh(['pr', 'list', '--repo', fullName, '--state', 'merged',
      '--limit', String(GH_LIST_LIMIT),
      '--json', 'number,headRefName,body,url,mergedAt']).catch(() => null),
    execGh(['pr', 'list', '--repo', fullName, '--state', 'open',
      '--limit', String(GH_LIST_LIMIT),
      '--json', 'number,headRefName,body']).catch(() => null),
  ]);

  const inProgress = safeJSONParse(issuesRaw, null);
  // A failed ISSUE list is the load-bearing query — treat the whole scan as a
  // transient blip (return null → skip without parking). Empty is a valid,
  // different answer (no in-progress issues) and returns [].
  if (!Array.isArray(inProgress)) return null;
  return {
    fullName,
    inProgress,
    mergedPrs: safeJSONParse(mergedRaw, []) || [],
    openPrs: safeJSONParse(openRaw, []) || [],
  };
}

/**
 * Gather the raw facts for every open `in-progress` issue in `repoPath`'s GitHub
 * repo. Effectful (gh + git). Returns null on a non-GitHub remote or a transient
 * gh failure so the scheduler can skip without parking.
 *
 * @param {string} repoPath
 * @param {{ activeAgentIssueNums?: Set<number> }} [ctx] - issue numbers an active
 *   CoS agent is currently claiming (from agent metadata); suppresses zombie
 *   classification for an issue whose agent is still running.
 * @returns {Promise<{fullName:string, issues:object[]}|null>}
 */
export async function gatherIssueState(repoPath, { activeAgentIssueNums = new Set() } = {}) {
  const [gh, liveClaimNums] = await Promise.all([
    getGithubState(repoPath),
    getLiveClaimIssueNums(repoPath),
  ]);
  if (!gh) return null;

  const issues = gh.inProgress.map((issue) => {
    const num = issue.number;
    const mergedPr = gh.mergedPrs.find((pr) => prReferencesIssue(pr, num)) || null;
    const openPr = gh.openPrs.find((pr) => prReferencesIssue(pr, num)) || null;
    return {
      number: num,
      title: issue.title || '',
      url: issue.url || '',
      labels: Array.isArray(issue.labels) ? issue.labels.map((l) => l.name) : [],
      assignees: Array.isArray(issue.assignees) ? issue.assignees.map((a) => a.login) : [],
      mergedPr,
      hasMergedPr: Boolean(mergedPr),
      // Live claim = an OPEN PR for this issue, OR a local/remote claim branch,
      // OR an active CoS agent — any means "still being worked".
      hasLiveClaim: Boolean(openPr) || liveClaimNums.has(num),
      hasActiveAgent: activeAgentIssueNums.has(num),
    };
  });
  return { fullName: gh.fullName, issues };
}

/**
 * Full reconcile: gather → classify → split. Returns the zombie set (for the
 * coordinator agent) plus stalled/live for reporting. Pure-ish (delegates all
 * I/O to gatherIssueState).
 *
 * @param {string} [repoPath=PATHS.root]
 * @param {{ activeAgentIssueNums?: Set<number> }} [opts]
 * @returns {Promise<{ fullName:string, zombies:object[], stalled:object[], live:object[] }|null>}
 *   null on non-GitHub remote / transient gh failure (skip, don't park).
 */
export async function reconcile(repoPath = PATHS.root, { activeAgentIssueNums = new Set() } = {}) {
  const gathered = await gatherIssueState(repoPath, { activeAgentIssueNums });
  if (!gathered) return null;
  const classified = classifyIssues(gathered.issues);
  return {
    fullName: gathered.fullName,
    zombies: classified.filter((c) => c.state === 'ZOMBIE'),
    stalled: classified.filter((c) => c.state === 'STALLED'),
    live: classified.filter((c) => c.state === 'LIVE'),
  };
}

/**
 * Stable signature of the zombie set — the perpetual drain compares it across
 * dispatches to detect PROGRESS. A productive coordinator run closes or releases
 * zombies (removing them here) or a new partial ship adds one; either changes the
 * signature. An unchanged signature means the last run left the same zombies in
 * the same state (coordinator errored, or the human hasn't acted on a case it
 * punted) → "no progress → park" instead of re-dispatching an identical run.
 * Order-independent (sorted).
 * @param {object[]} zombies
 * @returns {string}
 */
export function zombieSignature(zombies) {
  return zombies
    .map((z) => `${z.number}:${z.mergedPr?.number ?? 'none'}`)
    .sort()
    .join('|');
}

/**
 * Render the zombie set into the coordinator prompt body (injected as
 * `{zombieIssues}`). The per-issue entries stay factual; the partial-ship
 * mechanics live once in the prompt template. Only the dynamic `autoClose`
 * directive is surfaced here (the template can't know it), as a single header
 * line rather than repeated per issue.
 * @param {object[]} zombies
 * @param {{ fullName:string, autoClose:boolean }} ctx
 * @returns {string}
 */
export function formatZombiesForPrompt(zombies, { fullName, autoClose }) {
  const lines = [
    `Repo: \`${fullName}\`. Zombie issues to reconcile (${zombies.length}):`,
    '',
    autoClose
      ? '**autoClose is ON** — apply the full partial-ship hybrid below (close + file a scoped follow-up when the remainder is separable; otherwise comment + release the claim).'
      : '**autoClose is OFF** — never close an issue or file a follow-up. Only post a `Done ✓ / Remaining ▢` comment and release the `in-progress` claim so the queue re-picks it.',
    '',
  ];
  for (const z of zombies) {
    const pr = z.mergedPr ? `merged PR #${z.mergedPr.number}${z.mergedPr.url ? ` (${z.mergedPr.url})` : ''}` : 'a merged PR';
    lines.push(`### #${z.number} — ${z.title}`);
    if (z.url) lines.push(`- Issue: ${z.url}`);
    lines.push(`- Shipped by: ${pr}`);
    lines.push('');
  }
  return lines.join('\n');
}
