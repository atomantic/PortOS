/**
 * Issue Reconciler — deterministic core.
 *
 * Finds ZOMBIE issues: open + `in-progress` (claimed-and-being-worked) yet with
 * their linked PR/MR already MERGED and NO live claim anywhere (no open PR/MR, no
 * local/remote/CoS claim branch, no active CoS agent). A zombie is an issue a
 * partial ship left stranded — the claim queue skips `in-progress`, so its
 * remaining scope is never re-picked and never finished.
 *
 * Forge-agnostic: the same scan runs over GitHub (`gh` issues + PRs) and GitLab
 * (`glab` issues + merge requests). The forge is resolved from the app's git
 * `origin` host (github.* → GitHub, gitlab.* → GitLab); any other remote returns
 * null (skip/park). The pure classifier, ref matchers, and convergence signature
 * are shared — only the effectful state gatherer differs per forge, and each
 * normalizes into one common `{ number, title, url, labels, assignees }` issue
 * shape + `{ number, headRefName, body, url }` change shape so the merge/classify
 * logic never branches on forge.
 *
 * The scheduler runs the deterministic scan here (gh/glab + git only — no LLM),
 * then hands the zombie set to a coordinator CoS agent that reads each issue + its
 * merged PR/MR and applies the partial-ship hybrid (close + file a scoped
 * follow-up when the remainder is separable, or comment "done/remaining" + release
 * the claim when it's a continuation). This module never spawns an agent, so it
 * stays pure enough to unit-test — mirroring `branchReconcile.js`.
 *
 * PEER SAFETY differs from branch-reconcile. Branch-reconcile only ever touches
 * LOCAL refs, so a peer's branch is structurally invisible. Issue state, by
 * contrast, is SHARED forge state across every federated peer. So the live-claim
 * guard deliberately consults REMOTE refs and OPEN PRs/MRs too — a claim in flight
 * on another machine shows up here as an `origin/*` ref or an open PR/MR, and must
 * suppress the zombie classification. Close/unlabel are idempotent across peers;
 * the one real race (two machines filing a duplicate follow-up) is deduped by the
 * coordinator, not here.
 */

import { execGit } from '../lib/execGit.js';
import { execGh } from './github.js';
import { execGlab } from './gitlab.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { hostToWorkTracker } from '../lib/workTracker.js';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';

// Bound the forge queries (single-user repos never realistically truncate at 200).
const GH_LIST_LIMIT = 200;
// glab paginates via `--per-page`; its practical max page is 100.
const GL_PER_PAGE = 100;

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
 * prefix is just more leading segments. Forge-agnostic: GitLab MR source
 * branches use the identical `claim/issue-<iid>` convention.
 * @param {string} refName
 * @returns {number|null}
 */
export function issueNumberFromRef(refName) {
  const m = /(?:^|\/)issue-(\d+)(?=\/|$)/.exec(refName || '');
  return m ? Number(m[1]) : null;
}

/**
 * Does a PR/MR body reference issue #num as a whole token? `#222` must not match
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
 * Does a PR/MR (by head ref OR body) reference issue #num?
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
 *   ZOMBIE  — merged PR/MR shipped for it, no live claim, no active agent → heal
 *   LIVE    — an open PR/MR / claim branch / active agent still owns it     → leave
 *   STALLED — no merged PR/MR and no live claim (claimed but nothing shipped)→ report
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
 * zombie even if a different PR/MR already merged. Forge-agnostic — both GitHub
 * and GitLab claim branches share the `claim/issue-<num>` naming.
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
 * Normalize a raw GitHub issue (from `gh issue list --json`) into the common
 * shape the forge-agnostic gatherer consumes.
 */
function normalizeGithubIssue(issue) {
  return {
    number: issue.number,
    title: issue.title || '',
    url: issue.url || '',
    labels: Array.isArray(issue.labels) ? issue.labels.map((l) => l.name) : [],
    assignees: Array.isArray(issue.assignees) ? issue.assignees.map((a) => a.login) : [],
  };
}

/**
 * Fetch issue/PR facts from GitHub, normalized to the common shape. Returns null
 * on any gh failure (degrade: the caller treats null as "nothing to reconcile /
 * transient"). `fullName` is resolved by the dispatcher, not re-queried here.
 * @param {string} repoPath
 * @param {string} fullName
 * @returns {Promise<{forge:'github', fullName:string, inProgress:object[], mergedPrs:object[], openPrs:object[]}|null>}
 */
