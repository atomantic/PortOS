import { spawn } from 'child_process';

/**
 * Execute a `glab` CLI command safely using spawn (no shell — injection-proof).
 *
 * Unlike `execGh` (github.js), this takes an explicit `cwd`: `glab` resolves the
 * target project from the repo's git `origin` remote in the working directory, so
 * it MUST run inside the repo checkout. Resolves to trimmed stdout on success and
 * `null` on ANY failure (non-zero exit, spawn error, glab not installed) — callers
 * treat null as "unavailable / transient", mirroring the `.catch(() => null)`
 * pattern used around `execGh`.
 *
 * @param {string[]} args - glab arguments (e.g. ['issue', 'list', '-F', 'json'])
 * @param {string} cwd - repo root the glab command runs in
 * @returns {Promise<string|null>}
 */
export function execGlab(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('glab', args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    // We never surface glab's stderr to the caller (a failed call resolves to null
    // via the exit code), but stderr MUST still be drained — an unread pipe can
    // fill its buffer and block the child on a chatty warning.
    child.stderr.on('data', () => {});
    child.on('close', (code) => resolve(code === 0 ? stdout.trim() : null));
    child.on('error', () => resolve(null));
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
