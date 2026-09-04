import { spawn } from '../lib/childProcess.js';
import { join } from 'path';
import { atomicWrite, readJSONFile, PATHS, ensureDir, safeJSONParse } from '../lib/fileUtils.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { ServerError } from '../lib/errorHandler.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createMutex } from '../lib/asyncMutex.js';
import { getSettings, updateSettings } from './settings.js';

const DATA_DIR = PATHS.data;
const REPOS_FILE = join(DATA_DIR, 'github-repos.json');
const CONCURRENCY = 3;
const GITHUB_HOST = 'github.com';
const GITHUB_ENV_TOKEN_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'];
const REPO_SYNC_LIMIT = 200;
const SECRET_SYNC_TIMEOUT_MS = 30000;
const queueDataWrite = createFileWriteQueue();
const withGitHubMutation = createMutex();

let cache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000;

const defaultData = () => ({
  repos: {},
  secrets: {},
  lastRepoSync: null,
  githubUser: null
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

/** Test seam — drops the short-lived persisted-data cache. */
export function __resetGitHubDataCache() {
  cache = null;
  cacheTimestamp = 0;
}

const DEFAULT_EXEC_GH_TIMEOUT_MS = 60000;
const githubDotComEnv = (baseEnv = process.env) => ({ ...baseEnv, GH_HOST: GITHUB_HOST });
const githubEnvironmentToken = (env = process.env) => (
  GITHUB_ENV_TOKEN_KEYS.map((key) => env[key]).find((value) => typeof value === 'string' && value.trim())?.trim() || null
);
const githubCredentialSource = (env = process.env) => (
  githubEnvironmentToken(env)
    ? 'env'
    : 'cli'
);
const githubPinnedEnv = (token, baseEnv = process.env) => {
  const env = githubDotComEnv(baseEnv);
  delete env.GITHUB_TOKEN;
  env.GH_TOKEN = token;
  return env;
};

const repoOwner = (fullName) => typeof fullName === 'string' ? fullName.split('/')[0] : null;
const repoBelongsToAccount = (repo, login) => (
  typeof login === 'string'
  && repoOwner(repo?.fullName)?.toLowerCase() === login.toLowerCase()
);
const reposForAccount = (data, login = data.githubUser) => Object.fromEntries(
  Object.entries(data.repos || {}).filter(([, repo]) => repoBelongsToAccount(repo, login))
);

/**
 * Execute a gh CLI command safely using spawn. `gh` hits the network, so a
 * stalled call (bad credentials prompt, hung network) would otherwise leave
 * the returned promise pending forever and wedge scheduled jobs (prWatcher,
 * issueReconcile, branchReconcile, updateChecker) while orphaning the child
 * process. `timeoutMs` kills the child and rejects with a clear error; it's
 * cleared on normal exit so it never fires for a completed run. `input`, when
 * supplied, is written to stdin (used by structured `gh api --input -` calls).
 */
export function execGh(args, timeoutMs = DEFAULT_EXEC_GH_TIMEOUT_MS, { cwd = null, env = null, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const operation = 'gh command';
    const baseEnv = env || process.env;
    const child = spawn('gh', args, {
      shell: false,
      ...(cwd ? { cwd, env: withSpawnCwdEnv(baseEnv, cwd) } : (env ? { env } : {}))
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // setTimeout callback boundary — guard so a kill() throw can't crash
      // the process (e.g. the child already exited between checks).
      try { child.kill('SIGKILL'); } catch (err) { console.error(`❌ execGh: failed to kill timed-out ${operation}: ${err.message}`); }
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(stderr.trim() || `gh exited with code ${code}`);
        error.ghExitCode = code;
        error.ghStderr = stderr.trim();
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
    child.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(err);
    });
    if (input !== null && input !== undefined) {
      child.stdin.on('error', (err) => {
        if (timedOut || err.code === 'EPIPE') return;
        clearTimeout(timer);
        reject(err);
      });
      child.stdin.end(String(input));
    }
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
  return withGitHubMutation(async () => {
    const auth = await getPinnedGitHubAuth();
    if (!auth.authenticated || !auth.login) {
      throw new ServerError(auth.remedy || 'Sign in to GitHub before syncing repositories.', {
        status: 401,
        code: 'GITHUB_NOT_AUTHENTICATED'
      });
    }
    const owner = auth.login;
    const raw = await execGh([
      'repo', 'list', owner, '--limit', String(REPO_SYNC_LIMIT),
      '--json', 'name,nameWithOwner,description,pushedAt,isArchived,isPrivate,isFork,parent,licenseInfo'
    ], DEFAULT_EXEC_GH_TIMEOUT_MS, { env: auth.env });
    const remoteRepos = JSON.parse(raw);
    const { data, removed, listingMayBeTruncated } = await queueDataWrite(async () => {
      const current = await load();
      const remoteNames = new Set();

      for (const repo of remoteRepos) {
        const fullName = repo.nameWithOwner;
        remoteNames.add(fullName);
        const existing = current.repos[fullName] || {};
        current.repos[fullName] = {
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

      const listingMayBeTruncated = remoteRepos.length >= REPO_SYNC_LIMIT;
      const removed = listingMayBeTruncated
        ? []
        : Object.entries(current.repos)
          .filter(([, repo]) => repoBelongsToAccount(repo, owner) && !remoteNames.has(repo.fullName))
          .map(([fullName]) => fullName);
      for (const fullName of removed) delete current.repos[fullName];

      current.lastRepoSync = new Date().toISOString();
      current.githubUser = owner;
      await save(current);
      return { data: current, removed, listingMayBeTruncated };
    });
    const removedMsg = removed.length ? `, removed ${removed.length} deleted` : '';
    console.log(`🔄 Synced ${remoteRepos.length} repos from GitHub${removedMsg}`);
    if (listingMayBeTruncated) {
      console.log(`⚠️ GitHub repo list reached ${REPO_SYNC_LIMIT}; unmatched cached repos were preserved`);
    }
    return {
      ...data,
      repos: reposForAccount(data, owner),
      truncated: listingMayBeTruncated,
    };
  });
}

async function requireActiveCachedAccount(data) {
  const auth = await getPinnedGitHubAuth();
  if (!auth.authenticated || !auth.login) {
    throw new ServerError(auth.remedy || 'Sign in to GitHub before changing repositories.', {
      status: 401,
      code: 'GITHUB_NOT_AUTHENTICATED'
    });
  }
  if (!data.githubUser || data.githubUser.toLowerCase() !== auth.login.toLowerCase()) {
    throw new ServerError('The cached repositories belong to a different GitHub account. Sync repositories before making changes.', {
      status: 409,
      code: 'GITHUB_ACCOUNT_MISMATCH'
    });
  }
  return auth;
}

/**
 * Get cached repo list
 */
export async function getRepos() {
  const data = await load();
  return reposForAccount(data);
}

/**
 * Update repo flags and managed secrets
 */
export async function updateRepoFlags(fullName, updates) {
  return queueDataWrite(async () => {
    const data = await load();
    const repo = data.repos[fullName];
    if (!repo || !repoBelongsToAccount(repo, data.githubUser)) {
      throw new ServerError(`Repo not found: ${fullName}`, { status: 404, code: 'REPO_NOT_FOUND' });
    }

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
  });
}

/**
 * Set a secret value and sync to all repos with it in managedSecrets
 */
export async function setSecret(name, value) {
  return withGitHubMutation(async () => {
    const accountData = await load();
    await requireActiveCachedAccount(accountData);

    // Store value in settings.json (never returned to client)
    const settings = await getSettings();
    const secrets = settings.secrets || {};
    secrets[name] = value;
    await updateSettings({ secrets });

    // Update metadata in github-repos.json
    await queueDataWrite(async () => {
      const data = await load();
      data.secrets[name] = {
        hasValue: true,
        updatedAt: new Date().toISOString()
      };
      await save(data);
    });

    return syncSecretToReposNow(name);
  });
}

/**
 * Sync a secret to all repos that have it in managedSecrets
 */
export async function syncSecretToRepos(name) {
  return withGitHubMutation(() => syncSecretToReposNow(name));
}

async function syncSecretToReposNow(name) {
  const data = await load();
  const auth = await requireActiveCachedAccount(data);
  const settings = await getSettings();
  const value = settings.secrets?.[name];
  if (!value) throw new ServerError(`No value stored for secret: ${name}`, { status: 400, code: 'SECRET_NOT_CONFIGURED' });

  const targetRepos = Object.values(data.repos).filter(
    r => repoBelongsToAccount(r, auth.login) && r.managedSecrets?.includes(name) && !r.isArchived
  );

  if (targetRepos.length === 0) {
    return { synced: 0, failed: 0, errors: [] };
  }

  let synced = 0;
  let failed = 0;
  const errors = [];
  const succeeded = new Set();

  const tasks = targetRepos.map(repo => async () => {
    const result = await syncOneSecret(name, value, repo.fullName, auth.env);
    if (result.success) {
      synced++;
      succeeded.add(repo.fullName);
    } else {
      failed++;
      errors.push({ repo: repo.fullName, error: result.error });
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY);

  await queueDataWrite(async () => {
    const current = await load();
    if (current.githubUser?.toLowerCase() !== auth.login.toLowerCase()) return;
    for (const fullName of succeeded) {
      if (current.repos[fullName]) {
        current.repos[fullName].lastSecretSync = new Date().toISOString();
      }
    }
    await save(current);
  });

  console.log(`🔑 Secret ${name} synced to ${synced} repos (${failed} failed)`);
  return { synced, failed, errors };
}

/**
 * Sync a single secret to a single repo via stdin pipe
 */
async function syncOneSecret(name, value, fullName, env) {
  return execGh(
    ['secret', 'set', name, '--repo', fullName],
    SECRET_SYNC_TIMEOUT_MS,
    { env, input: value },
  ).then(
    () => ({ success: true }),
    (error) => ({ success: false, error: error.message }),
  );
}

/**
 * Archive or unarchive a repo on GitHub
 */
export async function setRepoArchived(fullName, archived) {
  return withGitHubMutation(async () => {
    const data = await load();
    if (!data.repos[fullName] || !repoBelongsToAccount(data.repos[fullName], data.githubUser)) {
      throw new ServerError(`Repo not found: ${fullName}`, { status: 404, code: 'REPO_NOT_FOUND' });
    }
    const auth = await requireActiveCachedAccount(data);
    const cmd = archived ? 'archive' : 'unarchive';
    await execGh(['repo', cmd, fullName, '--yes'], DEFAULT_EXEC_GH_TIMEOUT_MS, { env: auth.env });

    const updated = await queueDataWrite(async () => {
      const current = await load();
      if (!current.repos[fullName] || current.githubUser?.toLowerCase() !== auth.login.toLowerCase()) {
        return { ...data.repos[fullName], isArchived: archived };
      }
      current.repos[fullName].isArchived = archived;
      await save(current);
      return current.repos[fullName];
    });

    console.log(`📦 ${archived ? 'Archived' : 'Unarchived'} ${fullName}`);
    return updated;
  });
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
  const [data, auth] = await Promise.all([load(), getGitHubAuthStatus()]);
  const repos = Object.values(reposForAccount(data));
  return {
    ...auth,
    githubUser: data.githubUser || null,
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
// AGENTS.md's sentinel-and-validate rule exists to prevent. In practice it means
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
  'certificate',
  // gh's own DNS/connect-failure wrapper (seen on gh 2.9x), distinct from the
  // raw Go transport strings above — this is what a `--hostname` pointed at an
  // unreachable or misresolved self-hosted GitHub Enterprise instance actually
  // prints, and it was falling through to the generic 'error' bucket.
  'error connecting to'
];

const includesAny = (haystack, needles) => needles.some(n => haystack.includes(n));

// GitHub Enterprise Server admins can disable the `/rate_limit` endpoint
// outright (a documented GHES setting) — `gh api rate_limit` then fails with
// "HTTP 404: Rate limiting is not enabled" even though `gh` successfully
// authenticated and round-tripped to that host. This bucket is only valid
// because probeGh is classifyGhProbe's one caller and always hits
// `/rate_limit` (see probeGh) — that response is proof the forge IS
// reachable, not evidence it is not. Without this marker it fell into the
// generic 'error' bucket ("gh failed for an unrecognised reason"), so a
// perfectly healthy GHES install with rate limiting turned off never got
// past the health gate to list PRs/issues. If classifyGhProbe ever gains a
// second caller probing a different endpoint, move this bucket into probeGh
// so it stays scoped to the endpoint it actually describes.
const GH_RATE_LIMIT_DISABLED_MARKERS = [
  'rate limiting is not enabled'
];

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
  if (includesAny(lower, GH_RATE_LIMIT_DISABLED_MARKERS)) return { status: 'ok', detail: null };
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

// Keyed by hostname (`''` = gh's default host). An operator commonly has a
// working github.com credential and a broken enterprise one (or the reverse), so
// one process-wide verdict would report the wrong forge's health — the same
// host-keying prWatcher's self-login cache already needs.
const ghHealthCache = new Map();

function probeGh(timeoutMs, hostname) {
  return new Promise((resolve) => {
    // `rate_limit` is authenticated, cheap, and — unlike every other endpoint —
    // does not itself consume quota, so polling this probe is free.
    // `--hostname` is required for an enterprise host: without it `gh api`
    // targets github.com regardless of cwd, so an enterprise repo would be
    // gated on a host it never talks to.
    const args = hostname ? ['api', 'rate_limit', '--hostname', hostname] : ['api', 'rate_limit'];
    const child = spawn('gh', args, { shell: false });
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
 * Result is cached per host for a minute — /api/system/health/details is polled,
 * and the probe spawns a process. Pass `{ force: true }` to bypass the cache.
 *
 * @param {{ force?: boolean, timeoutMs?: number, hostname?: string|null }} [opts]
 *   `hostname` targets a specific forge host (a GitHub Enterprise install);
 *   omitted means gh's default host.
 * @returns {Promise<{ status: string, ok: boolean, detail: string|null, remedy: string|null, checkedAt: string }>}
 */
export async function checkGhHealth({ force = false, timeoutMs = GH_PROBE_TIMEOUT_MS, hostname = null } = {}) {
  const now = Date.now();
  const key = hostname || '';
  const cached = ghHealthCache.get(key);
  if (!force && cached && (now - cached.at) < GH_HEALTH_TTL_MS) return cached.health;

  const { status, detail } = classifyGhProbe(await probeGh(timeoutMs, hostname));
  const health = {
    status,
    ok: status === 'ok',
    detail,
    remedy: ghRemedy(status),
    checkedAt: new Date(now).toISOString()
  };
  ghHealthCache.set(key, { health, at: now });
  return health;
}

/**
 * Resolve the account the GitHub CLI will actually use. A successful `api user`
 * is stronger than merely finding a token: it proves the credential works and
 * gives repo sync the owner it must query. The login is returned only to the
 * local UI; the credential inventory reduces this to presence/source.
 */
export async function getGitHubAuthStatus({ env = process.env } = {}) {
  const credentialSource = githubCredentialSource(env);
  const attempt = await execGh(
    ['api', 'user', '--hostname', GITHUB_HOST, '--jq', '.login'],
    GH_PROBE_TIMEOUT_MS,
    { env: githubDotComEnv(env) },
  )
    .then((login) => ({ login, error: null }))
    .catch((error) => ({ login: null, error }));
  if (attempt.login) {
    return { authenticated: true, status: 'ok', login: attempt.login, credentialSource, remedy: null };
  }

  const classified = attempt.error?.ghExitCode !== undefined
    ? classifyGhProbe({ code: attempt.error.ghExitCode, stderr: attempt.error.ghStderr })
    : attempt.error?.code
      ? classifyGhProbe({ spawnError: attempt.error })
      : classifyGhProbe({ code: null, stderr: attempt.error?.message });
  const status = classified.status === 'ok' ? 'error' : classified.status;
  return {
    authenticated: false,
    status,
    login: null,
    credentialSource,
    remedy: credentialSource === 'env' && status === 'not-authenticated'
      ? 'GH_TOKEN or GITHUB_TOKEN is set but GitHub rejected it. Update or remove that environment credential before using gh auth login.'
      : ghRemedy(status),
  };
}

async function getPinnedGitHubAuth() {
  const baseEnv = { ...process.env };
  const environmentToken = githubEnvironmentToken(baseEnv);
  const status = await getGitHubAuthStatus({
    env: environmentToken ? githubPinnedEnv(environmentToken, baseEnv) : baseEnv,
  });
  if (!status.authenticated || !status.login) return status;

  const token = environmentToken || await execGh([
    'auth', 'token', '--user', status.login, '--hostname', GITHUB_HOST,
  ], GH_PROBE_TIMEOUT_MS, { env: githubDotComEnv(baseEnv) }).catch(() => null);
  if (!token) {
    throw new ServerError('Could not pin the active GitHub credential. Re-authenticate with gh and try again.', {
      status: 503,
      code: 'GITHUB_CREDENTIAL_UNAVAILABLE'
    });
  }
  return { ...status, env: githubPinnedEnv(token, baseEnv) };
}

/** Test seam — drops the memoized probe results. */
export function __resetGhHealthCache() {
  ghHealthCache.clear();
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
 * @param {{ hostname?: string|null }} [opts] - the forge host this job actually
 *   talks to. Pass it whenever the caller knows the repo's host: a bare probe
 *   hits github.com, so an enterprise job would otherwise be gated on the health
 *   of a host it never contacts (and vice versa).
 * @returns {Promise<{ ok: boolean, status: string, detail: string|null, remedy: string|null }>}
 */
export async function ensureForgeReachable(label, { hostname = null } = {}) {
  const health = await checkGhHealth({ hostname }).catch(err => ({
    status: 'error', ok: false, detail: err.message, remedy: ghRemedy('error')
  }));
  if (health.ok) return health;
  const detail = health.detail ? ` — ${String(health.detail).split('\n')[0].slice(0, 160)}` : '';
  const where = hostname ? ` on ${hostname}` : '';
  console.error(`❌ ${label}: skipping this cycle, gh is ${health.status}${where}${detail}`);
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
 * @param {{ cwd?: string, env?: object|null }} [opts] - repo dir gh resolves the
 *   remote from, and the env overlay to run under. Pass the `env` from
 *   `resolveForgeForRepo` so the lookup authenticates as the SAME repo-owner-
 *   pinned account that opened the PR — on a multi-login host the ambient
 *   account may not even see it, which would read as "no PR".
 * @returns {Promise<{ status: 'found'|'none'|'unavailable', number: number|null, url: string|null, body: string|null, detail: string|null }>}
 */
export async function findPullRequestForBranch(branch, { cwd = null, env = null } = {}) {
  if (!branch) return { status: 'unavailable', number: null, url: null, detail: 'no branch name' };
  const raw = await execGh(
    ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,body,state'],
    DEFAULT_EXEC_GH_TIMEOUT_MS,
    { cwd, env }
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
  return { status: 'found', number: pr.number ?? null, url: pr.url || null, body: typeof pr.body === 'string' ? pr.body : null, detail: pr.state || null };
}

/**
 * Read ONE pull request's state. Same two-not-three-answers discipline as
 * `findPullRequestForBranch`: `known` carries a real forge answer, `unavailable`
 * means we could not ask (gh firewalled, PR deleted, unparseable output). A
 * caller must never read `unavailable` as "not merged" — the whole point is to
 * distinguish "the forge says OPEN" from "we never got to ask", because the
 * merge-follow-up reaper turns the first into a needs-manual-finish failure and
 * the second must leave prior behavior alone.
 *
 * GitHub only. PortOS opens GitLab MRs too, and `gh pr view` against a GitLab
 * URL answers nothing useful — callers classify the host first and skip this.
 *
 * @param {string} prRef - PR url or number (anything `gh pr view` accepts)
 * @param {{ cwd?: string, env?: object|null }} [opts] - repo dir gh resolves the
 *   remote from, and the env overlay to run under (see `resolveForgeForRepo`).
 * @returns {Promise<{ status: 'known'|'unavailable', state: string|null, detail: string|null }>}
 *   `state` is upper-cased (`MERGED` / `OPEN` / `CLOSED`) when status is `known`.
 */
export async function getPullRequestState(prRef, { cwd = null, env = null } = {}) {
  if (!prRef) return { status: 'unavailable', state: null, detail: 'no PR reference' };
  const raw = await execGh(
    ['pr', 'view', String(prRef), '--json', 'state'],
    DEFAULT_EXEC_GH_TIMEOUT_MS,
    { cwd, env }
  ).catch(err => err);
  if (raw instanceof Error) return { status: 'unavailable', state: null, detail: raw.message };
  const parsed = safeJSONParse(raw, null);
  const state = typeof parsed?.state === 'string' ? parsed.state.toUpperCase() : null;
  // A zero-exit gh that emitted nothing parseable told us nothing.
  if (!state) return { status: 'unavailable', state: null, detail: 'gh returned unparseable output' };
  return { status: 'known', state, detail: null };
}