async function getGithubState(repoPath, fullName) {
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

  const inProgressRaw = safeJSONParse(issuesRaw, null);
  // A failed ISSUE list is the load-bearing query — treat the whole scan as a
  // transient blip (return null → skip without parking). Empty is a valid,
  // different answer (no in-progress issues) and returns [].
  if (!Array.isArray(inProgressRaw)) return null;
  return {
    forge: 'github',
    fullName,
    inProgress: inProgressRaw.map(normalizeGithubIssue),
    mergedPrs: safeJSONParse(mergedRaw, []) || [],
    openPrs: safeJSONParse(openRaw, []) || [],
  };
}

/**
 * Normalize a raw GitLab issue (from `glab issue list -F json`) into the common
 * shape. GitLab keys the number on `iid`, exposes labels as plain strings, and
 * assignees as `{ username }` objects.
 */
function normalizeGitlabIssue(issue) {
  return {
    number: issue.iid,
    title: issue.title || '',
    url: issue.web_url || '',
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
      : [],
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.map((a) => a?.username).filter(Boolean)
      : [],
  };
}

/**
 * Normalize a raw GitLab merge request into the common `{ number, headRefName,
 * body, url }` change shape `prReferencesIssue` expects. The MR's source branch
 * is the head ref (carries `claim/issue-<iid>`); the description is the body
 * (carries `Refs #<iid>`).
 */
function normalizeGitlabMr(mr) {
  return {
    number: mr.iid,
    headRefName: mr.source_branch || '',
    body: mr.description || '',
    url: mr.web_url || '',
  };
}

/**
 * Fetch issue/MR facts from GitLab via `glab`, normalized to the common shape.
 * Mirrors getGithubState: the in-progress ISSUE list is load-bearing (null → skip
 * without parking); merged/open MR lists degrade to []. `glab` resolves the
 * project from the repo's origin remote, so every call runs in `repoPath`.
 * @param {string} repoPath
 * @param {string} fullName
 * @returns {Promise<{forge:'gitlab', fullName:string, inProgress:object[], mergedPrs:object[], openPrs:object[]}|null>}
 */
async function getGitlabState(repoPath, fullName) {
  const [issuesRaw, mergedRaw, openRaw] = await Promise.all([
    // `glab issue list` defaults to OPEN issues; --label filters to in-progress.
    execGlab(['issue', 'list', '--label', IN_PROGRESS_LABEL,
      '--per-page', String(GL_PER_PAGE), '-F', 'json'], repoPath),
    execGlab(['mr', 'list', '--state', 'merged',
      '--per-page', String(GL_PER_PAGE), '-F', 'json'], repoPath),
    execGlab(['mr', 'list', '--state', 'opened',
      '--per-page', String(GL_PER_PAGE), '-F', 'json'], repoPath),
  ]);

  const inProgressRaw = safeJSONParse(issuesRaw, null);
  if (!Array.isArray(inProgressRaw)) return null;
  return {
    forge: 'gitlab',
    fullName,
    inProgress: inProgressRaw.map(normalizeGitlabIssue),
    mergedPrs: (safeJSONParse(mergedRaw, []) || []).map(normalizeGitlabMr),
    openPrs: (safeJSONParse(openRaw, []) || []).map(normalizeGitlabMr),
  };
}

/**
 * Resolve the app's forge from its git origin host and fetch the corresponding
 * state. github.* → GitHub, gitlab.* → GitLab; any other remote (or no origin)
 * returns null so the caller skips without parking.
 * @param {string} repoPath
 * @returns {Promise<object|null>}
 */
async function getForgeState(repoPath) {
  const origin = await getOriginInfo(repoPath).catch(() => null);
  if (!origin?.fullName) return null;
  // getOriginInfo already classifies GitHub authoritatively (older callers/tests
  // may not carry a `host`), so trust isGithub first; fall back to the canonical
  // host classifier for GitLab (and any future forges hostToWorkTracker adds).
  if (origin.isGithub) return getGithubState(repoPath, origin.fullName);
  if (hostToWorkTracker(origin.host) === 'gitlab') return getGitlabState(repoPath, origin.fullName);
  return null;
}

