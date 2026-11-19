/**
 * Forge-agnostic "what change request exists for this branch" lookup.
 *
 * Extracted out of `agentRepoStateVerification.js`'s `probePr` (#5876) so a
 * second caller — the merge-gate contract check in `agentTuiSpawning.js`,
 * which asks the same question BEFORE that module's post-teardown audit runs
 * — shares one definition instead of re-deriving the tri-state contract.
 */

import * as git from './git.js';
import { execGit } from '../lib/execGit.js';
import { safeJSONParse } from '../lib/jsonIo.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';

// `resolveForgeForRepo` spawns `git remote get-url` + `gh auth status` + `gh
// auth token` with no internal timeout, so a stalled `gh` (network / keychain
// hang) must not hold a caller open indefinitely.
const FORGE_RESOLVE_TIMEOUT_MS = 10000;

// The timer is cleared once the race settles: an uncleared one keeps the event
// loop hot for its full duration after the forge has already answered, which on
// a teardown path delays the process that is trying to finish.
const withTimeout = (promise, ms, fallback) => {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/** The repo's forge CLI + credential overlay, or null when it cannot be resolved. */
const resolveForge = (sourceWorkspace) => withTimeout(
  git.resolveForgeForRepo(sourceWorkspace).catch(() => null),
  FORGE_RESOLVE_TIMEOUT_MS,
  null
);

/**
 * Resolve the open (or merged/closed) pull/merge request for `branchName`.
 *
 * Every field is tri-state: `readable: false` means the lookup itself could
 * not be completed (no forge CLI resolvable, or the forge call failed) — not
 * "no PR exists". `prState: null` with `readable: true` means the forge was
 * asked and answered "none" for this branch.
 *
 * @param {string} sourceWorkspace - a git working directory with the remote
 *   configured (a worktree qualifies — it shares its parent's git config).
 * @param {string} branchName
 * @param {{cli: string, env: object|null}|null} [resolvedForge] - a forge a
 *   delegating caller already resolved, so the `gh auth` probe chain runs once.
 * @returns {Promise<{prState: string|null, prUrl: string|null, prNumber: number|string|null, prHead: string|null, cli: string|null, readable: boolean}>}
 */
export async function probePrForBranch(sourceWorkspace, branchName, resolvedForge = null) {
  const forge = resolvedForge || await resolveForge(sourceWorkspace);
  if (!forge?.cli) return { prState: null, prUrl: null, prNumber: null, cli: null, readable: false };
  const { cli, env } = forge;
  const found = cli === 'glab'
    ? await (await import('./gitlab.js')).findMergeRequestForBranch(branchName, sourceWorkspace)
      .catch(() => ({ status: 'unavailable' }))
    : await (await import('./github.js')).findPullRequestForBranch(branchName, { cwd: sourceWorkspace, env: env || null })
      .catch(() => ({ status: 'unavailable' }));
  if (found.status === 'unavailable') return { prState: null, prUrl: null, prNumber: null, cli, readable: false };
  // `none` is a real answer, not a gap — callers that need "the agent never
  // opened one" distinguished from "we couldn't ask" read `readable` for that.
  if (found.status !== 'found') return { prState: null, prUrl: null, prNumber: null, cli, readable: true };
  // A remote handoff — GitHub auto-merge or a server pending-merge receipt
  // (#12247) — cannot cover local commits the agent never published.
  const open = cli === 'gh' && String(found.detail || '').toUpperCase() === 'OPEN';
  const localHead = open
    ? await execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], sourceWorkspace)
      .then(result => result.exitCode === 0 ? result.stdout.trim().toLowerCase() : null).catch(() => null)
    : null;
  const published = !!localHead && localHead === String(found.headRefOid || '').toLowerCase();
  const mergeHandoffQueued = published && !!found.url
    && await (await import('./cos/cosMergeHandoff.js')).hasQueuedMergeHandoff({ prUrl: found.url, prBranch: branchName, headSha: localHead })
      .catch(() => false);
  return {
    prState: found.detail ? String(found.detail).toUpperCase() : null,
    prUrl: found.url || null,
    // The forge's own identifier for the change request — a GitLab `glab mr
    // merge` line needs the IID, and emitting a literal `<iid>` placeholder
    // hands a caller a command it cannot run.
    prNumber: found.number ?? null,
    prHead: typeof found.headRefOid === 'string' && found.headRefOid ? found.headRefOid.toLowerCase() : null,
    cli,
    readable: !!found.detail,
    ...(published && found.autoMergeEnabled === true ? { autoMergeEnabled: true } : {}),
    ...(mergeHandoffQueued ? { mergeHandoffQueued: true } : {}),
    ...(typeof found.mergedAt === 'string' && Number.isFinite(Date.parse(found.mergedAt)) ? { mergedAt: found.mergedAt } : {}),
  };
}

