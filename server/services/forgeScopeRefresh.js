/**
 * Drive `gh auth refresh -h <host> -s <scopes>` for the Pull Requests tab, so a
 * token that lacks an OAuth scope can be fixed from the UI instead of a terminal.
 *
 * `gh` needs no TTY for this: with piped stdio it prints the one-time code and
 * the device URL on stderr and then waits for the user to approve in a browser.
 * The user is usually NOT on this host (the tailnet), so the browser launch is
 * disabled and the code + URL travel to the UI as an SSE frame instead.
 *
 * Frames (per job, `broadcastSse`): `device-code` {code,url} → `complete` |
 * `error` {error} | `canceled`. The device-code frame is retained, so a client
 * that attaches late (a reload mid-flow) still sees what to enter.
 *
 * One refresh per host at a time: a second request for the same host adopts the
 * running job rather than starting another device flow.
 *
 * `gh auth refresh` has no account flag — it refreshes the host's ACTIVE login.
 * When the merge ran as a different owner-matched account, refreshing the active
 * one would leave the merge failing, so that mismatch refuses up front.
 */

import { spawn } from '../lib/childProcess.js';
import { randomUUID } from 'crypto';
import { execGh } from './github.js';
import { REFRESHABLE_FORGE_SCOPES, forgeScopeRefreshCommand, isForgePersonalTokenRefusal } from '../lib/forgeAccessErrors.js';
import { ServerError } from '../lib/errorHandler.js';
import { attachSseClient, broadcastSse, closeJobAfterDelay } from '../lib/sseUtils.js';

// GitHub's device codes live 15 minutes; past that the flow cannot succeed.
export const FORGE_REFRESH_TIMEOUT_MS = 15 * 60 * 1000;
const ACTIVE_USER_TIMEOUT_MS = 15_000;

const DEVICE_CODE_RE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const DEVICE_URL_RE = /(https?:\/\/[^\s]+\/login\/device)/i;
const TOKEN_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

// The variable gh would authenticate with for `host` ahead of the keyring. On
// github.com an owner-matched account's token is minted from the keyring and
// overrides any ambient GH_TOKEN, so it only counts when no account was resolved.
const envTokenFor = (host, expectedAccount) => {
  const names = host === 'github.com' ? ['GH_TOKEN', 'GITHUB_TOKEN'] : ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  if (host === 'github.com' && expectedAccount) return null;
  return names.find((name) => process.env[name]) || null;
};

const jobs = new Map();
const jobIdByHost = new Map();

// An env token takes precedence over the keyring and `gh auth refresh` refuses to
// touch it, so the refresh must run against the keyring login alone.
const refreshEnv = () => {
  const env = { ...process.env, GH_BROWSER: 'true', BROWSER: 'true', GH_PROMPT_DISABLED: '1' };
  for (const key of TOKEN_ENV_KEYS) delete env[key];
  return env;
};

const finish = (job, frame) => {
  if (job.settled) return;
  job.settled = true;
  clearTimeout(job.timer);
  if (jobIdByHost.get(job.host) === job.id) jobIdByHost.delete(job.host);
  broadcastSse(job, frame);
  closeJobAfterDelay(jobs, job.id, undefined, job);
};

const lastLine = (text) => text.trim().split('\n').filter(Boolean).pop() || '';

function spawnRefresh(job) {
  const child = spawn('gh', ['auth', 'refresh', '-h', job.host, '-s', job.scopes.join(',')], {
    shell: false,
    env: refreshEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Terminal listeners go on in this same tick: a failed spawn reports on the
  // next tick, and an unlistened `error` would take the server down.
  job.child = child;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (job.deviceCode) return;
    const code = DEVICE_CODE_RE.exec(stderr)?.[1];
    const url = DEVICE_URL_RE.exec(stderr)?.[1];
    if (!code || !url) return;
    job.deviceCode = { code, url };
    console.log(`🔑 Forge scope refresh for ${job.host} is waiting for browser approval`);
    broadcastSse(job, { type: 'device-code', host: job.host, scopes: job.scopes, code, url });
  });
  child.stdout.on('data', () => {});
  child.on('error', (err) => {
    console.error(`❌ Forge scope refresh could not start gh: ${err.message}`);
    finish(job, { type: 'error', error: `Could not run gh: ${err.message}` });
  });
  child.on('close', (code) => {
    if (job.canceled) return finish(job, { type: 'canceled' });
    if (code === 0) {
      console.log(`✅ Forge scope refresh for ${job.host} granted ${job.scopes.join(',')}`);
      return finish(job, { type: 'complete', host: job.host, scopes: job.scopes });
    }
    // The user declining in the browser or a restricted OAuth app is an expected
    // outcome, not a defect: stdout, not stderr.
    console.log(`🚫 Forge scope refresh for ${job.host} ended with code ${code}`);
    finish(job, { type: 'error', error: lastLine(stderr) || `gh auth refresh exited with code ${code}` });
  });
  job.timer = setTimeout(() => {
    job.timedOut = true;
    try { child.kill('SIGTERM'); } catch (err) { console.error(`❌ Forge scope refresh: failed to stop timed-out gh: ${err.message}`); }
    finish(job, { type: 'error', error: 'The one-time code expired before it was approved. Start the refresh again.' });
  }, FORGE_REFRESH_TIMEOUT_MS);
  job.timer.unref?.();
}

