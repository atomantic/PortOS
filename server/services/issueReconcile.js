/**
 * Issue Reconciler — deterministic core.
 *
 * Finds ZOMBIE issues: open + `in-progress` (claimed-and-being-worked) yet with
 * their linked PR/MR already MERGED and NO live claim anywhere (no open PR/MR, no
 * local/remote/CoS claim branch, no active CoS agent). A zombie is an issue a
 * partial ship left stranded — the claim queue skips `in-progress`, so its
 * remaining scope is never re-picked and never finished.
 *
 * Forge-agnostic: the same scan runs over GitHub (`gh` issues + PRs), GitLab
 * (`glab` issues + merge requests), and JIRA (the PortOS JIRA API). The GitHub /
 * GitLab forge is resolved from the app's git `origin` host (github.* → GitHub,
 * gitlab.* → GitLab); any other remote returns null (skip/park). The pure
 * classifier, ref matchers, and convergence signature are shared — only the
 * effectful state gatherer differs per forge, and each normalizes into one common
 * `{ number, title, url, labels, assignees }` issue shape + `{ number,
 * headRefName, body, url }` change shape so the merge/classify logic never
 * branches on forge.
 *
 * JIRA is materially different and is NEVER auto-selected from the git host — it
 * requires explicit per-app config (`app.jira` + `workTracker: 'jira'`), so it is
 * routed in via the `jira` option (mirroring `resolveAppWorkTracker`) rather than
 * an origin-host lookup. Its "zombie" is STATUS-based, not label-based: JIRA has no
 * `in-progress` label to release, so a ticket left **In Review** with no live claim
 * is the shipped-but-stranded signal (the analog of a merged PR). Only In-Progress-
 * category tickets are scanned — **To Do** (not started) and **Done** (terminal,
 * the human closed it out) are excluded so the scan converges.
 * The live-claim guard is keyed on the ticket KEY (`claim/<KEY>` / `cos/…/<KEY>/…`
 * refs, local AND remote) so an open MR still under review — whose claim branch is
 * still present — reads as LIVE, while a merged-and-deleted branch reads as a
 * zombie. The deterministic scan is status + git-ref only (no forge CLI, no
 * dev-panel PR lookup); the coordinator reads the ticket + its linked MR/PR live to
 * confirm remaining scope before healing. JIRA tickets normalize into the SAME
 * common shape (KEY → `number`, `status` carried for the signature).
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
import { fetchMyCurrentSprintTickets } from './jira.js';
import { getOriginInfo, readOriginRemoteUrl } from '../lib/gitRemote.js';
import { hostToWorkTracker, hostFromOriginUrl, githubRepoSpec } from '../lib/workTracker.js';
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
 * Extract the JIRA ticket KEY a git ref claims, or null. JIRA claim branches use
 * the ticket KEY directly (no `issue-` prefix), so — unlike the distinctive
 * `issue-<num>` token — the parser must anchor on the CLAIM CONVENTION itself, not
 * merely on "a segment shaped like a key". Otherwise an unrelated branch that
 * happens to end in a key (`wip/PROJ-42`, `feat/PROJ-42`) would register a false
 * live-claim and suppress a genuine zombie forever. Recognizes exactly the two
 * conventions the claim-issue-jira flow creates:
 *   - human / TUI:   `claim/<KEY>`               (KEY immediately after `claim/`)
 *   - CoS sub-agent: `cos/<task>/<KEY>/<agent>`   (KEY as the segment after `cos/<task>/`)
 * A KEY looks like `PROJ-1234` (project code + `-` + number) and must be a whole
 * segment (terminated by `/` or end-of-ref). Remote-tracking refs
 * (`refs/remotes/origin/claim/<KEY>`) match the same way — the leading
 * `refs/…/origin/` is just more segments before `claim/`.
 * @param {string} refName
 * @returns {string|null}
 */
export function ticketKeyFromRef(refName) {
  const ref = refName || '';
  const claim = /(?:^|\/)claim\/([A-Z][A-Z0-9]+-\d+)(?=\/|$)/.exec(ref);
  if (claim) return claim[1];
  const cos = /(?:^|\/)cos\/[^/]+\/([A-Z][A-Z0-9]+-\d+)(?=\/|$)/.exec(ref);
  return cos ? cos[1] : null;
}

