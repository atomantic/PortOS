/**
 * Blocked-Issue Reconciler — deterministic core.
 *
 * The `blocked` label (portos-file-issue skill) covers two different reasons an
 * issue is parked: a step only a human can drive (hardware/credentials), or "a
 * genuine dependency on another unshipped issue/PR." Nothing removes the label
 * once the second case resolves — the claim queue (`NON_ACTIONABLE_ISSUE_LABELS`
 * in perpetualWork.js) skips every `blocked` issue regardless of *why* it is
 * blocked, so a dependency-blocked issue sits parked forever even after its
 * blocker ships.
 *
 * This scan finds open `blocked` issues whose body names its blocker(s) via a
 * `Blocked by #N[, #M ...]` line, checks whether every named blocker is closed,
 * and — only when ALL of them are — removes the `blocked` label and posts a
 * comment. An issue with no parsed blocker reference is left untouched: that is
 * the human/hardware case, and this scan draws no inference from silence.
 *
 * Forge-agnostic like issueReconcile.js: GitHub via `gh`, GitLab via `glab`,
 * resolved from the git origin host through `resolveRepoForgeTarget` /
 * `resolveAppForgeTarget`. The decision needs no judgment (a blocker is either
 * closed or it isn't), so — mirroring `releaseAbandonedClaims` in
 * issueReconcile.js — this is a pure deterministic write with no coordinator
 * agent and no LLM call.
 */

import { execGh, ensureForgeReachable } from './github.js';
import { createGithubActorTrust } from './forgeActorTrust.js';
import { execGlab, execGlabJson } from './gitlab.js';
import { withGlabJson } from '../lib/glabArgs.js';
import { resolveAppForgeTarget, resolveRepoForgeTarget } from '../lib/workTracker.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { normalizeIssueState } from '../lib/forgeIssueState.js';

export const BLOCKED_LABEL = 'blocked';

// GitHub lists at most this many open `blocked` issues — the same GH_LIST_LIMIT
// as issueReconcile.js. `gh issue list --limit` pages internally; a result that
// fills the cap is still not proof the list ended.
const GH_LIST_LIMIT = 200;
// Concurrent blocker lookups per batch — bounds spawned processes on either forge.
const LOOKUP_BATCH = 8;
// glab's practical max page. The blocked-issue walk continues until a short
// page and refuses a still-full page once GH_LIST_LIMIT rows are in hand.
const GL_PER_PAGE = 100;

/**
 * Parse the issue numbers named by a `Blocked by #N[, #M, ...]` line (an
 * optional leading bullet/dash and an optional trailing colon are tolerated),
 * case-insensitive. Returns a sorted, deduped array of positive integers, or
 * `[]` when the body names no blocker — that empty result is the signal this
 * scan leaves the issue alone; a human/hardware block has no dependency to
 * resolve, so absence of the trailer must never be read as "ready to unblock."
 *
 * Deliberately narrow: only text on a `Blocked by` line counts, not any `#N`
 * mention anywhere in the body — an ordinary cross-reference, `Related: #N`, or
 * `Refs #N` elsewhere in the issue must never be treated as a dependency this
 * scan can clear.
 * @param {string} body
 * @returns {number[]}
 */
export function parseBlockingIssueNumbers(body) {
  if (!body) return [];
  const nums = new Set();
  const lineRe = /^[ \t*-]*Blocked by:?\s*(.*)/gim;
  let line;
  while ((line = lineRe.exec(body))) {
    const numRe = /#(\d+)/g;
    let n;
    while ((n = numRe.exec(line[1]))) nums.add(Number(n[1]));
  }
  return [...nums].sort((a, b) => a - b);
}

/**
 * Resolve one GitHub blocker number to 'closed' or 'open'. `issues/{n}` serves
 * issues AND pull requests (they share a number space), at any age. A PR is
 * satisfied only once merged: closed-unmerged means the dependency was
 * abandoned, which needs a human rather than an automatic unblock. Returns
 * null when the lookup fails, so the number stays absent and reads as open.
 */
async function resolveGithubBlockerState({ repoSpec, apiHost, fullName }, number) {
  const raw = await execGh(['api', `repos/${fullName}/issues/${number}`, '--hostname', apiHost], undefined, { backoffKey: repoSpec }).catch((err) => {
    console.error(`❌ blocked-issue-reconcile: blocker lookup #${number} failed for ${repoSpec}: ${err.message}`);
    return null;
  });
  const blocker = safeJSONParse(raw, null);
  if (!blocker || typeof blocker !== 'object') return null;
  if (blocker.pull_request) return blocker.pull_request.merged_at ? 'closed' : 'open';
  return normalizeIssueState(blocker.state);
}

/**
 * Fetch GitHub's open `blocked` issues plus a `number → state` map covering
 * each distinct blocker they name, looked up individually so PR blockers and
 * blockers of any age resolve. Returns null on a gh failure listing the blocked
 * issues, or when that list fills the cap — the caller treats null as "skip
 * this cycle", never as "no blocked issues". A failed per-blocker lookup is
 * left out of the map (reads as open).
 * @returns {Promise<{ blocked: object[], stateByNumber: Map<number,string> }|null>}
 */
