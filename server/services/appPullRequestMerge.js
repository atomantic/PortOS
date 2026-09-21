/**
 * Direct PR/MR merge for a managed app's Pull Requests tab.
 *
 * Every other row action queues a CoS agent. This one deliberately does not:
 * it runs the forge CLI's own merge and reports the outcome, for the case where
 * the user has already read the change and just wants the button GitHub/GitLab
 * would have given them — no agent, no model spend, no review loop.
 *
 * The merge METHOD is never silently substituted. Squash and merge-commit are
 * different histories, so a project that forbids the chosen one gets an
 * explained refusal naming the alternatives rather than a quiet swap.
 */

import { execGh } from './github.js';
import { execGlab } from './gitlab.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { resolveAppForgeTarget } from '../lib/workTracker.js';
import { PROTECTED_BRANCHES } from '../lib/gitArgs.js';

export const MERGE_METHODS = Object.freeze(['merge', 'squash', 'rebase']);
export const DEFAULT_MERGE_METHOD = 'merge';

// A merge can sit behind the forge's own mergeability recompute; the list
// timeouts are tuned for reads and are too tight for a write that lands commits.
const MERGE_TIMEOUT_MS = 120_000;

// gh answers a forbidden method with GraphQL prose ("Squash merges are not
// allowed on this repository", "This branch can't be rebased"); glab answers a
// forbidden squash with its own. Recognized only to turn a cryptic CLI dump into
// "pick another method" — never to pick one automatically.
const METHOD_REFUSED = /not allowed|cannot be rebased|can't be rebased|only fast-forward/i;

// glab renamed this flag across versions (`--when-pipeline-succeeds` →
// `--auto-merge`), and an unknown flag is a hard exit, not a warning.
const GLAB_UNKNOWN_FLAG = /unknown flag|unknown shorthand/i;

const GLAB_METHOD_ARGS = { merge: [], squash: ['--squash'], rebase: ['--rebase'] };

/**
 * Whether this request may be merged at all. Both forges refuse a draft, so the
 * tab does not offer the action on one and the route refuses it — the rule lives
 * here, with the merge, rather than only in the door it happens to arrive at.
 *
 * Conflicts and pending checks deliberately do NOT gate it: the row already
 * shows them, and hiding the action there would remove the only way to merge a
 * request whose non-required check never reports.
 *
 * @param {object} pullRequest - a listed row
 * @returns {boolean}
 */
export const isDirectlyMergeablePullRequest = pullRequest => pullRequest?.isDraft !== true;

// A release-shaped request's head is a LONG-LIVED branch (PortOS ships
// `main → release`), so an unconditional delete there deletes `main`. An
// unreadable head counts as long-lived: never delete a branch we cannot name.
const isLongLivedSourceBranch = (headBranch, baseBranch) => {
  const head = String(headBranch || '').trim();
  return !head || PROTECTED_BRANCHES.includes(head) || head === String(baseBranch || '').trim();
};

const classifyFailure = detail => ({
  ok: false,
  code: METHOD_REFUSED.test(detail) ? 'method-not-allowed' : 'merge-failed',
  error: detail,
});

async function mergeGithubCore({ cwd, env, repoSpec, number, method, deleteBranch, timeoutMs, expectedHeadSha }) {
  const args = ['pr', 'merge', String(number)];
  // A `repoSpec` puts gh in `--repo` remote mode; omitting it runs the merge
  // against whatever repo `cwd` is already checked out to (the automated
  // sweep's mode — no forge read needed to name the repo it is already in).
  if (repoSpec) args.push('--repo', repoSpec);
  args.push(`--${method}`);
  // `--repo` mode: `--delete-branch` deletes the REMOTE branch only — it never
  // runs a local checkout in the user's working tree. Local mode: it deletes
  // the branch in `cwd`'s checkout, same as `gh pr merge` does unassisted.
  if (deleteBranch) args.push('--delete-branch');
  if (expectedHeadSha) args.push('--match-head-commit', expectedHeadSha);

  const error = await execGh(args, timeoutMs, { cwd, env }).then(() => null, err => err);
  return error ? classifyFailure(error.ghStderr || error.message || 'gh pr merge failed') : { ok: true };
}

async function mergeGitlabCore({ cwd, env, number, method, deleteBranch, timeoutMs }) {
  const tail = [...GLAB_METHOD_ARGS[method], ...(deleteBranch ? ['--remove-source-branch'] : [])];
  const run = args => execGlab(args, cwd, timeoutMs, { env, rejectOnError: true })
    .then(() => null, err => err);

  // glab has historically defaulted to "merge when the pipeline succeeds", which
  // would leave the request open and make this button silently mean something
  // else. Ask for an immediate merge; drop the flag on a glab that renamed it
  // rather than failing the merge over its spelling.
  let error = await run(['mr', 'merge', String(number), '--yes', '--when-pipeline-succeeds=false', ...tail]);
  if (error && GLAB_UNKNOWN_FLAG.test(error.message || '')) {
    error = await run(['mr', 'merge', String(number), '--yes', ...tail]);
  }
  return error ? classifyFailure(error.message || 'glab mr merge failed') : { ok: true };
}

