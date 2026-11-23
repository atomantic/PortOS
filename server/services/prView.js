/**
 * The single `gh pr view --json` reader every orchestration caller shares.
 *
 * A leaf below both `git.js` and `prProbe.js`: `prProbe.js` imports `git.js`,
 * so `git.js` reading a merged PR through it was a lazy import back up that
 * held both in one CI-selection cycle (#12285, #17499). `prProbe.js`
 * re-exports these for its existing callers.
 */

import { safeJSONParse } from '../lib/jsonIo.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';

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
