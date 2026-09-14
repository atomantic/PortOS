/**
 * Repository-owner forge credentials shared by Git operations and agent launches.
 * Keep account probing and token overlays here; repository mutations stay in git.js
 * and pure remote/account parsing stays in lib/gitForge.js.
 */
// Aliased: `spawnCli`'s promise executor already binds `resolve` in its own scope.
import { dirname, isAbsolute, resolve as resolvePath } from 'path';
import { spawn } from '../lib/childProcess.js';
import { execGitSafe } from '../lib/execGit.js';
import { parseGitRemote, detectForgeCli, pickGhAccountForOwner } from '../lib/gitForge.js';
import { listForgePinnedApps } from './agentAppWorkspace.js';

const DEFAULT_SPAWN_CLI_TIMEOUT_MS = 10000;

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

async function listGhAccounts(timeoutMs, signal) {
  const { stdout, stderr } = await spawnCli('gh', ['auth', 'status', '-h', 'github.com'], timeoutMs, signal);
  // gh writes status to stderr in older versions, stdout in newer — search both.
  const text = `${stdout}\n${stderr}`;
  const accounts = [];
  const re = /Logged in to github\.com account (\S+)/g;
  let m;
  while ((m = re.exec(text))) accounts.push(m[1]);
  return accounts;
}

async function getGhTokenForAccount(login, timeoutMs, signal) {
  const { code, stdout } = await spawnCli('gh', ['auth', 'token', '-u', login, '-h', 'github.com'], timeoutMs, signal);
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
  const target = resolvePath(root);
  return pinned.find(app => resolvePath(app.repoPath) === target)?.forgeAccount || null;
}

/**
 * The git commit identity for a gh account, as GitHub itself attributes it.
 *
 * `<id>+<login>@users.noreply.github.com` is the address GitHub links back to an
 * account, so a commit authored with it shows up under that account — which is
 * the point of pinning an app to a non-default account in the first place. The
 * numeric id is REQUIRED for the link: the legacy `<login>@users.noreply` form
 * predates account renames and no longer attributes reliably, so a probe that
 * cannot read the id returns null rather than a plausible-looking address that
 * silently attributes to nobody.
 *
 * @returns {Promise<{name: string, email: string}|null>}
 */
async function getGhCommitIdentity(token, timeoutMs, signal) {
  // Run the probe AS the pinned account. `gh api` otherwise answers for gh's
  // mutable active user, which is exactly the ambient identity this override
  // exists to escape — and the mismatch would be invisible, since the wrong
  // answer is still a well-formed identity.
  const { code, stdout } = await spawnCli(
    'gh', ['api', 'user', '--hostname', 'github.com', '--jq', '[.id, .login, .name] | @tsv'],
    timeoutMs, signal, { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token }
  );
  if (code !== 0) return null;
  const [id, login, name] = (stdout || '').trim().split('\t');
  if (!id || !login) return null;
  return { name: name || login, email: `${id}+${login}@users.noreply.github.com` };
}