/**
 * Which JIRA tickets the scan even considers: only the **In Progress** status
 * CATEGORY — the "actively in the pipeline" bucket. This is the JIRA analog of
 * "OPEN + carries `in-progress`" on GitHub/GitLab:
 *   - **To Do** category = not started (never claimed) → never a candidate.
 *   - **Done** category = terminal (the human closed it out, like a CLOSED issue)
 *     → excluded so the scan CONVERGES; a Done ticket is not re-flagged forever.
 * The claim-issue-jira flow's success end-state is **In Review** (a sub-status of
 * the In Progress category — the human merges the MR + moves it to Done), so the
 * zombie lives entirely inside the In Progress category.
 * @param {{ statusCategory?:string }} ticket
 * @returns {boolean}
 */
export function isJiraStartedStatus({ statusCategory } = {}) {
  return statusCategory === 'In Progress';
}

/**
 * The JIRA "zombie" is STATUS-based, not label-based (JIRA has no `in-progress`
 * label to release). Within the In-Progress bucket, an **In Review** / **Code
 * Review** status is the shipped-but-not-closed signal — the analog of a merged PR
 * on an issue still carrying `in-progress`: the MR/PR shipped and moved the ticket
 * to review, but nobody closed it out and (per the live-claim guard) no branch
 * remains. A non-review In-Progress status (e.g. plain "In Progress") is NOT
 * shipped → it classifies STALLED, not ZOMBIE. Matched on the status NAME
 * (`isJiraStartedStatus` already constrained the category to In Progress).
 * @param {{ status?:string }} ticket
 * @returns {boolean}
 */