/**
 * Was this branch delivered? Returns the local branch tip (lowercase SHA) only
 * when the forge reports its pull/merge request MERGED at exactly that commit,
 * else null. An empty branch trivially "contains" its base, so local ancestry
 * alone cannot answer this; an unreadable forge, no PR, or later local commits
 * all answer null. Callers bind the answer to this SHA, not to the branch name.
 */
export async function readMergedPrTip(sourceWorkspace, branchName) {
  const local = await execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], sourceWorkspace, { ignoreExitCode: true })
    .then(result => result.exitCode === 0 ? result.stdout.trim().toLowerCase() : null).catch(() => null);
  return local && await isMergedPrHead(sourceWorkspace, branchName, local) ? local : null;
}

/**
 * Did the forge deliver `branchName` at exactly `head`? The merged-checkout
 * disposal predicate every retirement path shares: a checkout whose branch PR is
 * MERGED at the observed head is disposable, so its uncommitted and untracked
 * files never hold it. Bound to the SHA, not the branch name — a later local
 * commit, an unreadable forge, or no PR all answer false.
 */
async function probeMergedHead(sourceWorkspace, branchName, head) {
  const observed = String(head || '').toLowerCase();
  if (!observed || !branchName) return null;
  // Awaited without `resolveForge`'s abandon-on-timeout race: removal follows this
  // answer, so no forge lookup may still be running git in the checkout afterwards.
  const forge = await git.resolveForgeForRepo(sourceWorkspace).catch(() => null);
  if (!forge?.cli) return null;
  const probe = await probePrForBranch(sourceWorkspace, branchName, forge).catch(() => null);
  return isExactMergedPrHead(probe, observed) ? probe : null;
}

/** The same forge observation can be used for cleanup without a second probe. */
export function isExactMergedPrHead(probe, head) {
  return probe?.readable === true && probe.prState === 'MERGED'
    && typeof head === 'string' && head.length > 0
    && probe.prHead === head.toLowerCase();
}

export async function isMergedPrHead(sourceWorkspace, branchName, head) {
  return (await probeMergedHead(sourceWorkspace, branchName, head)) != null;
}

/**
 * Read ONE change request's state, by its forge-native number.
 *
 * The truth `probePrForBranch` cannot give a caller that already knows WHICH
 * change request it means: a branch lookup answers with the most recent PR on
 * that branch, and a reused branch makes that a different one. Same tri-state
 * discipline — `readable: false` is "we could not ask", never "not merged".
 *
 * GitHub answers by number directly. GitLab has no by-IID state read wired here,
 * so it goes through the branch lookup and the IID is CROSS-CHECKED: a mismatch
 * means the branch's newest MR is not the one asked about, which is unreadable
 * rather than an answer about the wrong MR.
 *
 * @param {string} sourceWorkspace - a git working directory with the remote configured
 * @param {{ number: number, branch: string }} target
 * @returns {Promise<{ prState: string|null, cli: string|null, readable: boolean }>}
 *   `prState` is upper-cased (`MERGED` / `OPEN` / `CLOSED`) when `readable`, and
 *   is named to match `probePrForBranch` so both results read the same way.
 */