async function activeLogin(host) {
  const env = refreshEnv();
  return execGh(['api', 'user', '--hostname', host, '--jq', '.login'], ACTIVE_USER_TIMEOUT_MS, { env })
    .catch(() => null);
}

/**
 * Start (or adopt) the scope refresh for `host`.
 *
 * @param {object} options
 * @param {string} options.host - forge host derived from the app's origin, never client-supplied
 * @param {string[]} options.scopes - must all be in `REFRESHABLE_FORGE_SCOPES`
 * @param {string|null} [options.expectedAccount] - login the merge actually authenticates as, when known
 * @returns {Promise<{jobId: string, host: string, scopes: string[], adopted: boolean}>}
 */
export async function startForgeScopeRefresh({ host, scopes, expectedAccount = null }) {
  const refused = scopes.filter((scope) => !REFRESHABLE_FORGE_SCOPES.includes(scope));
  if (refused.length > 0) {
    throw new ServerError(`PortOS will not request the ${refused.join(', ')} scope. Run the gh command in a terminal instead.`, {
      status: 400,
      code: 'FORGE_SCOPE_NOT_REFRESHABLE',
    });
  }

  const envToken = envTokenFor(host, expectedAccount);
  if (envToken) {
    throw new ServerError(
      `The ${host} credential PortOS uses comes from the ${envToken} environment variable, which gh auth refresh cannot re-scope. Reissue that token with the ${scopes.join(', ')} scope instead.`,
      { status: 409, code: 'FORGE_TOKEN_FROM_ENV', context: { host, variable: envToken } },
    );
  }

  const running = jobs.get(jobIdByHost.get(host));
  if (running && !running.settled) {
    if ((running.expectedAccount || '').toLowerCase() !== (expectedAccount || '').toLowerCase()
      || scopes.some((scope) => !running.scopes.includes(scope))) {
      throw new ServerError(`A different token refresh is already in progress on ${host}. Finish or cancel it before starting this one.`, {
        status: 409, code: 'FORGE_REFRESH_IN_PROGRESS',
      });
    }
    // A reservation is not a usable job until its account check has succeeded.
    await running.ready;
    return { jobId: running.id, host, scopes: running.scopes, adopted: true };
  }

  // Reserve the host before the first await so two requests cannot both start a flow.
  const job = { id: randomUUID(), host, scopes, expectedAccount, clients: [], lastPayload: null, settled: false, canceled: false, child: null, timer: null, deviceCode: null };
  jobs.set(job.id, job);
  jobIdByHost.set(host, job.id);

  job.ready = (async () => {
    const active = expectedAccount ? await activeLogin(host) : null;
    if (expectedAccount && !active) {
      throw new ServerError(`Could not verify gh's active account on ${host}. Check gh auth status -h ${host}, then try again.`, {
        status: 409, code: 'FORGE_ACCOUNT_UNVERIFIED',
      });
    }
    if (expectedAccount && active.toLowerCase() !== expectedAccount.toLowerCase()) {
      throw new ServerError(
        `PortOS merges as ${expectedAccount} on ${host}, but gh's active account there is ${active}, and gh can only refresh the active one. `
        + `Run gh auth switch -h ${host} -u ${expectedAccount}, then try again.`,
        { status: 409, code: 'FORGE_ACCOUNT_NOT_ACTIVE', context: { host, expectedAccount, active } },
      );
    }
    // Cancelled while the account check was in flight: never spawn.
    if (job.canceled) return finish(job, { type: 'canceled' });
    spawnRefresh(job);
  })().catch((error) => {
    finish(job, { type: 'error', error: error.message });
    throw error;
  });
  await job.ready;
  return { jobId: job.id, host, scopes, adopted: false };
}

/** Attach an SSE response to a refresh job. False when no such job exists. */
export const attachForgeScopeRefreshClient = (jobId, res) => attachSseClient(jobs, jobId, res);

/** Whether a refresh job exists (running, or inside its post-terminal replay window). */
export const hasForgeScopeRefresh = (jobId) => jobs.has(jobId);

/** Stop a refresh. Idempotent; false when the job is unknown or already finished. */
export function cancelForgeScopeRefresh(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.settled) return false;
  job.canceled = true;
  if (!job.child) return true;
  try {
    job.child.kill('SIGTERM');
  } catch (err) {
    console.error(`❌ Forge scope refresh: failed to stop gh: ${err.message}`);
    finish(job, { type: 'canceled' });
  }
  return true;
}

/**
 * The one error a route throws when a forge call failed on a missing OAuth scope.
 * Carries the hand-run command AND whether PortOS can drive the refresh itself,
 * so the client never has to re-derive either.
 *
 * @param {{host: string|null, scopes: string[], error: string}} failure
 * @returns {ServerError}
 */
export function forgeScopeMissingError({ host, scopes, error }) {
  const forgeHost = host || 'github.com';
  // A PAT cannot be re-scoped by `gh auth refresh`: offering it would "succeed"
  // on the keyring and leave the failing credential untouched, forever.
  const personalToken = isForgePersonalTokenRefusal(error);
  return new ServerError(error, {
    status: 403,
    code: 'FORGE_TOKEN_SCOPE_MISSING',
    context: {
      host: forgeHost,
      scopes,
      command: personalToken ? null : forgeScopeRefreshCommand(forgeHost, scopes),
      credential: personalToken ? 'personal-access-token' : 'oauth',
      refreshable: !personalToken && scopes.every((scope) => REFRESHABLE_FORGE_SCOPES.includes(scope)),
    },
  });
}
