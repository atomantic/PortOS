/**
 * Repository-owner forge credentials shared by Git operations and agent launches.
 * Keep account probing and token overlays here; repository mutations stay in git.js
 * and pure remote/account parsing stays in lib/gitForge.js.
 */
// Aliased: `spawnCli`'s promise executor already binds `resolve` in its own scope.
import { dirname, isAbsolute, resolve as resolvePath } from 'path';
import { realpath } from 'fs/promises';
import { spawn } from '../lib/childProcess.js';
import { execGitSafe } from '../lib/execGit.js';
import { parseGitRemote, detectForgeCli, pickGhAccountForOwner } from '../lib/gitForge.js';
import { githubApiHost } from '../lib/workTracker.js';
import { ServerError } from '../lib/errorHandler.js';
import { listForgePinnedApps } from './agentAppWorkspace.js';

const DEFAULT_SPAWN_CLI_TIMEOUT_MS = 10000;
const TOKEN_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

// gh uses the public token family for Enterprise Cloud (*.ghe.com), too.
const tokenKeyForHost = (host) => host === 'github.com' || host.endsWith('.ghe.com')
  ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN';

function ghHostEnv(host, token = null) {
  const env = { ...process.env, GH_HOST: host };
  // Account discovery must read this host's keyring, never an ambient token
  // that can make a different account look like the requested login.
  for (const key of TOKEN_ENV_KEYS) delete env[key];
  if (token) env[tokenKeyForHost(host)] = token;
  return env;
}

function spawnCli(cmd, args, timeoutMs = DEFAULT_SPAWN_CLI_TIMEOUT_MS, signal, env = null) {
  const timedOut = { code: -1, stdout: '', stderr: 'timed out' };
  if (signal?.aborted) return Promise.resolve(timedOut);

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false, ...(env ? { env } : {}) });
    let stdout = '', stderr = '';
    let settled = false;
    let timer;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => {
      done(timedOut);
      try { child.kill('SIGKILL'); } catch { /* best-effort process cleanup */ }
    };
    timer = setTimeout(abort, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.on('error', () => done({ code: -1, stdout: '', stderr: '' }));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function listGhAccounts(host, timeoutMs, signal) {
  const { stdout, stderr } = await spawnCli('gh', ['auth', 'status', '-h', host], timeoutMs, signal, ghHostEnv(host));
  // gh writes status to stderr in older versions, stdout in newer — search both.
  const text = `${stdout}\n${stderr}`;
  const accounts = [];
  const re = /Logged in to (\S+) account (\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1].toLowerCase() === host) accounts.push(m[2]);
  }
  return accounts;
}

async function getGhTokenForAccount(host, login, timeoutMs, signal) {
  const { code, stdout } = await spawnCli('gh', ['auth', 'token', '-u', login, '-h', host], timeoutMs, signal, ghHostEnv(host));
  return code === 0 ? stdout.trim() : null;
}

/**
 * The MAIN checkout behind `dir`, which may be a worktree.
 *
 * CoS worktrees live under PortOS's own `data/cos/worktrees/<agentId>`, nowhere
 * near the app's `repoPath`, so a registry lookup keyed on the agent's cwd would
 * never match the app the agent is working on. `--git-common-dir` is the shared
 * `.git` both the worktree and its checkout point at, so its parent is the
 * checkout — and for an ordinary (non-worktree) repo it is that repo's own
 * `.git`, making this an identity for the common case.
 *
 * Returns `null` when `dir` is not a repository at all.
 */
async function resolveMainRepoRoot(dir) {
  const { exitCode, stdout } = await execGitSafe(['rev-parse', '--git-common-dir'], dir);
  const gitDir = exitCode === 0 ? (stdout || '').trim() : '';
  if (!gitDir) return null;
  // Older git answers with a path relative to `dir` (`--path-format=absolute`
  // only landed in 2.31), so resolve it before taking the parent.
  const absolute = isAbsolute(gitDir) ? gitDir : resolvePath(dir, gitDir);
  return dirname(absolute);
}

/**
 * The gh account a managed app is explicitly pinned to (`app.forgeAccount`), or
 * `null` to fall back to matching the repo owner against the logged-in accounts.
 *
 * This is what lets one install drive repos belonging to SEVERAL GitHub accounts:
 * owner-matching only works when the repo owner's login happens to be one of the
 * logged-in `gh` accounts, which it is not for an organization repo or any repo
 * whose owner differs from the account that should push to it.
 *
 * Best-effort by construction — a missing registry, an unreadable one, or a repo
 * that belongs to no managed app all mean "no pin", never an error.
 */
