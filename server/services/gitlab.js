import { spawn } from '../lib/childProcess.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { GLAB_JSON_ARGS, withGlabJson } from '../lib/glabArgs.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';

// Mirrors execGh's timeout: a stalled glab (hung keychain prompt, dead VPN) would
// otherwise wedge the scheduled job and agent finalization (#3358).
const DEFAULT_EXEC_GLAB_TIMEOUT_MS = 60000;

/**
 * Execute a `glab` CLI command via spawn (no shell). Unlike `execGh`, takes an explicit
 * `cwd`: glab resolves the project from the git `origin` remote there. Resolves to trimmed
 * stdout, or `null` on ANY failure (callers treat null as "unavailable / transient");
 * `rejectOnError` opts into rejection with the stderr contract. JSON callers should use
 * `execGlabJson`; this is for non-JSON mutations (see `blockedIssueReconcile.js`).
 *
 * @param {string[]} args - glab arguments (e.g. ['issue', 'list', '--output', 'json'])
 * @param {string} cwd - repo root the glab command runs in
 * @param {number} [timeoutMs] - kills the child and resolves null past this
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - Explicit forge credentials/environment
 * @param {boolean} [options.rejectOnError=false] - Reject with stderr/timeout detail instead of resolving null
 * @returns {Promise<string|null>}
 */
export function execGlab(args, cwd, timeoutMs = DEFAULT_EXEC_GLAB_TIMEOUT_MS, { env = null, rejectOnError = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('glab', args, { cwd, shell: false, env: withSpawnCwdEnv(env || process.env, cwd) });
    let stdout = '';
    let stderr = '';
    let settled = false;
    // One settle path so the timer is always cleared and can't re-settle after `close`.
    const done = (value, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && rejectOnError) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      // setTimeout callback boundary — a kill() throw here would be uncaught.
      try { child.kill('SIGKILL'); } catch (err) { console.error(`❌ execGlab: failed to kill timed-out 'glab ${args.join(' ')}': ${err.message}`); }
      console.error(`❌ execGlab: 'glab ${args.join(' ')}' timed out after ${timeoutMs}ms`);
      done(null, new Error(`glab command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) done(stdout.trim());
      else done(null, new Error(stderr.trim() || `glab exited with code ${code}`));
    });
    child.on('error', (err) => done(null, new Error(`glab not available: ${err.message}`)));
  });
}

/**
 * Run a `glab … list` command and parse its JSON array into three answers:
 * `ok` (`rows` is the possibly-empty array), `cli-failed` (could not ask: non-zero exit,
 * unauthenticated, not installed, timeout), `not-json` (exit 0 but not an array, meaning
 * glab's output flags moved (lib/glabArgs.js), not that the user is logged out).
 * `reason` is only meaningful when `rows` is null. `args` must NOT carry an output flag.
 *
 * @param {string[]} args - glab arguments without the JSON output flag
 * @param {string} cwd - repo root the glab command runs in
 * @param {number} [timeoutMs]
 * @returns {Promise<{rows: object[]|null, reason: 'ok'|'cli-failed'|'not-json'}>}
 */
export async function execGlabJson(args, cwd, timeoutMs = DEFAULT_EXEC_GLAB_TIMEOUT_MS) {
  const raw = await execGlab(withGlabJson(args), cwd, timeoutMs);
  if (raw === null) return { rows: null, reason: 'cli-failed' };
  // The `null` default is load-bearing: safeJSONParse salvages an array from noisy output
  // only when the default IS an array, and would turn glab's human table into a
  // trustworthy-looking empty list.
  const rows = safeJSONParse(raw, null);
  if (Array.isArray(rows)) return { rows, reason: 'ok' };
  console.error(`❌ execGlabJson: 'glab ${args.join(' ')}' exited 0 without JSON — glab's output flags have changed; check 'glab ${args.slice(0, 2).join(' ')} --help'`);
  return { rows: null, reason: 'not-json' };
}

/**
 * Does a merge request exist for `branch`? Mirror of `github.js#findPullRequestForBranch`
 * (#3358) with three answers: `found`, `none`, `unavailable` (we could not ask; collapsing
 * it into `none` would record a run that opened no MR as a success). `--all` widens past
 * the opened-only default: a closed MR still proves the agent reached the forge.
 *
 * @param {string} branch - source branch name
 * @param {string} cwd - repo root (glab resolves the project from its cwd)
 * @returns {Promise<{ status: 'found'|'none'|'unavailable', number: number|null, url: string|null, body: string|null, detail: string|null }>}
 */
export async function findMergeRequestForBranch(branch, cwd, { includeDraft = false } = {}) {
  if (!branch || !cwd) return { status: 'unavailable', number: null, url: null, detail: 'no branch or repo path' };
  const { rows, reason } = await execGlabJson(['mr', 'list', '--source-branch', branch, '--all', '-P', '1'], cwd);
  // A zero-exit glab with nothing parseable is also "could not ask".
  if (!rows) {
    const detail = reason === 'not-json' ? 'glab returned unparseable output' : 'glab call failed';
    return { status: 'unavailable', number: null, url: null, detail };
  }
  const mr = rows[0];
  if (!mr) return { status: 'none', number: null, url: null, detail: null };
  const mergedAt = typeof mr.merged_at === 'string' && Number.isFinite(Date.parse(mr.merged_at)) ? mr.merged_at : null;
  return {
    status: 'found',
    number: mr.iid ?? null, url: mr.web_url || null, body: typeof mr.description === 'string' ? mr.description : null,
    detail: mr.state || null, headRefOid: typeof mr.sha === 'string' ? mr.sha : null,
    headBranch: mr.source_branch, baseBranch: mr.target_branch,
    sameRepository: Number.isSafeInteger(mr.source_project_id) && mr.source_project_id > 0 && mr.source_project_id === mr.target_project_id,
    ...(mergedAt ? { mergedAt } : {}), ...(includeDraft ? { isDraft: mr.draft === true || mr.work_in_progress === true } : {}),
  };
}

/**
 * Read ONE merge request's state by iid (mirror of `github.js#getPullRequestState`).
 * `known` is a real forge answer; `unavailable` means we could not ask and must never be
 * read as "not merged". `glab mr view` answers a single object, so this uses `execGlab` +
 * `safeJSONParse` rather than the array-only `execGlabJson`.
 *
 * @param {number|string} mrIid - the project-local MR iid
 * @param {string} cwd - repo root glab resolves the project from
 * @returns {Promise<{ status: 'known'|'unavailable', state: string|null, detail: string|null }>}
 *   `state` is upper-cased (`MERGED` / `OPENED` / `CLOSED`) when status is `known`.
 */
export async function getMergeRequestState(mrIid, cwd) {
  if (!mrIid || !cwd) return { status: 'unavailable', state: null, detail: 'no MR reference or repo path' };
  const raw = await execGlab(['mr', 'view', String(mrIid), ...GLAB_JSON_ARGS], cwd).catch(() => null);
  if (raw === null) return { status: 'unavailable', state: null, detail: 'glab call failed' };
  const parsed = safeJSONParse(raw, null);
  const state = typeof parsed?.state === 'string' && parsed.state.trim() ? parsed.state.toUpperCase() : null;
  // Exit-0 with nothing parseable told us nothing.
  if (!state) return { status: 'unavailable', state: null, detail: 'glab returned unparseable output' };
  return { status: 'known', state, detail: null };
}