async function getGithubBlockedState(repoSpec, apiHost, fullName) {
  const forge = await ensureForgeReachable('blocked-issue-reconcile', { hostname: apiHost });
  if (!forge.ok) return null;

  const blockedRaw = await execGh(['issue', 'list', '--repo', repoSpec, '--state', 'open',
    '--label', BLOCKED_LABEL, '--limit', String(GH_LIST_LIMIT),
    '--json', 'number,title,body,url,author'], undefined, { backoffKey: repoSpec }).catch((err) => {
    console.error(`❌ blocked-issue-reconcile: gh issue list --label blocked failed for ${repoSpec}: ${err.message}`);
    return null;
  });

  const blocked = safeJSONParse(blockedRaw, null);
  if (!Array.isArray(blocked)) return null;
  // An empty list parsed fine: "no candidates", not "gh failed". A full page
  // is not the set — unblocking from it would miss a still-blocked issue.
  if (blocked.length >= GH_LIST_LIMIT) {
    console.warn(`⚠️ blocked-issue-reconcile: GitHub blocked-issue list is incomplete at the ${GH_LIST_LIMIT} cap — skipping this cycle`);
    return null;
  }

  const trust = await createGithubActorTrust({ runGh: execGh, host: apiHost, repoFullName: fullName });
  const trustedBlocked = [];
  for (const issue of blocked) {
    if (await trust.isTrusted(issue.author?.login)) trustedBlocked.push(issue);
  }
  const blockerNumbers = new Set(trustedBlocked.flatMap((i) => parseBlockingIssueNumbers(i.body)));
  const stateByNumber = new Map();
  const numbers = [...blockerNumbers];
  for (let i = 0; i < numbers.length; i += LOOKUP_BATCH) {
    await Promise.all(numbers.slice(i, i + LOOKUP_BATCH).map(async (n) => {
      const state = await resolveGithubBlockerState({ repoSpec, apiHost, fullName }, n);
      if (state) stateByNumber.set(n, state);
    }));
  }
  return {
    blocked: trustedBlocked.map((i) => ({ number: i.number, title: i.title || '', url: i.url || '', body: i.body || '' })),
    stateByNumber,
  };
}

/**
 * Open `blocked` issues, walked page by page. `--per-page` caps a page; a
 * short page is the end of the list. A still-full page at GH_LIST_LIMIT is
 * not the set, so the cycle skips instead of unblocking from a truncated page.
 * @returns {Promise<object[]|null>}
 */
async function listGitlabBlockedIssues(repoPath) {
  const blocked = [];
  const maxPages = Math.ceil(GH_LIST_LIMIT / GL_PER_PAGE);
  for (let page = 1; page <= maxPages; page += 1) {
    const { rows, reason } = await execGlabJson(
      ['issue', 'list', '--label', BLOCKED_LABEL, '--per-page', String(GL_PER_PAGE), '--page', String(page)],
      repoPath,
    );
    if (!Array.isArray(rows)) {
      console.error(`❌ blocked-issue-reconcile: glab issue list unavailable (${reason}) — skipping this cycle`);
      return null;
    }
    blocked.push(...rows);
    if (rows.length < GL_PER_PAGE) return blocked;
    if (blocked.length >= GH_LIST_LIMIT) break;
  }
  console.warn(`⚠️ blocked-issue-reconcile: GitLab blocked-issue list is incomplete at the ${GH_LIST_LIMIT} cap — skipping this cycle`);
  return null;
}

/**
 * One GitLab blocker, via `glab issue view`. `#N` is an issue, not a merge
 * request. A failed or unreadable view stays out of the map and reads as open.
 * @returns {Promise<'open'|'closed'|null>}
 */
async function resolveGitlabBlockerState(repoPath, number) {
  const raw = await execGlab(withGlabJson(['issue', 'view', String(number)]), repoPath);
  const issue = safeJSONParse(raw, null);
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)
    || !Number.isInteger(issue.iid) || issue.iid !== number) {
    console.error(`❌ blocked-issue-reconcile: GitLab blocker view #${number} unavailable — leaving it blocked`);
    return null;
  }
  return normalizeIssueState(issue.state);
}

/**
 * GitLab mirror of `getGithubBlockedState`. Blocker state comes from one view
 * per named issue — one `issue list` page is not the tracker's whole backlog.
 * @returns {Promise<{ blocked: object[], stateByNumber: Map<number,string> }|null>}
 */
async function getGitlabBlockedState(repoPath) {
  const blocked = await listGitlabBlockedIssues(repoPath);
  if (!blocked) return null;

  const blockerNumbers = [...new Set(blocked.flatMap((issue) => parseBlockingIssueNumbers(issue?.description)))];
  const stateByNumber = new Map();
  for (let i = 0; i < blockerNumbers.length; i += LOOKUP_BATCH) {
    await Promise.all(blockerNumbers.slice(i, i + LOOKUP_BATCH).map(async (number) => {
      const state = await resolveGitlabBlockerState(repoPath, number);
      if (state) stateByNumber.set(number, state);
    }));
  }
  return {
    blocked: blocked.map((i) => ({
      number: i.iid, title: i.title || '', url: i.web_url || '', body: i.description || '',
    })),
    stateByNumber,
  };
}