async function resolveConfiguredAccount(dir) {
  // The registry read comes first so an install where no app pins an account —
  // every install until someone uses the feature — costs one small JSON read and
  // no extra subprocess on a path that already runs three.
  const pinned = await listForgePinnedApps().catch(() => []);
  if (!pinned.length) return null;
  const root = await resolveMainRepoRoot(dir).catch(() => null);
  if (!root) return null;
  // Both sides through `realpath`: comparing `resolvePath()` strings alone
  // never matches a symlinked checkout against the registered repoPath, so the
  // pin is silently missed and auth falls back to the wrong account. Best
  // effort — an unreadable path falls back to the lexical resolution rather
  // than failing the lookup.
  const canonical = (p) => realpath(p).catch(() => resolvePath(p));
  const target = await canonical(root);
  for (const app of pinned) {
    if (typeof app?.repoPath !== 'string') continue;
    if ((await canonical(app.repoPath)) === target) return app.forgeAccount || null;
  }
  return null;
}

/**
 * Public GitHub retains its stable id+login noreply address. Enterprise hosts
 * define their own addresses; use the authenticated user's returned email or
 * leave commit identity alone if that API does not expose one.
 */
async function getGhCommitIdentity(host, token, timeoutMs, signal) {
  const { code, stdout } = await spawnCli(
    'gh', ['api', 'user', '--hostname', host, '--jq', '[.id, .login, .name, .email] | @tsv'],
    timeoutMs, signal, ghHostEnv(host, token)
  );
  if (code !== 0) return null;
  const [id, login, name, email] = (stdout || '').trim().split('\t');
  if (!id || !login) return null;
  const commitEmail = host === 'github.com' ? `${id}+${login}@users.noreply.github.com` : email;
  if (!commitEmail) return null;
  return { name: name || login, email: commitEmail };
}

/**
 * Resolve the forge CLI + auth env for a given repo directory.
 * - For GitHub repos: pins the host-specific token to a specific logged-in gh account, so PR
 *   creation doesn't depend on `hosts.yml`'s mutable `user:` field (avoids the
 *   multi-account "must be a collaborator" failure mode). The account is the
 *   managed app's explicit `forgeAccount` when it has one, and otherwise the
 *   logged-in account whose login matches the repo owner.
 * - For GitLab repos: uses glab as-is. glab is single-user-per-host, so its keyring
 *   already disambiguates by host without the mutable-active-user pitfall.
 * Falls back to ambient env only without an explicit pin; unavailable pins fail.
 *
 * `identity` is populated ONLY for an explicitly pinned `forgeAccount` — an
 * owner-match is an inference about which credential to use, not a statement
 * about who the commits belong to, so it must not quietly rewrite the authorship
 * of every repo whose owner happens to share a login with a local gh account.
 *
 * @param {string} dir - Repository root (a worktree of one is fine)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] - Per-process bound for gh auth probes
 * @param {AbortSignal} [opts.signal] - Cancels active and follow-on gh auth probes
 * @returns {Promise<{cli: string, env: object, host: string|null, owner: string|null,
 *                    account: string|null, identity: {name: string, email: string}|null}>}
 */
export function resolveForgeForRepo(dir, opts = {}) {
  return resolveForgeWithPin(dir, opts);
}

// A shared pin state lets the bounded child-overlay lookup distinguish an
// unpinned timeout (ambient is fine) from an unresolved or explicit pin.
async function resolveForgeWithPin(dir, { timeoutMs = DEFAULT_SPAWN_CLI_TIMEOUT_MS, signal, forgeAccount = null } = {}, pinState = {}) {
  const explicitPin = (typeof forgeAccount === 'string' && forgeAccount.trim()) ? forgeAccount.trim() : null;
  pinState.account = explicitPin || await resolveConfiguredAccount(dir);
  pinState.resolved = true;
  // The outer budget may expire while the registry or worktree lookup waits.
  // It already refused the unknown pin; do not start late credential probes.
  if (signal?.aborted) return { cli: 'gh', env: process.env, host: null, owner: null, account: null, identity: null };
  return resolveForgeCredentials(dir, { timeoutMs, signal, pinned: pinState.account }).catch((error) => {
    if (pinState.account) throw error;
    return { cli: 'gh', env: process.env, host: null, owner: null, account: null, identity: null };
  });
}

