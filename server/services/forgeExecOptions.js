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
import { resolveForgeForRepo } from './forgeAuth.js';

/**
 * The `{ cwd, env }` overlay for running `gh` against `repoPath` as the account
 * that repo actually needs, rather than whichever login gh's mutable `hosts.yml`
 * currently calls active.
 *
 * This is the shape every polling job that reads a MANAGED APP's repo must use.
 * Without it, an app whose repo lives under a different GitHub account than the
 * ambient login permanently 404s on a private repo (`Could not resolve to a
 * Repository` is GitHub's no-access 404), once per scheduler tick, forever —
 * #7540. It bites even with no `forgeAccount` pinned, because
 * `resolveForgeForRepo` already owner-matches against the locally logged-in
 * accounts; the explicit pin then covers the rest.
 *
 * Never throws: an unresolvable repo degrades to the ambient env, which is
 * exactly the behavior every caller had before threading this through.
 * `customEnv` is null when nothing was overlaid, so a caller can pass the
 * overlay to `ensureForgeReachable` only when there is one.
 *
 * @param {string|null} repoPath - Repo (or worktree) root; null/absent = ambient
 * @param {object} [opts]
 * @param {string|null} [opts.forgeAccount] - The app record's explicit pin
 * @returns {Promise<{cwd: string|undefined, env: object, customEnv: object|null}>}
 */
export async function resolveForgeExecOptions(repoPath, { forgeAccount = null } = {}) {
  const forgeAuth = repoPath
    ? await resolveForgeForRepo(repoPath, { forgeAccount }).catch(() => null)
    : null;
  const customEnv = forgeAuth?.env && forgeAuth.env !== process.env ? forgeAuth.env : null;
  return { cwd: repoPath || undefined, env: customEnv || process.env, customEnv };
}
