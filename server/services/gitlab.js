import { spawn } from '../lib/childProcess.js';

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
 * @param {string[]} args - glab arguments (e.g. ['issue', 'list', '-F', 'json'])
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
 * @returns {Promise<{ status: 'found'|'none'|'unavailable', number: number|null, url: string|null, detail: string|null }>}
 */
export async function findMergeRequestForBranch(branch, cwd) {
  if (!branch || !cwd) return { status: 'unavailable', number: null, url: null, detail: 'no branch or repo path' };
  const raw = await execGlab(['mr', 'list', '--source-branch', branch, '--all', '-P', '1', '-F', 'json'], cwd);
  if (raw === null) return { status: 'unavailable', number: null, url: null, detail: 'glab call failed' };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  // A zero-exit glab that emitted nothing parseable told us nothing.
  if (!Array.isArray(parsed)) return { status: 'unavailable', number: null, url: null, detail: 'glab returned unparseable output' };
  const mr = parsed[0];
  if (!mr) return { status: 'none', number: null, url: null, detail: null };
  return { status: 'found', number: mr.iid ?? null, url: mr.web_url || null, detail: mr.state || null };
}