/**
 * Gather + classify: for every open `blocked` issue that names blocker(s) via
 * the `Blocked by #N` convention, check whether all of them are closed. Pure
 * classification over already-fetched state.
 * @param {object[]} blocked
 * @param {Map<number,string>} stateByNumber
 * @returns {object[]} entries with `blockingNumbers`, `closedBlockers`, `openBlockers` — only issues with at least one parsed blocker are included
 */
export function classifyBlockedIssues(blocked, stateByNumber) {
  return blocked
    .map((issue) => ({ ...issue, blockingNumbers: parseBlockingIssueNumbers(issue.body) }))
    .filter((issue) => issue.blockingNumbers.length > 0)
    .map((issue) => {
      const closedBlockers = issue.blockingNumbers.filter((n) => stateByNumber.get(n) === 'closed');
      // A blocker whose state could not be resolved (absent from the map) must
      // NOT read as closed — it stays in openBlockers, same absent-vs-false
      // discipline as issueReconcile's hasForeignClaim.
      const openBlockers = issue.blockingNumbers.filter((n) => stateByNumber.get(n) !== 'closed');
      return { number: issue.number, title: issue.title, url: issue.url, blockingNumbers: issue.blockingNumbers, closedBlockers, openBlockers };
    });
}

/**
 * Full gather + classify for one app's forge repo. Returns `{ forge, repoSpec,
 * fullName, ready }` where `ready` is every dependency-blocked issue whose
 * blockers are ALL closed — or null on an unsupported remote / transient
 * failure, so the caller skips this cycle without treating it as "nothing to
 * unblock".
 * @param {string} repoPath
 * @param {{ app?: object }} [opts]
 */
export async function gatherBlockedIssueState(repoPath, { app = null } = {}) {
  const target = app
    ? (await resolveAppForgeTarget(app, { repoPath })).target
    : await resolveRepoForgeTarget(repoPath);
  if (!target) return null;

  let state = null;
  if (target.forge === 'github') state = await getGithubBlockedState(target.repoSpec, target.apiHost, target.fullName);
  else if (target.forge === 'gitlab') state = await getGitlabBlockedState(repoPath);
  if (!state) return null;

  return {
    forge: target.forge,
    repoSpec: target.repoSpec ?? null,
    fullName: target.fullName,
    ready: classifyBlockedIssues(state.blocked, state.stateByNumber).filter((i) => i.openBlockers.length === 0),
  };
}

/**
 * Remove the `blocked` label (and post an explanatory comment first) on every
 * issue whose dependency is now fully resolved. The comment is posted BEFORE
 * the label removal so an unblock is never silent, mirroring
 * `releaseAbandonedClaims`; a failed comment does not block the removal.
 * @param {object[]} ready - from `gatherBlockedIssueState().ready`
 * @param {{ forge:string, repoSpec:string|null, fullName:string, repoPath:string }} ctx
 * @returns {Promise<number>} how many issues were actually unblocked
 */
export async function unblockIssues(ready, { forge, repoSpec, fullName, repoPath }) {
  if (!ready?.length) return 0;
  if (forge !== 'github' && forge !== 'gitlab') return 0;
  if (forge === 'github' && !repoSpec) return 0;

  let unblocked = 0;
  for (const issue of ready) {
    const number = String(issue.number);
    const blockersList = issue.closedBlockers.map((n) => `#${n}`).join(', ');
    const commentBody = `Unblocking: every issue named in \`Blocked by\` (${blockersList}) is now closed. Removing the \`${BLOCKED_LABEL}\` label so this rejoins the claim queue.`;

    let ok;
    if (forge === 'github') {
      await execGh(['issue', 'comment', number, '--repo', repoSpec, '--body', commentBody]).catch((err) => {
        console.error(`❌ blocked-issue-reconcile: could not comment on #${number} in ${fullName}: ${err.message}`);
      });
      ok = await execGh(['issue', 'edit', number, '--repo', repoSpec, '--remove-label', BLOCKED_LABEL])
        .then(() => true)
        .catch((err) => {
          console.error(`❌ blocked-issue-reconcile: could not unblock #${number} in ${fullName}: ${err.message}`);
          return false;
        });
    } else {
      const noted = await execGlab(['issue', 'note', number, '--message', commentBody], repoPath);
      if (noted === null) console.error(`❌ blocked-issue-reconcile: could not comment on #${number} in ${fullName}`);
      const result = await execGlab(['issue', 'update', number, '--unlabel', BLOCKED_LABEL], repoPath);
      ok = result !== null;
      if (!ok) console.error(`❌ blocked-issue-reconcile: could not unblock #${number} in ${fullName}`);
    }
    if (ok) {
      unblocked += 1;
      console.log(`🔓 blocked-issue-reconcile unblocked #${number} in ${fullName}: ${blockersList} closed`);
    }
  }
  return unblocked;
}
