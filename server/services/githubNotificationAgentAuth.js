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
const normalizedHost = host => typeof host === 'string' ? host.trim().toLowerCase() : '';
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const publicTokenHost = host => host === 'github.com' || host.endsWith('.ghe.com');
const allowed = (account, origin) => account.enabled
  && (account.mode !== 'disabled' || origin === 'user')
  && (account.trust !== 'private' || account.allowAgents === true);

/**
 * Returns an execution-only overlay, or null for tasks outside the inbox.
 * Older generic tasks already retained the account id and host; use that
 * trusted binding. Older security tasks did not identify an account and must
 * be queued again rather than guessing one from the repository owner. A PR
 * review's concrete viewer selector also works independently: an operator's
 * explicit account selection does not inherit inbox automation policy.
 */
export async function resolveNotificationAgentEnv(task) {
  const metadata = task.metadata || {};
  const inboxBinding = metadata.githubNotificationAccount || metadata.githubNotificationResolve;
  const selector = metadata.githubAccount;
  const binding = inboxBinding || (selector ? { accountId: selector.id, host: selector.host } : null);
  if (!binding && !metadata.githubSecurityFix) return null;
  if (typeof binding?.accountId !== 'string' || !binding.accountId || typeof binding.host !== 'string'
    || (Object.hasOwn(binding, 'login') && binding.login !== null && typeof binding.login !== 'string')) throw unavailable();
  const origin = binding.origin || metadata.githubNotificationResolve?.origin || metadata.githubSecurityFix?.origin;
  const inboxContext = Boolean(inboxBinding || metadata.githubSecurityFix);
  const permitted = account => account.enabled && (!inboxContext || allowed(account, origin));
  const account = await getAccount(binding.accountId).catch(() => null);
  if (!account || !permitted(account) || normalizedHost(account.host) !== normalizedHost(binding.host)
    || (Object.hasOwn(binding, 'login') && !sameLogin(account.login, binding.login))) throw unavailable();
  if (selector && (selector.id !== binding.accountId || normalizedHost(selector.host) !== normalizedHost(binding.host)
    || typeof selector.login !== 'string' || !LOGIN_RE.test(selector.login)
    || (account.login && !sameLogin(account.login, selector.login)))) throw unavailable();
  // A configured implicit account keeps login=null; a review separately records
  // the viewer it selected at queue time. Resolve that viewer, not a new active login.
  const selectedLogin = selector?.login || account.login;

  // Ambient/provider tokens may belong to the checkout's account. Resolve
  // this account from gh's credential store, then pin the exact returned token.
  const baseEnv = { ...process.env };
  for (const key of TOKEN_KEYS) delete baseEnv[key];
  // An unnamed account intentionally uses ambient auth before gh's active
  // keyring login. Preserve that documented path, but only for this host's family.
  const host = normalizedHost(account.host);
  const tokenKey = publicTokenHost(host) ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN';
  const implicitToken = !selectedLogin
    ? [tokenKey, tokenKey === 'GH_TOKEN' ? 'GITHUB_TOKEN' : 'GITHUB_ENTERPRISE_TOKEN'].map(key => process.env[key]).find(Boolean)
    : null;
  const resolved = await resolveGitHubAccountEnv({ ...account, host, login: selectedLogin }, { baseEnv }).catch(() => null);
  if (!resolved?.env) throw unavailable();
  const token = implicitToken || TOKEN_KEYS.map(key => resolved.env[key]).find(Boolean)
    || await execGh(['auth', 'token', '--hostname', host], TIMEOUT_MS, { env: resolved.env }).catch(() => null);
  if (!token) throw unavailable();
  // Empty the other families as well: the runner and login-shell paths union
  // this delta onto their own inherited env before starting the provider.
  const overlay = {
    ...Object.fromEntries(TOKEN_KEYS.map(key => [key, ''])),
    GH_HOST: host,
    [tokenKey]: token,
  };
  const raw = await execGh(['api', 'user', '--hostname', host, '--jq', '{id,login,name,email}'], TIMEOUT_MS,
    { env: { ...baseEnv, ...overlay } }).catch(() => null);
  const identity = safeJSONParse(raw, null, { logError: false });
  if (typeof identity?.login !== 'string' || !identity.login || !/^\d+$/.test(String(identity.id || ''))
    || (selectedLogin && !sameLogin(identity.login, selectedLogin))) throw unavailable();
  const latest = await getAccount(binding.accountId).catch(() => null);
  if (!latest || !permitted(latest) || normalizedHost(latest.host) !== host || !sameLogin(latest.login, account.login)) throw unavailable();
  const email = host === 'github.com'
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