/**
 * Resolve the forge CLI + auth env for a given repo directory.
 * - For GitHub repos: pins `GH_TOKEN` to a specific logged-in gh account, so PR
 *   creation doesn't depend on `hosts.yml`'s mutable `user:` field (avoids the
 *   multi-account "must be a collaborator" failure mode). The account is the
 *   managed app's explicit `forgeAccount` when it has one, and otherwise the
 *   logged-in account whose login matches the repo owner.
 * - For GitLab repos: uses glab as-is. glab is single-user-per-host, so its keyring
 *   already disambiguates by host without the mutable-active-user pitfall.
 * Falls back to ambient env when no match is possible.
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
export async function resolveForgeForRepo(dir, { timeoutMs = DEFAULT_SPAWN_CLI_TIMEOUT_MS, signal } = {}) {
  const remote = await execGitSafe(['remote', 'get-url', 'origin'], dir);
  const parsed = parseGitRemote(remote.stdout?.trim());
  if (!parsed) {
    return { cli: 'gh', env: process.env, host: null, owner: null, account: null, identity: null };
  }

  const cli = detectForgeCli(parsed.host);
  const base = { cli, env: process.env, host: parsed.host, owner: parsed.owner, identity: null };
  const ambient = { ...base, account: null };

  if (cli !== 'gh' || signal?.aborted) return ambient;

  const pinned = await resolveConfiguredAccount(dir);
  if (signal?.aborted) return ambient;

  // A pinned account skips the `gh auth status` listing entirely: the user named
  // the account, so the only question left is whether a token can be minted for
  // it — and a pin that gh is not logged into must fail as "no token", not be
  // silently replaced by an owner-match against a different account.
  const account = pinned || pickGhAccountForOwner(parsed.owner, await listGhAccounts(timeoutMs, signal));
  if (signal?.aborted) return ambient;
  if (!account) return ambient;

  const token = await getGhTokenForAccount(account, timeoutMs, signal);
  if (signal?.aborted || !token) return { ...base, account };

  const identity = pinned ? await getGhCommitIdentity(token, timeoutMs, signal) : null;
  if (signal?.aborted) return { ...base, account };

  return { ...base, env: { ...process.env, GH_TOKEN: token }, account, identity };
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
 * Returns `{}` when no github.com account and token were resolved, so the child
 * keeps whatever gh auth it would have used. Best-effort and bounded: never
 * throws, and a stalled `gh` probe times out to `{}` so a spawn is never blocked.
 * @param {string} dir - Repo (or worktree) root
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] - Cap on the git+gh probe before giving up
 * @returns {Promise<{ GH_TOKEN?: string, GIT_AUTHOR_NAME?: string, GIT_AUTHOR_EMAIL?: string,
 *                     GIT_COMMITTER_NAME?: string, GIT_COMMITTER_EMAIL?: string }>}
 */
export async function resolveForgeTokenEnv(dir, { timeoutMs = 10000 } = {}) {
  // Keep the whole lookup inside the agent-spawn budget. The shared abort signal
  // kills whichever gh subprocess is active when the outer budget expires and
  // prevents a slow git lookup from starting a stale follow-on auth probe. Each
  // gh subprocess keeps its own timeout as a second bound for direct callers.
  let timer;
  const controller = new AbortController();
  const resolved = await Promise.race([
    resolveForgeForRepo(dir, { timeoutMs, signal: controller.signal }).catch(() => null),
    new Promise((r) => {
      timer = setTimeout(() => {
        controller.abort();
        r(null);
      }, timeoutMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  // Overlay a token ONLY for a genuinely-minted github.com credential. Two gates:
  //  - host === 'github.com': detectForgeCli defaults an unrecognized/GHES host to
  //    `gh`, and resolveForgeForRepo's account/token probes are hardcoded to
  //    `-h github.com`. Without this gate, a Bitbucket/GHES repo whose owner segment
  //    happens to match a local github.com login would get that github.com token
  //    injected into every agent — the wrong (or a leaked) credential.
  //  - env !== process.env: resolveForgeForRepo returns a NEW env object
  //    (`{ ...process.env, GH_TOKEN }`) ONLY on a successful mint; every other
  //    branch (no match, token fetch failed) returns the ambient `process.env` by
  //    reference. Keying on `account` alone would re-emit the ambient GH_TOKEN when
  //    the account matched but the token fetch failed.
  const minted = resolved && resolved.host === 'github.com' && resolved.env !== process.env;
  const token = minted ? resolved.env.GH_TOKEN : null;
  if (!token) return {};
  // Identity rides the SAME gates as the token — it is only ever populated for a
  // minted github.com credential on an explicitly pinned account, so an identity
  // can never be overlaid onto a repo whose token was not.
  const identity = resolved.identity;
  return {
    GH_TOKEN: token,
    ...(identity ? {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    } : {}),
  };
}
