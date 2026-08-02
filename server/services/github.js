import { spawn } from 'child_process';
import { join } from 'path';
import { atomicWrite, readJSONFile, PATHS, ensureDir, safeJSONParse } from '../lib/fileUtils.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { ServerError } from '../lib/errorHandler.js';
import { getSettings, updateSettings } from './settings.js';

const DATA_DIR = PATHS.data;
const REPOS_FILE = join(DATA_DIR, 'github-repos.json');
const CONCURRENCY = 3;

let cache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000;

const defaultData = () => ({
  repos: {},
  secrets: {},
  lastRepoSync: null,
  githubUser: 'atomantic'
});

async function load() {
  const now = Date.now();
  if (cache && (now - cacheTimestamp) < CACHE_TTL_MS) return cache;
  await ensureDir(DATA_DIR);
  cache = await readJSONFile(REPOS_FILE, defaultData());
  cacheTimestamp = now;
  return cache;
}

async function save(data) {
  await ensureDir(DATA_DIR);
  await atomicWrite(REPOS_FILE, JSON.stringify(data, null, 2) + '\n');
  cache = data;
  cacheTimestamp = Date.now();
}

const DEFAULT_EXEC_GH_TIMEOUT_MS = 60000;

/**
 * Execute a gh CLI command safely using spawn. `gh` hits the network, so a
 * stalled call (bad credentials prompt, hung network) would otherwise leave
 * the returned promise pending forever and wedge scheduled jobs (prWatcher,
 * issueReconcile, branchReconcile, updateChecker) while orphaning the child
 * process. `timeoutMs` kills the child and rejects with a clear error; it's
 * cleared on normal exit so it never fires for a completed run.
 */
