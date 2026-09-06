import { spawn } from '../lib/childProcess.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { withGlabJson } from '../lib/glabArgs.js';

// Mirrors execGh's DEFAULT_EXEC_GH_TIMEOUT_MS. `glab` hits the network, so a
// stalled call (hung keychain prompt, dead VPN) would otherwise leave the
// returned promise pending forever — wedging the scheduled job or, since #3358,
// the agent finalization that awaits an MR lookup before completing the run.
const DEFAULT_EXEC_GLAB_TIMEOUT_MS = 60000;

/**
 * Execute a `glab` CLI command safely using spawn (no shell — injection-proof).
 *
 * Unlike `execGh` (github.js), this takes an explicit `cwd`: `glab` resolves the
 * target project from the repo's git `origin` remote in the working directory, so
 * it MUST run inside the repo checkout. Resolves to trimmed stdout on success and
 * `null` on ANY failure (non-zero exit, spawn error, glab not installed, timeout)
 * — callers treat null as "unavailable / transient", mirroring the
 * `.catch(() => null)` pattern used around `execGh`.
 *
 * Most PortOS callers want JSON and go through `execGlabJson`, which owns the
 * output flag (see lib/glabArgs.js). This is exported for the genuine non-JSON
 * `glab` calls — mutations like `issue update --unlabel` / `issue note`, which
 * return human text on success (see `blockedIssueReconcile.js`).
 *
 * @param {string[]} args - glab arguments (e.g. ['issue', 'list', '--output', 'json'])
 * @param {string} cwd - repo root the glab command runs in
 * @param {number} [timeoutMs] - kills the child and resolves null past this
 * @returns {Promise<string|null>}
 */
export function execGlab(args, cwd, timeoutMs = DEFAULT_EXEC_GLAB_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn('glab', args, { cwd, shell: false });
    let stdout = '';
    let settled = false;
    // One settle path so the timeout can't resolve a promise `close` already
    // settled, and so the timer is always cleared.
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      // setTimeout callback boundary — a kill() throw here would be uncaught.
      try { child.kill('SIGKILL'); } catch (err) { console.error(`❌ execGlab: failed to kill timed-out 'glab ${args.join(' ')}': ${err.message}`); }
      console.error(`❌ execGlab: 'glab ${args.join(' ')}' timed out after ${timeoutMs}ms`);
      done(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    // We never surface glab's stderr to the caller (a failed call resolves to null
    // via the exit code), but stderr MUST still be drained — an unread pipe can
    // fill its buffer and block the child on a chatty warning.
    child.stderr.on('data', () => {});
    child.on('close', (code) => done(code === 0 ? stdout.trim() : null));
    child.on('error', () => done(null));
  });
}

/**
 * Run a `glab … list` command and parse its JSON array. Three answers, not two —
 * the absent-vs-empty split every caller needs (AGENTS.md):
 *
 *   - `ok`         — glab answered; `rows` is the (possibly empty) array.
 *   - `cli-failed` — we could not ask (non-zero exit: unauthenticated, no
 *                    network, `glab` not installed, timed out).
 *   - `not-json`   — glab answered at exit 0 with something that is not a JSON
 *                    array, which means its output flags moved (lib/glabArgs.js)
 *                    and NOT that the user is logged out. It gets its own reason
 *                    so callers stop sending a working CLI to re-authenticate.
 *
 * `reason` is only meaningful when `rows` is null. `args` must NOT carry an
 * output flag — this appends the one correct spelling.
 *
 * @param {string[]} args - glab arguments without the JSON output flag
 * @param {string} cwd - repo root the glab command runs in
 * @param {number} [timeoutMs]
 * @returns {Promise<{rows: object[]|null, reason: 'ok'|'cli-failed'|'not-json'}>}
 */
export async function execGlabJson(args, cwd, timeoutMs = DEFAULT_EXEC_GLAB_TIMEOUT_MS) {
  const raw = await execGlab(withGlabJson(args), cwd, timeoutMs);
  if (raw === null) return { rows: null, reason: 'cli-failed' };
  // The `null` default is load-bearing: safeJSONParse only applies its
  // salvage-an-array-from-noisy-output affordance when the default IS an array,
  // and that path yields `[]` for prose — so passing `[]` here would parse
  // glab's human table into a trustworthy-looking empty list, re-creating the
  // very bug this function exists to catch.
  const rows = safeJSONParse(raw, null);
  if (Array.isArray(rows)) return { rows, reason: 'ok' };
  console.error(`❌ execGlabJson: 'glab ${args.join(' ')}' exited 0 without JSON — glab's output flags have changed; check 'glab ${args.slice(0, 2).join(' ')} --help'`);
  return { rows: null, reason: 'not-json' };
}

/**
 * Does a merge request exist for `branch`? The GitLab mirror of
 * `github.js#findPullRequestForBranch` (#3358), with the same three answers
 * rather than two: `found`, `none` (glab answered, none exist), `unavailable`
 * (we could not ask). Collapsing the last into `none` is what lets a run that
 * opened no MR be recorded as a success.
 *
 * `--all` widens past glab's opened-only default: an MR that was opened and
 * later closed still proves the agent reached the forge, which is the question.
 *
 * @param {string} branch - source branch name
 * @param {string} cwd - repo root (glab resolves the project from its cwd)
 * @returns {Promise<{ status: 'found'|'none'|'unavailable', number: number|null, url: string|null, body: string|null, detail: string|null }>}
 */
export async function findMergeRequestForBranch(branch, cwd) {
  if (!branch || !cwd) return { status: 'unavailable', number: null, url: null, detail: 'no branch or repo path' };
  const { rows, reason } = await execGlabJson(['mr', 'list', '--source-branch', branch, '--all', '-P', '1'], cwd);
  // Both failure modes are "we could not ask" here — a zero-exit glab that
  // emitted nothing parseable told us nothing either.
  if (!rows) {
    const detail = reason === 'not-json' ? 'glab returned unparseable output' : 'glab call failed';
    return { status: 'unavailable', number: null, url: null, detail };
  }
  const mr = rows[0];
  if (!mr) return { status: 'none', number: null, url: null, detail: null };
  return { status: 'found', number: mr.iid ?? null, url: mr.web_url || null, body: typeof mr.description === 'string' ? mr.description : null, detail: mr.state || null };
}