async function resolveForgeCredentials(dir, { timeoutMs, signal, pinned }) {
  const remote = await execGitSafe(['remote', 'get-url', 'origin'], dir);
  const parsed = parseGitRemote(remote.stdout?.trim());
  if (!parsed) {
    if (pinned) throw new ServerError('The pinned GitHub account cannot be resolved without a repository origin.', {
      status: 409, code: 'FORGE_ACCOUNT_UNAVAILABLE',
    });
    return { cli: 'gh', env: process.env, host: null, owner: null, account: null, identity: null };
  }

  const host = githubApiHost(parsed.host.toLowerCase());
  const cli = detectForgeCli(host);
  const base = { cli, env: process.env, host, owner: parsed.owner, identity: null };
  const ambient = { ...base, account: null };

  if (cli !== 'gh' || signal?.aborted) return ambient;

  // A pinned account skips the `gh auth status` listing entirely: the user named
  // the account, so the only question left is whether a token can be minted for
  // it — and a pin that gh is not logged into must refuse execution, not be
  // silently replaced by an owner-match against a different account.
  const account = pinned || pickGhAccountForOwner(parsed.owner, await listGhAccounts(host, timeoutMs, signal));
  if (signal?.aborted) return ambient;
  if (!account) return ambient;

  const token = await getGhTokenForAccount(host, account, timeoutMs, signal);
  if (signal?.aborted || !token) {
    if (pinned) throw new ServerError(`The pinned GitHub account ${account} is unavailable on ${host}. Check gh auth status -h ${host}.`, {
      status: 409, code: 'FORGE_ACCOUNT_UNAVAILABLE', context: { host, account },
    });
    return { ...base, account };
  }

  const identity = pinned ? await getGhCommitIdentity(host, token, timeoutMs, signal) : null;
  if (signal?.aborted) return { ...base, account };

  const env = ghHostEnv(host, token);
  return { ...base, env, account, identity };
}

/**
 * Resolve just the GitHub-token env overlay for a repo directory, so a spawned
 * child that runs its own `gh pr create` — a CoS agent, most notably codex,
 * which is otherwise blind to PortOS's account-pinning — authenticates as the
 * right gh account (the same pinning `resolveForgeForRepo` gives PortOS's own
 * `createPR`). Two reasons a plain env inherit isn't enough: (1) TUI agents run
 * under `buildSafeEnv`, which strips `GH_TOKEN` entirely, so the child would
 * fall back to gh's mutable `hosts.yml` active user; (2) even when inherited,
 * the ambient token can be the wrong account in a multi-login setup ("must be a
 * collaborator").
 *
 * When the app pinned an explicit `forgeAccount`, the overlay also carries that
 * account's `GIT_AUTHOR_` / `GIT_COMMITTER_` identity. Authenticating as another
 * account without it produces commits that carry the machine owner's name and
 * email into someone else's repository — the credential and the authorship have
 * to move together, or "run this app under another GitHub account" is only half
 * true. Env vars rather than `git config`: the override lives and dies with the
 * agent process instead of mutating a repository PortOS does not own, and git
 * gives them precedence over every config level.
 *
 * Returns `{}` when no host-specific account and token were resolved, so the child
 * keeps whatever gh auth it would have used. An unavailable explicit pin or a
 * timed-out pinned lookup refuses the spawn rather than silently using another login.
 * @param {string} dir - Repo (or worktree) root
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] - Cap on the git+gh probe before giving up
 * @returns {Promise<{ GH_TOKEN?: string, GH_ENTERPRISE_TOKEN?: string, GH_HOST?: string, GIT_AUTHOR_NAME?: string, GIT_AUTHOR_EMAIL?: string,
 *                     GIT_COMMITTER_NAME?: string, GIT_COMMITTER_EMAIL?: string }>}
 */
export async function resolveForgeTokenEnv(dir, { timeoutMs = 10000, forgeAccount = null } = {}) {
  // Keep the whole lookup inside the agent-spawn budget. The shared abort signal
  // kills whichever gh subprocess is active when the outer budget expires and
  // prevents a slow git lookup from starting a stale follow-on auth probe. Each
  // gh subprocess keeps its own timeout as a second bound for direct callers.
  let timer;
  const controller = new AbortController();
  const pinState = { resolved: false, account: null };
  const resolved = await Promise.race([
    resolveForgeWithPin(dir, { timeoutMs, signal: controller.signal, forgeAccount }, pinState),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        // Unknown is not unpinned: a late registry read may reveal a pin.
        if (pinState.resolved && !pinState.account) return resolve(null);
        reject(new ServerError('Pinned GitHub account resolution timed out. Retry after checking gh auth status.', {
          status: 503, code: 'FORGE_AUTH_TIMEOUT',
        }));
      }, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  // Only a successful host-specific keyring lookup creates a new env. The CLI
  // defaults unknown forges to gh, so neither its name nor an account match is
  // sufficient evidence that a credential was actually found for this host.
  const minted = resolved?.host && resolved.env !== process.env;
  const tokenKey = minted ? tokenKeyForHost(resolved.host) : null;
  const token = tokenKey ? resolved.env[tokenKey] : null;
  if (!token) return {};
  const identity = resolved.identity;
  return {
    GH_HOST: resolved.host,
    [tokenKey]: token,
    ...(identity ? {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    } : {}),
  };
}