export function execGh(args, timeoutMs = DEFAULT_EXEC_GH_TIMEOUT_MS, { cwd = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      shell: false,
      windowsHide: true,
      ...(cwd ? { cwd, env: withSpawnCwdEnv(process.env, cwd) } : {})
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // setTimeout callback boundary — guard so a kill() throw can't crash
      // the process (e.g. the child already exited between checks).
      try { child.kill('SIGKILL'); } catch (err) { console.error(`❌ execGh: failed to kill timed-out 'gh ${args.join(' ')}': ${err.message}`); }
      reject(new Error(`gh ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `gh exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });
    child.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run tasks with limited concurrency
 */
async function runWithConcurrency(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

/**
 * Sync repos from GitHub using gh CLI
 */
export async function syncRepos() {
  const data = await load();
  const owner = data.githubUser || 'atomantic';
  const raw = await execGh([
    'repo', 'list', owner, '--limit', '200',
    '--json', 'name,nameWithOwner,description,pushedAt,isArchived,isPrivate,isFork,parent,licenseInfo'
  ]);
  const remoteRepos = JSON.parse(raw);

  // Build set of remote repo names to detect deletions
  const remoteNames = new Set();

  for (const repo of remoteRepos) {
    const fullName = repo.nameWithOwner;
    remoteNames.add(fullName);
    const existing = data.repos[fullName] || {};
    data.repos[fullName] = {
      name: repo.name,
      fullName,
      description: repo.description || '',
      isArchived: repo.isArchived,
      isPrivate: repo.isPrivate,
      isFork: repo.isFork,
      forkSource: repo.parent ? `${repo.parent.owner.login}/${repo.parent.name}` : null,
      pushedAt: repo.pushedAt,
      license: repo.licenseInfo?.name || null,
      flags: existing.flags || {},
      managedSecrets: existing.managedSecrets || [],
      lastSecretSync: existing.lastSecretSync || null
    };
  }

  // Remove repos that no longer exist on GitHub
  const removed = Object.keys(data.repos).filter(name => !remoteNames.has(name));
  for (const name of removed) {
    delete data.repos[name];
  }

  data.lastRepoSync = new Date().toISOString();
  await save(data);
  const removedMsg = removed.length ? `, removed ${removed.length} deleted` : '';
  console.log(`🔄 Synced ${remoteRepos.length} repos from GitHub${removedMsg}`);
  return data;
}

/**
 * Get cached repo list
 */
export async function getRepos() {
  const data = await load();
  return data.repos;
}

/**
 * Update repo flags and managed secrets
 */
export async function updateRepoFlags(fullName, updates) {
  const data = await load();
  const repo = data.repos[fullName];
  if (!repo) throw new ServerError(`Repo not found: ${fullName}`, { status: 404, code: 'REPO_NOT_FOUND' });

  if (updates.flags) {
    repo.flags = { ...repo.flags, ...updates.flags };

    // Auto-manage NPM_TOKEN based on npmProject flag
    if (updates.flags.npmProject === true && !repo.managedSecrets.includes('NPM_TOKEN')) {
      repo.managedSecrets.push('NPM_TOKEN');
    } else if (updates.flags.npmProject === false) {
      repo.managedSecrets = repo.managedSecrets.filter(s => s !== 'NPM_TOKEN');
    }
  }

  if (updates.managedSecrets) {
    repo.managedSecrets = updates.managedSecrets;
  }

  await save(data);
  return repo;
}

/**
 * Set a secret value and sync to all repos with it in managedSecrets
 */
export async function setSecret(name, value) {
  // Store value in settings.json (never returned to client)
  const settings = await getSettings();
  const secrets = settings.secrets || {};
  secrets[name] = value;
  await updateSettings({ secrets });

  // Update metadata in github-repos.json
  const data = await load();
  data.secrets[name] = {
    hasValue: true,
    updatedAt: new Date().toISOString()
  };
  await save(data);

  // Sync to repos
  const result = await syncSecretToRepos(name);
  return result;
}

/**
 * Sync a secret to all repos that have it in managedSecrets
 */
export async function syncSecretToRepos(name) {
  const settings = await getSettings();
  const value = settings.secrets?.[name];
  if (!value) throw new ServerError(`No value stored for secret: ${name}`, { status: 400, code: 'SECRET_NOT_CONFIGURED' });

  const data = await load();
  const targetRepos = Object.values(data.repos).filter(
    r => r.managedSecrets.includes(name) && !r.isArchived
  );

  if (targetRepos.length === 0) {
    return { synced: 0, failed: 0, errors: [] };
  }

  let synced = 0;
  let failed = 0;
  const errors = [];
  const succeeded = new Set();

  const tasks = targetRepos.map(repo => async () => {
    const result = await syncOneSecret(name, value, repo.fullName);
    if (result.success) {
      synced++;
      succeeded.add(repo.fullName);
    } else {
      failed++;
      errors.push({ repo: repo.fullName, error: result.error });
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY);

  // Update last sync timestamp only on repos where sync succeeded
  for (const fullName of succeeded) {
    if (data.repos[fullName]) {
      data.repos[fullName].lastSecretSync = new Date().toISOString();
    }
  }
  await save(data);

  console.log(`🔑 Secret ${name} synced to ${synced} repos (${failed} failed)`);
  return { synced, failed, errors };
}

/**
 * Sync a single secret to a single repo via stdin pipe
 */
function syncOneSecret(name, value, fullName) {
  return new Promise((resolve) => {
    const child = spawn('gh', ['secret', 'set', name, '--repo', fullName], {
      shell: false,
      windowsHide: true
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr.trim() || `exit code ${code}` });
      }
    });
    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
    child.stdin.write(value);
    child.stdin.end();
  });
}

/**
 * Archive or unarchive a repo on GitHub
 */
export async function setRepoArchived(fullName, archived) {
  const cmd = archived ? 'archive' : 'unarchive';
  await execGh(['repo', cmd, fullName, '--yes']);

  // Update local cache
  const data = await load();
  if (data.repos[fullName]) {
    data.repos[fullName].isArchived = archived;
    await save(data);
  }

  console.log(`📦 ${archived ? 'Archived' : 'Unarchived'} ${fullName}`);
  return data.repos[fullName] || { fullName, isArchived: archived };
}

/**
 * Get secret metadata (no values)
 */
export async function getSecrets() {
  const data = await load();
  return data.secrets;
}

/**
 * Get sync status summary
 */
export async function getStatus() {
  const data = await load();
  const repos = Object.values(data.repos);
  return {
    lastRepoSync: data.lastRepoSync,
    totalRepos: repos.length,
    activeRepos: repos.filter(r => !r.isArchived).length,
    npmProjects: repos.filter(r => r.flags?.npmProject).length,
    reposWithSecrets: repos.filter(r => r.managedSecrets?.length > 0).length,
    secretCount: Object.keys(data.secrets).length
  };
}

// --- Forge (gh CLI) reachability -------------------------------------------
//
// Roughly thirty call sites across PortOS run `gh` and swallow the failure into
// an empty result (`.catch(() => [])`). That collapses "the forge said there is
// nothing" into "we could not ask the forge" — the exact conflation the root
// CLAUDE.md's sentinel-and-validate rule exists to prevent. In practice it means
// a `gh` that cannot reach api.github.com is indistinguishable from a quiet
// repo: prWatcher sees no PRs, branchReconcile sees no branches, and an agent
// told to open a PR reports success having opened nothing.
//
// This probe answers the question those call sites cannot: is `gh` actually
// usable right now, and if not, which of the three failure modes is it? Callers
// stay unchanged — the value is that the state is *reportable* (see the `forge`
// block on GET /api/system/health/details) instead of silently absent.

const GH_PROBE_TIMEOUT_MS = 10000;
const GH_HEALTH_TTL_MS = 60000;

// Matched against `gh`'s stderr. Auth is checked first: an unauthenticated `gh`
// can still reach the network, and its message is the more actionable one.
const GH_AUTH_MARKERS = [
  'not logged in',
  'authentication required',
  'requires authentication',
  'bad credentials',
  'gh auth login',
  'no such host: authentication'
];

// A blocked or broken transport. `bad file descriptor` belongs here because an
// outbound-filtering firewall (Little Snitch and friends) denies the connect()
// rather than refusing it, and Go surfaces that as EBADF — which reads like a
// local bug unless it is named as a network failure.
const GH_NETWORK_MARKERS = [
  'dial tcp',
  'bad file descriptor',
  'no such host',
  'connection refused',
  'connection reset',
  'network is unreachable',
  'i/o timeout',
  'timed out',
  'tls handshake',
  'certificate'
];

const includesAny = (haystack, needles) => needles.some(n => haystack.includes(n));

/**
 * Classify a `gh` probe result. Split out from the spawn so the mapping from
 * failure text to status is testable without a network or a `gh` binary.
 *
 * @param {{ code?: number|null, stderr?: string, spawnError?: Error|null }} probe
 * @returns {{ status: 'ok'|'not-installed'|'not-authenticated'|'unreachable'|'error', detail: string|null }}
 */
export function classifyGhProbe({ code = null, stderr = '', spawnError = null } = {}) {
  if (spawnError) {
    // ENOENT is the only spawn error that reliably means "no binary on PATH";
    // anything else (EACCES, EPERM) is a real local fault worth reporting as-is.
    const status = spawnError.code === 'ENOENT' ? 'not-installed' : 'error';
    return { status, detail: spawnError.message || String(spawnError) };
  }
  if (code === 0) return { status: 'ok', detail: null };

  const text = String(stderr || '').trim();
  const lower = text.toLowerCase();
  if (includesAny(lower, GH_AUTH_MARKERS)) return { status: 'not-authenticated', detail: text || null };
  if (includesAny(lower, GH_NETWORK_MARKERS)) return { status: 'unreachable', detail: text || null };
  return { status: 'error', detail: text || `gh exited with code ${code}` };
}

/**
 * Human-readable remedy for a given probe status. Kept beside the classifier so
 * the message and the state it describes cannot drift apart.
 */
export function ghRemedy(status) {
  switch (status) {
    case 'not-installed':
      return 'Install the GitHub CLI (brew install gh) to let PortOS read pull requests and issues.';
    case 'not-authenticated':
      return 'Run `gh auth login` — PortOS can reach GitHub but has no usable credential.';
    case 'unreachable':
      return 'gh cannot open an outbound connection. If an outbound firewall (e.g. Little Snitch) is installed, allow the gh binary to reach api.github.com — a denied connect surfaces as "bad file descriptor".';
    case 'error':
      return 'gh failed for an unrecognised reason — run `gh api rate_limit` in a terminal to see the full output.';
    default:
      return null;
  }
}

let ghHealthCache = null;
let ghHealthCheckedAt = 0;

function probeGh(timeoutMs) {
  return new Promise((resolve) => {
    // `rate_limit` is authenticated, cheap, and — unlike every other endpoint —
    // does not itself consume quota, so polling this probe is free.
    const child = spawn('gh', ['api', 'rate_limit'], { shell: false, windowsHide: true });
    let stderr = '';
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => {
      // setTimeout callback boundary — a kill() throw here would be uncaught.
      try { child.kill('SIGKILL'); } catch (err) { console.error(`❌ gh health probe: failed to kill child: ${err.message}`); }
      done({ code: null, stderr: `gh api rate_limit timed out after ${timeoutMs}ms`, spawnError: null });
    }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => done({ code: null, stderr, spawnError: err }));
    child.on('close', (code) => done({ code, stderr, spawnError: null }));
  });
}

/**
 * Probe whether `gh` can actually talk to the forge right now.
 *
 * Result is cached for a minute — /api/system/health/details is polled, and the
 * probe spawns a process. Pass `{ force: true }` to bypass the cache.
 *
 * @returns {Promise<{ status: string, ok: boolean, detail: string|null, remedy: string|null, checkedAt: string }>}
 */
export async function checkGhHealth({ force = false, timeoutMs = GH_PROBE_TIMEOUT_MS } = {}) {
  const now = Date.now();
  if (!force && ghHealthCache && (now - ghHealthCheckedAt) < GH_HEALTH_TTL_MS) return ghHealthCache;

  const { status, detail } = classifyGhProbe(await probeGh(timeoutMs));
  ghHealthCache = {
    status,
    ok: status === 'ok',
    detail,
    remedy: ghRemedy(status),
    checkedAt: new Date(now).toISOString()
  };
  ghHealthCheckedAt = now;
  return ghHealthCache;
}

/** Test seam — drops the memoized probe result. */
export function __resetGhHealthCache() {
  ghHealthCache = null;
  ghHealthCheckedAt = 0;
}

/**
 * Gate for a forge-dependent scheduled job (#3358). Runs the probe and, when the
 * forge is NOT usable, emits ONE single-line error naming the job and the probe
 * status — then the caller skips the cycle instead of executing against a forge
 * it cannot read and concluding "everything is quiet".
 *
 * A probe that itself blows up is reported as `error` rather than silently
 * passing: "we could not even ask whether we can ask" is still not `ok`.
 *
 * @param {string} label - job name for the log line (e.g. 'pr-watcher')
 * @returns {Promise<{ ok: boolean, status: string, detail: string|null, remedy: string|null }>}
 */
export async function ensureForgeReachable(label) {
  const health = await checkGhHealth().catch(err => ({
    status: 'error', ok: false, detail: err.message, remedy: ghRemedy('error')
  }));
  if (health.ok) return health;
  const detail = health.detail ? ` — ${String(health.detail).split('\n')[0].slice(0, 160)}` : '';
  console.error(`❌ ${label}: skipping this cycle, gh is ${health.status}${detail}`);
  return health;
}

/**
 * Does a pull request exist for `branch`? Three answers, never collapsed to two
 * (#3358): `found` (the forge has one), `none` (the forge answered and has
 * none), `unavailable` (we could not ask). A caller must never read
 * `unavailable` as `none` — that is how a run that opened no PR gets recorded as
 * a success while `gh` is firewalled.
 *
 * `--state all` deliberately: a PR that was opened and then closed still proves
 * the agent DID reach the forge, which is the question being asked.
 *
 * @param {string} branch - head branch name
 * @param {{ cwd?: string }} [opts] - repo dir gh resolves the remote from
 * @returns {Promise<{ status: 'found'|'none'|'unavailable', number: number|null, url: string|null, detail: string|null }>}
 */
export async function findPullRequestForBranch(branch, { cwd = null } = {}) {
  if (!branch) return { status: 'unavailable', number: null, url: null, detail: 'no branch name' };
  const raw = await execGh(
    ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,state'],
    DEFAULT_EXEC_GH_TIMEOUT_MS,
    { cwd }
  ).catch(err => err);
  if (raw instanceof Error) {
    return { status: 'unavailable', number: null, url: null, detail: raw.message };
  }
  const parsed = safeJSONParse(raw, null);
  // A zero-exit gh that emitted nothing parseable told us nothing — that is
  // "could not ask", not "no PR".
  if (!Array.isArray(parsed)) {
    return { status: 'unavailable', number: null, url: null, detail: 'gh returned unparseable output' };
  }
  const pr = parsed[0];
  if (!pr) return { status: 'none', number: null, url: null, detail: null };
  return { status: 'found', number: pr.number ?? null, url: pr.url || null, detail: pr.state || null };
}