export function isJiraShippedStatus({ status } = {}) {
  return /review/i.test(status || '');
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
 * Every JIRA ticket KEY that has a LIVE claim ref (local OR remote). JIRA has no
 * PR/MR list in this deterministic scan (that's a live coordinator lookup), so the
 * git ref IS the live-claim signal: a `claim/<KEY>` branch (or `cos/…/<KEY>/…`)
 * still present means some machine is mid-claim OR an MR is still open under review
 * with its source branch intact — either way the ticket is NOT a zombie even though
 * its status is already "shipped". A merged-and-deleted branch leaves no ref, so a
 * genuinely stranded ticket surfaces. Returns a Set of uppercase KEY strings.
 * @param {string} repoPath
 * @returns {Promise<Set<string>>}
 */
async function getLiveClaimTicketKeys(repoPath) {
  const { stdout } = await execGit(
    ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/'],
    repoPath,
    { ignoreExitCode: true }
  ).catch(() => ({ stdout: '' }));
  const keys = new Set();
  for (const line of (stdout || '').split('\n')) {
    const key = ticketKeyFromRef(line.trim());
    if (key != null) keys.add(key);
  }
  return keys;
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
    labels: Array.isArray(issue.labels) ? issue.labels.map((l) => l.name).filter(Boolean) : [],
    assignees: Array.isArray(issue.assignees) ? issue.assignees.map((a) => a.login).filter(Boolean) : [],
  };
}

/**
 * Fetch issue/PR facts from GitHub, normalized to the common shape. Returns null
 * on any gh failure (degrade: the caller treats null as "nothing to reconcile /
 * transient"). `fullName` is resolved by the dispatcher, not re-queried here.
 * Unlike `getGitlabState`, this needs no `repoPath` — `gh` targets the repo via
 * `--repo <repoSpec>` rather than resolving from the working directory.
 * `repoSpec` is the host-qualified `HOST/OWNER/REPO` selector (mirroring
 * prWatcher) so gh targets enterprise repos correctly and stays deterministic on
 * a fork+upstream checkout; `fullName` is the plain `OWNER/REPO` for display.
 * @param {string} repoSpec - host-qualified `HOST/OWNER/REPO` selector for gh
 * @param {string} fullName - plain `OWNER/REPO`, returned for display/logging
 * @returns {Promise<{forge:'github', fullName:string, inProgress:object[], mergedPrs:object[], openPrs:object[]}|null>}
 */
async function getGithubState(repoSpec, fullName) {
  const [issuesRaw, mergedRaw, openRaw] = await Promise.all([
    execGh(['issue', 'list', '--repo', repoSpec, '--state', 'open',
      '--label', IN_PROGRESS_LABEL, '--limit', String(GH_LIST_LIMIT),
      '--json', 'number,title,labels,assignees,url']).catch(() => null),
    execGh(['pr', 'list', '--repo', repoSpec, '--state', 'merged',
      '--limit', String(GH_LIST_LIMIT),
      '--json', 'number,headRefName,body,url,mergedAt']).catch(() => null),
    execGh(['pr', 'list', '--repo', repoSpec, '--state', 'open',
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
 * Best-effort `group[/subgroup...]/project` display path from a GitLab origin
 * URL. Only cosmetic (it feeds the prompt header) — `glab` targets the project
 * from the repo cwd, not this string — so it degrades to the host classifier's
 * fullName or the raw origin URL rather than blocking the scan.
 */
function gitlabProjectPath(originUrl) {
  if (typeof originUrl !== 'string') return null;
  // scheme://[user@]host[:port]/<path>  OR  [user@]host:<path>  — capture <path>,
  // then strip a trailing `.git`.
  const m = originUrl.trim().match(/^[a-zA-Z][\w+.-]*:\/\/(?:[^/@]+@)?[^/]+\/(.+)$/)
    || originUrl.trim().match(/^(?:[^@/]+@)?[^/:]+:(.+)$/);
  return m ? m[1].replace(/\.git$/i, '').replace(/\/$/, '') : null;
}

/**
 * Resolve the app's forge from its git origin host and fetch the corresponding
 * state. github.* → GitHub, gitlab.* → GitLab; any other remote (or no origin)
 * returns null so the caller skips without parking.
 *
 * GitHub is resolved via `githubRepoSpec` (github.com AND enterprise github.*),
 * mirroring prWatcher — `getOriginInfo().isGithub` is github.com-only and
 * silently skipped enterprise repos. That helper also needs a parsed `owner/repo`
 * to build the host-qualified `--repo` selector. GitLab is classified
 * straight off the origin HOST via the
 * subgroup-safe `hostFromOriginUrl`, NOT `getOriginInfo().fullName`: the latter's
 * strict `owner/repo` parse returns null for a nested `group/subgroup/project`
 * remote (the common GitLab layout), which would silently skip the scan even
 * though `glab` resolves the project from the cwd regardless.
 * @param {string} repoPath
 * @returns {Promise<object|null>}
 */
async function getForgeState(repoPath) {
  const origin = await getOriginInfo(repoPath).catch(() => null);
  // GitHub (incl. enterprise): githubRepoSpec is the host-qualified
  // `HOST/OWNER/REPO` --repo selector (deterministic on fork+upstream checkouts),
  // or null when the origin isn't a resolvable GitHub repo.
  const githubSpec = githubRepoSpec(origin);
  if (githubSpec) return getGithubState(githubSpec, origin.fullName);

  // GitLab: classify off the host (subgroup-safe). `glab` is cwd-based, so a
  // display path is best-effort — prefer getOriginInfo's fullName, else derive the
  // full project path from the URL, else fall back to the host.
  const originUrl = await readOriginRemoteUrl(repoPath).catch(() => null);
  const host = origin?.host || hostFromOriginUrl(originUrl);
  if (hostToWorkTracker(host) === 'gitlab') {
    const displayName = origin?.fullName || gitlabProjectPath(originUrl) || host;
    return getGitlabState(repoPath, displayName);
  }
  return null;
}

/**
 * Fetch the JIRA sprint tickets for the app's configured project, normalized to
 * the same intermediate `inProgress` shape the forge gatherers produce — so the
 * common gather/classify path below is forge-agnostic. Unlike the forge gatherers,
 * there is no separate merged/open change list: JIRA's "shipped" signal is the
 * ticket STATUS (In Review), so each ticket carries `shipped` (isJiraShippedStatus)
 * instead of matching against a PR/MR list. Only In-Progress-category tickets are
 * returned (the analog of the `in-progress`-labeled issue set).
 *
 * Returns null on a transient fetch failure (skip, don't park) — `fetchMy…`
 * (the strict variant) throws rather than swallowing to [], so a JIRA blip can't
 * be misread as "no tickets" and park.
 * @param {string} repoPath  (unused — JIRA is app-config-routed, not cwd-routed)
 * @param {{ instanceId:string, projectKey:string }} jira
 * @returns {Promise<{forge:'jira', fullName:string, inProgress:object[]}|null>}
 */
async function getJiraState(_repoPath, jira) {
  const tickets = await fetchMyCurrentSprintTickets(jira.instanceId, jira.projectKey)
    .catch((err) => {
      console.warn(`⚠️ issue-reconcile JIRA fetch failed for ${jira.projectKey}: ${err.message}`);
      return null;
    });
  if (!Array.isArray(tickets)) return null;

  const inProgress = tickets
    .filter(isJiraStartedStatus)
    .map((t) => ({
      // KEY is the JIRA "number" — the whole shape stays common; it's a string here.
      number: t.key,
      title: t.summary || '',
      url: t.url || '',
      labels: [],
      assignees: [],
      status: t.status || '',
      shipped: isJiraShippedStatus(t),
    }));

  return { forge: 'jira', fullName: jira.projectKey, inProgress };
}

/**
 * Gather the raw facts for every actionable issue/ticket in the app's tracker.
 * Effectful (gh/glab/git for the forges; the PortOS JIRA API for JIRA). Returns
 * null on an unsupported remote (not GitHub/GitLab, no JIRA config) or a transient
 * failure so the scheduler can skip without parking.
 *
 * Routing mirrors `resolveAppWorkTracker`: JIRA is NEVER auto-selected from the git
 * host — it is chosen only when explicit `jira` config ({ instanceId, projectKey })
 * is passed in. Otherwise the GitHub/GitLab forge is resolved from the origin host.
 *
 * @param {string} repoPath
 * @param {{ activeAgentIssueNums?: Set<number|string>, jira?: { instanceId:string, projectKey:string } }} [ctx]
 *   `activeAgentIssueNums` — issue numbers / ticket KEYs an active CoS agent is
 *   currently claiming (from agent metadata); suppresses zombie classification for
 *   one whose agent is still running. `jira` — routes to the JIRA gatherer.
 * @returns {Promise<{forge:string, fullName:string, issues:object[]}|null>}
 */
export async function gatherIssueState(repoPath, { activeAgentIssueNums = new Set(), jira = null } = {}) {
  const isJira = Boolean(jira?.instanceId && jira?.projectKey);
  const [state, liveClaimIds] = await Promise.all([
    isJira ? getJiraState(repoPath, jira) : getForgeState(repoPath),
    isJira ? getLiveClaimTicketKeys(repoPath) : getLiveClaimIssueNums(repoPath),
  ]);
  if (!state) return null;

  const issues = state.inProgress.map((issue) => {
    const id = issue.number;
    // "shipped" analog: a merged PR/MR (forges) OR an In-Review status (JIRA).
    const mergedPr = isJira
      ? null
      : (state.mergedPrs.find((pr) => prReferencesIssue(pr, id)) || null);
    const openPr = isJira
      ? null
      : (state.openPrs.find((pr) => prReferencesIssue(pr, id)) || null);
    const hasMergedPr = isJira ? Boolean(issue.shipped) : Boolean(mergedPr);
    return {
      number: id,
      title: issue.title || '',
      url: issue.url || '',
      labels: Array.isArray(issue.labels) ? issue.labels : [],
      assignees: Array.isArray(issue.assignees) ? issue.assignees : [],
      // JIRA carries its status so the convergence signature (and the prompt) can
      // reflect it; forges leave it undefined.
      ...(isJira ? { status: issue.status || '' } : {}),
      mergedPr,
      hasMergedPr,
      // Live claim = an OPEN PR/MR (forges) OR a local/remote claim branch (all
      // trackers), OR an active CoS agent — any means "still being worked".
      hasLiveClaim: Boolean(openPr) || liveClaimIds.has(id),
      hasActiveAgent: activeAgentIssueNums.has(id),
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
 * @param {{ activeAgentIssueNums?: Set<number|string>, jira?: { instanceId:string, projectKey:string } }} [opts]
 * @returns {Promise<{ forge:string, fullName:string, zombies:object[], stalled:object[], live:object[] }|null>}
 *   null on unsupported remote (not GitHub/GitLab, no JIRA config) / transient
 *   failure (skip, don't park).
 */
export async function reconcile(repoPath = PATHS.root, { activeAgentIssueNums = new Set(), jira = null } = {}) {
  const gathered = await gatherIssueState(repoPath, { activeAgentIssueNums, jira });
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
 * Order-independent (sorted). Forge-agnostic: keys each zombie on its id + its
 * "shipped by" fact — the merged PR/MR number on the forges, or the ticket STATUS
 * on JIRA (which has no PR number here; a status change IS the progress signal).
 * @param {object[]} zombies
 * @returns {string}
 */
export function zombieSignature(zombies) {
  return zombies
    .map((z) => `${z.number}:${z.mergedPr?.number ?? (z.status || 'none')}`)
    .sort()
    .join('|');
}

/**
 * Render the JIRA zombie set into the coordinator prompt body. JIRA is
 * status-based (no PR number here, no `in-progress` label): each zombie is a
 * ticket left In Review with no live claim, and healing moves through the PortOS
 * JIRA API (transitions + `POST tickets`) rather than a forge CLI.
 */
function formatJiraZombiesForPrompt(zombies, { fullName, projectKey, instanceId, autoClose }) {
  const lines = [
    `Tracker: **JIRA (use the PortOS JIRA API)**. Project: \`${projectKey || fullName}\`` +
      (instanceId ? ` on instance \`${instanceId}\`` : '') +
      `. Zombie tickets to reconcile (${zombies.length}):`,
    '',
    'A JIRA zombie is a ticket left **In Review** whose MR/PR already merged (or was abandoned) with real scope REMAINING and NO live `claim/<KEY>` branch anywhere. JIRA has no `in-progress` label to release, so the ticket STATUS is the claim marker.',
    '',
    autoClose
      ? '**autoClose is ON** — apply the full partial-ship hybrid: when the remainder is SEPARABLE, transition the original to Done with a `Done ✓ / Remaining ▢` comment and file ONE scoped follow-up ticket (POST /api/jira/instances/<instanceId>/tickets) whose description carries `Refs <KEY>`; when it is a CONTINUATION, transition the ticket BACK to a not-started status (To Do / Selected for Development) with the same comment so the claim queue re-picks it.'
      : '**autoClose is OFF** — never transition a ticket to Done and never file a follow-up. Only post a `Done ✓ / Remaining ▢` comment and transition the ticket BACK to a not-started status so the queue re-picks it.',
    '',
  ];
  for (const z of zombies) {
    lines.push(`### ${z.number} — ${z.title}`);
    if (z.url) lines.push(`- Ticket: ${z.url}`);
    lines.push(`- Current status: ${z.status || 'In Review'} (shipped — verify the linked MR/PR live before acting)`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Render the zombie set into the coordinator prompt body (injected as
 * `{zombieIssues}`). The per-issue entries stay factual; the partial-ship
 * mechanics + per-forge CLI command table live once in the prompt template. Only
 * the dynamic `forge` + `autoClose` directives are surfaced here (the template
 * can't know them), as header lines rather than repeated per issue.
 *
 * JIRA delegates to `formatJiraZombiesForPrompt` — its heal path (status
 * transitions + `POST tickets`) is materially different from the gh/glab CLI table.
 * @param {object[]} zombies
 * @param {{ fullName:string, forge?:string, autoClose:boolean, projectKey?:string, instanceId?:string }} ctx
 * @returns {string}
 */
export function formatZombiesForPrompt(zombies, { fullName, forge = 'github', autoClose, projectKey, instanceId }) {
  if (forge === 'jira') {
    return formatJiraZombiesForPrompt(zombies, { fullName, projectKey, instanceId, autoClose });
  }
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