/**
 * Gather the raw facts for every open `in-progress` issue in `repoPath`'s forge
 * repo. Effectful (gh/glab + git). Returns null on an unsupported remote (not
 * GitHub/GitLab) or a transient forge failure so the scheduler can skip without
 * parking.
 *
 * @param {string} repoPath
 * @param {{ activeAgentIssueNums?: Set<number> }} [ctx] - issue numbers an active
 *   CoS agent is currently claiming (from agent metadata); suppresses zombie
 *   classification for an issue whose agent is still running.
 * @returns {Promise<{forge:string, fullName:string, issues:object[]}|null>}
 */
export async function gatherIssueState(repoPath, { activeAgentIssueNums = new Set() } = {}) {
  const [state, liveClaimNums] = await Promise.all([
    getForgeState(repoPath),
    getLiveClaimIssueNums(repoPath),
  ]);
  if (!state) return null;

  const issues = state.inProgress.map((issue) => {
    const num = issue.number;
    const mergedPr = state.mergedPrs.find((pr) => prReferencesIssue(pr, num)) || null;
    const openPr = state.openPrs.find((pr) => prReferencesIssue(pr, num)) || null;
    return {
      number: num,
      title: issue.title || '',
      url: issue.url || '',
      labels: Array.isArray(issue.labels) ? issue.labels : [],
      assignees: Array.isArray(issue.assignees) ? issue.assignees : [],
      mergedPr,
      hasMergedPr: Boolean(mergedPr),
      // Live claim = an OPEN PR/MR for this issue, OR a local/remote claim branch,
      // OR an active CoS agent — any means "still being worked".
      hasLiveClaim: Boolean(openPr) || liveClaimNums.has(num),
      hasActiveAgent: activeAgentIssueNums.has(num),
    };
  });
  return { forge: state.forge, fullName: state.fullName, issues };
}

/**
 * Full reconcile: gather → classify → split. Returns the zombie set (for the
 * coordinator agent) plus stalled/live for reporting. Pure-ish (delegates all
 * I/O to gatherIssueState).
 *
 * @param {string} [repoPath=PATHS.root]
 * @param {{ activeAgentIssueNums?: Set<number> }} [opts]
 * @returns {Promise<{ forge:string, fullName:string, zombies:object[], stalled:object[], live:object[] }|null>}
 *   null on unsupported remote (not GitHub/GitLab) / transient forge failure
 *   (skip, don't park).
 */
export async function reconcile(repoPath = PATHS.root, { activeAgentIssueNums = new Set() } = {}) {
  const gathered = await gatherIssueState(repoPath, { activeAgentIssueNums });
  if (!gathered) return null;
  const classified = classifyIssues(gathered.issues);
  return {
    forge: gathered.forge,
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
 * Order-independent (sorted). Forge-agnostic (issue numbers + merged change #).
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
 * mechanics + per-forge CLI command table live once in the prompt template. Only
 * the dynamic `forge` + `autoClose` directives are surfaced here (the template
 * can't know them), as header lines rather than repeated per issue.
 * @param {object[]} zombies
 * @param {{ fullName:string, forge?:string, autoClose:boolean }} ctx
 * @returns {string}
 */
export function formatZombiesForPrompt(zombies, { fullName, forge = 'github', autoClose }) {
  const isGitlab = forge === 'gitlab';
  const change = isGitlab ? 'MR' : 'PR';
  const lines = [
    `Forge: **${isGitlab ? 'GitLab (use `glab`)' : 'GitHub (use `gh`)'}**. Repo: \`${fullName}\`. Zombie issues to reconcile (${zombies.length}):`,
    '',
    autoClose
      ? '**autoClose is ON** — apply the full partial-ship hybrid below (close + file a scoped follow-up when the remainder is separable; otherwise comment + release the claim).'
      : '**autoClose is OFF** — never close an issue or file a follow-up. Only post a `Done ✓ / Remaining ▢` comment and release the `in-progress` claim so the queue re-picks it.',
    '',
  ];
  for (const z of zombies) {
    const pr = z.mergedPr
      ? `merged ${change} #${z.mergedPr.number}${z.mergedPr.url ? ` (${z.mergedPr.url})` : ''}`
      : `a merged ${change}`;
    lines.push(`### #${z.number} — ${z.title}`);
    if (z.url) lines.push(`- Issue: ${z.url}`);
    lines.push(`- Shipped by: ${pr}`);
    lines.push('');
  }
  return lines.join('\n');
}