export async function probeChangeRequestState(sourceWorkspace, { number, branch } = {}) {
  const unreadable = (cli = null) => ({ prState: null, cli, readable: false });
  // `Number(null)` is 0 and `Number.isSafeInteger(0)` is true, so the positivity
  // check is what keeps a missing number from being asked about as PR #0.
  const id = Number(number);
  if (!sourceWorkspace || !Number.isSafeInteger(id) || id <= 0) return unreadable();
  const forge = await resolveForge(sourceWorkspace);
  if (!forge?.cli) return unreadable();
  const { cli, env } = forge;
  if (cli === 'glab') {
    const probe = await probePrForBranch(sourceWorkspace, branch, forge);
    if (!probe.readable || Number(probe.prNumber) !== id) return unreadable(cli);
    return { prState: probe.prState, cli, readable: true };
  }
  const { getPullRequestState } = await import('./github.js');
  const view = await getPullRequestState(String(id), { cwd: sourceWorkspace, env: env || null })
    .catch(() => ({ status: 'unavailable', state: null }));
  if (view.status !== 'known' || !view.state) return unreadable(cli);
  return { prState: view.state, cli, readable: true };
}

/**
 * Read one pull request's `gh pr view --json` fields through the single path every
 * orchestration caller shares, so exec options, backoff and parsing never diverge.
 *
 * Returns `{ view, reason }`: `view` is the parsed plain object, or null with a
 * `reason` ('gh-failed' detail text, or 'unparseable') when the forge could not
 * be read. The gh read and parse never throw; a credential failure while
 * resolving the repo's forge account still propagates, because an unavailable
 * pin must never degrade into running as gh's active login.
 *
 * Callers pass either `repoPath` (+ `forgeAccount`) to have the forge options
 * resolved here, or an already-resolved `cwd`/`env`. `repoSpec` adds `--repo` and
 * keys the shared gh backoff; a PR URL carries its own repo, so the backoff key
 * is derived from it when no spec is given. `execGh` is an injection seam for
 * suites that stub the gh runner.
 *
 * @param {string|number} prRef - PR number or URL
 * @param {string|string[]} fields - `--json` field list
 * @param {{ repoPath?: string|null, repoSpec?: string|null, forgeAccount?: string|null, timeoutMs?: number, cwd?: string|null, env?: object|null, execGh?: Function }} [opts]
 * @returns {Promise<{ view: object|null, reason: string|null }>}
 */
export async function readPullRequestOutcome(prRef, fields, { repoPath = null, repoSpec = null, forgeAccount = null, timeoutMs, cwd = null, env = null, execGh = null } = {}) {
  const exec = execGh || (await import('./github.js')).execGh;
  const options = repoPath ? await resolveForgeExecOptions(repoPath, { forgeAccount }) : { cwd, env };
  const ref = String(prRef);
  const fromUrl = parsePullRequestUrl(ref);
  const backoffKey = repoSpec || (fromUrl ? `${fromUrl.host}/${fromUrl.owner}/${fromUrl.repo}` : null);
  const args = ['pr', 'view', ref, ...(repoSpec ? ['--repo', repoSpec] : []), '--json', [].concat(fields).join(',')];
  const raw = await exec(args, timeoutMs, { cwd: options.cwd, env: options.env, ...(backoffKey ? { backoffKey } : {}) })
    .catch(err => err);
  if (raw instanceof Error) return { view: null, reason: raw.message };
  const view = safeJSONParse(raw, null);
  return view && typeof view === 'object' && !Array.isArray(view)
    ? { view, reason: null }
    : { view: null, reason: 'gh returned unparseable output' };
}

/** The parsed pull request, or null when it could not be read (callers map null to their own fail-closed reason). */
export async function readPullRequest(prRef, fields, opts) {
  return (await readPullRequestOutcome(prRef, fields, opts)).view;
}

/**
 * Is this view an open, same-repository PR (not a fork's) at `branch` and `head`?
 * A branch or head left undefined is not compared, so a caller with a separate
 * refusal reason for "held" vs "head moved" calls it twice. Drafts are refused
 * unless `allowDraft`, for callers whose field list never fetched `isDraft`.
 */
export function isOpenSameRepoPr(view, { branch, head, allowDraft = false } = {}) {
  return view?.state === 'OPEN' && view.isCrossRepository === false
    && (allowDraft || view.isDraft === false)
    && (branch === undefined || view.headRefName === branch)
    && (head === undefined || view.headRefOid === head);
}
