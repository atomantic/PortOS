/**
 * Repository-owner forge credentials shared by Git operations and agent launches.
 * Keep account probing and token overlays here; repository mutations stay in git.js
 * and pure remote/account parsing stays in lib/gitForge.js.
 */
import { spawn } from '../lib/childProcess.js';
import { execGitSafe } from '../lib/execGit.js';
import { parseGitRemote, detectForgeCli, pickGhAccountForOwner } from '../lib/gitForge.js';

const DEFAULT_SPAWN_CLI_TIMEOUT_MS = 10000;

function spawnCli(cmd, args, timeoutMs = DEFAULT_SPAWN_CLI_TIMEOUT_MS, signal) {
  const timedOut = { code: -1, stdout: '', stderr: 'timed out' };
  if (signal?.aborted) return Promise.resolve(timedOut);

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false });
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
 * Resolve the forge CLI + auth env for a given repo directory.
 * - For GitHub repos: auto-pins `GH_TOKEN` to the logged-in gh account whose login
 *   matches the repo owner, so PR creation doesn't depend on `hosts.yml`'s mutable
 *   `user:` field (avoids the multi-account "must be a collaborator" failure mode).
 * - For GitLab repos: uses glab as-is. glab is single-user-per-host, so its keyring
 *   already disambiguates by host without the mutable-active-user pitfall.
 * Falls back to ambient env when no match is possible.
 * @param {string} dir - Repository root
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] - Per-process bound for gh auth probes
 * @param {AbortSignal} [opts.signal] - Cancels active and follow-on gh auth probes
 */
export async function resolveForgeForRepo(dir, { timeoutMs = DEFAULT_SPAWN_CLI_TIMEOUT_MS, signal } = {}) {
  const remote = await execGitSafe(['remote', 'get-url', 'origin'], dir);
  const parsed = parseGitRemote(remote.stdout?.trim());
  if (!parsed) {
    return { cli: 'gh', env: process.env, host: null, owner: null, account: null };
  }

  const cli = detectForgeCli(parsed.host);
  const ambient = { cli, env: process.env, host: parsed.host, owner: parsed.owner, account: null };

  if (cli !== 'gh' || signal?.aborted) return ambient;

  const accounts = await listGhAccounts(timeoutMs, signal);
  if (signal?.aborted) return ambient;
  const account = pickGhAccountForOwner(parsed.owner, accounts);
  if (!account) return { cli, env: process.env, host: parsed.host, owner: parsed.owner, account: null };

  const token = await getGhTokenForAccount(account, timeoutMs, signal);
  if (signal?.aborted || !token) {
    return { cli, env: process.env, host: parsed.host, owner: parsed.owner, account };
  }

  return { cli, env: { ...process.env, GH_TOKEN: token }, host: parsed.host, owner: parsed.owner, account };
}

/**
 * Resolve just the GitHub-token env overlay for a repo directory, so a spawned
 * child that runs its own `gh pr create` — a CoS agent, most notably codex,
 * which is otherwise blind to PortOS's account-pinning — authenticates as the
 * gh account whose login matches the repo owner (the same pinning
 * `resolveForgeForRepo` gives PortOS's own `createPR`). Two reasons a plain
 * env inherit isn't enough: (1) TUI agents run under `buildSafeEnv`, which
 * strips `GH_TOKEN` entirely, so the child would fall back to gh's mutable
 * `hosts.yml` active user; (2) even when inherited, the ambient token can be
 * the wrong account in a multi-login setup ("must be a collaborator").
 *
 * Returns `{ GH_TOKEN }` only when a github.com repo-owner-matched account and
 * token were found; otherwise `{}` so the child keeps whatever gh auth it would
 * have used. Best-effort and bounded: never throws, and a stalled `gh` probe
 * times out to `{}` so a spawn is never blocked.
 * @param {string} dir - Repo (or worktree) root
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] - Cap on the git+gh probe before giving up
 * @returns {Promise<{ GH_TOKEN?: string }>}
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
  return token ? { GH_TOKEN: token } : {};
}
