/**
 * One concern: turn a managed app's repo path (+ optional gh account pin) into
 * the `{ cwd, env }` a `gh` invocation needs to authenticate as the account
 * that repo actually belongs to.
 *
 * Separate from `forgeAuth.js` (which it composes over) on purpose: the suites
 * that exercise the polling jobs mock `forgeAuth.js` wholesale, so a helper
 * living INSIDE it could only be tested against a re-implementation of itself.
 * Here, a suite mocks whichever of the two layers it is not exercising.
 */
import { ServerError } from '../lib/errorHandler.js';
import { resolveForgeForRepo } from './forgeAuth.js';

/**
 * The `{ cwd, env }` overlay for running `gh` against `repoPath` as the account
 * that repo needs, not gh's mutable active login (without it, a repo under a
 * different account 404s every tick, #7540).
 *
 * An unresolvable origin keeps the ambient env. Credential failures propagate:
 * an unavailable pin must never turn into execution as the active account.
 * `customEnv` is null when nothing was overlaid.
 *
 * @param {string|null} repoPath - Repo (or worktree) root; null/absent = ambient
 * @param {object} [opts]
 * @param {string|null} [opts.forgeAccount] - The app record's explicit pin
 * @returns {Promise<{cwd: string|undefined, env: object, customEnv: object|null}>}
 */
export async function resolveForgeExecOptions(repoPath, { forgeAccount = null } = {}) {
  if (!repoPath && forgeAccount) throw new ServerError('The pinned GitHub account requires a repository path.', {
    status: 409, code: 'FORGE_ACCOUNT_UNAVAILABLE',
  });
  const forgeAuth = repoPath
    ? await resolveForgeForRepo(repoPath, { forgeAccount })
    : null;
  const customEnv = forgeAuth?.env && forgeAuth.env !== process.env ? forgeAuth.env : null;
  return { cwd: repoPath || undefined, env: customEnv || process.env, customEnv };
}