/**
 * The one caller of `gh pr merge` / `glab mr merge`. Dir/target-shaped rather
 * than app-shaped, so both the direct-merge button (`--repo` remote mode,
 * whichever method the user picked) and the automated merge sweep (local
 * checkout mode, gh only, hardcoded `--merge --delete-branch`) share the same
 * argv construction and forge-failure classification (issue #7580).
 *
 * `timeoutMs` is intentionally NOT defaulted here: `mergeAppPullRequest` passes
 * `MERGE_TIMEOUT_MS`, but `git.js#mergePR` omits it so `execGh`'s own default
 * keeps applying — changing that default is not this function's call.
 *
 * @param {object} options
 * @param {string} [options.cwd] - working directory `gh`/`glab` runs in
 * @param {object} [options.env] - resolved forge env (owner-pinned token, etc.)
 * @param {'github'|'gitlab'} options.forge
 * @param {string|null} [options.repoSpec] - `OWNER/REPO` for gh's `--repo` remote mode; null runs against `cwd`'s local checkout
 * @param {number|string} options.number
 * @param {'merge'|'squash'|'rebase'} [options.method='merge']
 * @param {boolean} [options.deleteBranch=false]
 * @param {string|null} [options.expectedHeadSha] - GitHub commit required at merge time
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok:boolean, code?:string, error?:string}>}
 */
export async function runForgeMerge({ cwd, env, forge, repoSpec = null, number, method = DEFAULT_MERGE_METHOD, deleteBranch = false, timeoutMs, expectedHeadSha = null } = {}) {
  if (expectedHeadSha !== null && (forge !== 'github' || typeof expectedHeadSha !== 'string' || !/^[a-f0-9]{40}$/i.test(expectedHeadSha))) {
    return { ok: false, code: 'invalid-head', error: 'A GitHub merge requires an exact reviewed head commit' };
  }
  if (!MERGE_METHODS.includes(method)) {
    return { ok: false, code: 'invalid-method', error: `Unsupported merge method '${method}'` };
  }
  return forge === 'gitlab'
    ? mergeGitlabCore({ cwd, env, number, method, deleteBranch, timeoutMs })
    : mergeGithubCore({ cwd, env, repoSpec, number, method, deleteBranch, timeoutMs, expectedHeadSha });
}

/**
 * Merge one open request on the app's forge, directly.
 *
 * `deletedBranch` is the answer, not the request: asking to delete a long-lived
 * source branch merges without deleting it rather than refusing the merge.
 *
 * @param {object} app - managed app record (needs `repoPath`)
 * @param {object} pullRequest - the freshly re-read row being merged
 * @param {object} [options]
 * @param {'merge'|'squash'|'rebase'} [options.method='merge']
 * @param {boolean} [options.deleteBranch=false] - delete the source branch, unless it is long-lived
 * @returns {Promise<{ok:boolean, code?:string, error?:string, method?:string, deletedBranch?:boolean}>}
 */
export async function mergeAppPullRequest(app, pullRequest, { method = DEFAULT_MERGE_METHOD, deleteBranch = false } = {}) {
  if (!MERGE_METHODS.includes(method)) {
    return { ok: false, code: 'invalid-method', error: `Unsupported merge method '${method}'` };
  }
  if (!isDirectlyMergeablePullRequest(pullRequest)) {
    return { ok: false, code: 'draft', error: `Request #${pullRequest.number} is a draft` };
  }
  const { target } = await resolveAppForgeTarget(app);
  if (!target) {
    return { ok: false, code: 'unsupported-forge', error: "This app's git origin is not a GitHub or GitLab repository" };
  }
  if (target.forge !== 'gitlab' && !target.repoSpec) {
    return { ok: false, code: 'unsupported-forge', error: "This app's GitHub origin could not be resolved to an OWNER/REPO" };
  }

  // Same owner-pinned gh environment the listing uses: an app whose repo belongs
  // to a different logged-in account 404s without it (#7540).
  const { cwd, env } = await resolveForgeExecOptions(app.repoPath, { forgeAccount: app.forgeAccount });
  const deleting = deleteBranch && !isLongLivedSourceBranch(pullRequest.headBranch, pullRequest.baseBranch);
  const result = await runForgeMerge({
    cwd,
    env,
    forge: target.forge,
    repoSpec: target.repoSpec,
    number: pullRequest.number,
    method,
    deleteBranch: deleting,
    timeoutMs: MERGE_TIMEOUT_MS,
  });
  if (!result.ok) return result;

  console.log(`🔀 Merged ${target.forge === 'gitlab' ? 'MR' : 'PR'} #${pullRequest.number} for app ${app.id} via ${method}${deleting ? ' (source branch deleted)' : ''}`);
  return { ok: true, method, deletedBranch: deleting };
}
