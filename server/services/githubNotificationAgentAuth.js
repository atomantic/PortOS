/** Resolve inbox-agent credentials at launch, never from the PortOS checkout. */
import { ServerError } from '../lib/errorHandler.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { getAccount, resolveGitHubAccountEnv } from './githubAccounts.js';
import { execGh } from './github.js';

const TOKEN_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const TIMEOUT_MS = 10_000;
const unavailable = () => new ServerError('The GitHub inbox account changed or cannot authenticate. Check Accounts, then queue this action again.', {
  status: 409, code: 'GITHUB_AGENT_ACCOUNT_UNAVAILABLE',
});
const sameLogin = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();
const publicTokenHost = host => host === 'github.com' || host.endsWith('.ghe.com');
const allowed = (account, origin) => account.enabled
  && (account.mode !== 'disabled' || origin === 'user')
  && (account.trust !== 'private' || account.allowAgents === true);

/**
 * Returns an execution-only overlay, or null for tasks outside the inbox.
 * Older generic tasks already retained the account id and host; use that
 * trusted binding. Older security tasks did not identify an account and must
 * be queued again rather than guessing one from the repository owner.
 */
export async function resolveNotificationAgentEnv(task) {
  const metadata = task.metadata || {};
  const binding = metadata.githubNotificationAccount || metadata.githubNotificationResolve;
  if (!binding && !metadata.githubSecurityFix) return null;
  if (typeof binding?.accountId !== 'string' || !binding.accountId || typeof binding.host !== 'string'
    || (Object.hasOwn(binding, 'login') && binding.login !== null && typeof binding.login !== 'string')) throw unavailable();
  const origin = binding.origin || metadata.githubNotificationResolve?.origin;
  const account = await getAccount(binding.accountId).catch(() => null);
  if (!account || !allowed(account, origin) || account.host !== binding.host
    || (Object.hasOwn(binding, 'login') && !sameLogin(account.login, binding.login))) throw unavailable();

  // Ambient/provider tokens may belong to the checkout's account. Resolve
  // this account from gh's credential store, then pin the exact returned token.
  const baseEnv = { ...process.env };
  for (const key of TOKEN_KEYS) delete baseEnv[key];
  // An unnamed account intentionally uses ambient auth before gh's active
  // keyring login. Preserve that documented path, but only for this host's family.
  const tokenKey = publicTokenHost(account.host) ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN';
  const implicitToken = !account.login
    ? [tokenKey, tokenKey === 'GH_TOKEN' ? 'GITHUB_TOKEN' : 'GITHUB_ENTERPRISE_TOKEN'].map(key => process.env[key]).find(Boolean)
    : null;
  const resolved = await resolveGitHubAccountEnv(account, { baseEnv }).catch(() => null);
  if (!resolved?.env) throw unavailable();
  const token = implicitToken || TOKEN_KEYS.map(key => resolved.env[key]).find(Boolean)
    || await execGh(['auth', 'token', '--hostname', account.host], TIMEOUT_MS, { env: resolved.env }).catch(() => null);
  if (!token) throw unavailable();
  // Empty the other families as well: the runner and login-shell paths union
  // this delta onto their own inherited env before starting the provider.
  const overlay = {
    ...Object.fromEntries(TOKEN_KEYS.map(key => [key, ''])),
    GH_HOST: account.host,
    [tokenKey]: token,
  };
  const raw = await execGh(['api', 'user', '--hostname', account.host, '--jq', '{id,login,name,email}'], TIMEOUT_MS,
    { env: { ...baseEnv, ...overlay } }).catch(() => null);
  const identity = safeJSONParse(raw, null, { logError: false });
  if (typeof identity?.login !== 'string' || !identity.login || !/^\d+$/.test(String(identity.id || ''))
    || (account.login && !sameLogin(identity.login, account.login))) throw unavailable();
  const latest = await getAccount(binding.accountId).catch(() => null);
  if (!latest || !allowed(latest, origin) || latest.host !== account.host || !sameLogin(latest.login, account.login)) throw unavailable();
  const email = account.host === 'github.com'
    ? `${identity.id}+${identity.login}@users.noreply.github.com` : identity.email;
  return {
    ...overlay,
    ...(email ? {
      GIT_AUTHOR_NAME: identity.name || identity.login,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: identity.name || identity.login,
      GIT_COMMITTER_EMAIL: email,
    } : {}),
  };
}
