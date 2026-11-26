import { ExternalLink } from 'lucide-react';
import { formatDateTime } from '../../utils/formatters';
import { isHttpsUrl } from '../../utils/urlNormalize';

const BUTTON_CLASS = 'px-3 py-1.5 text-sm rounded transition-colors bg-port-accent/20 text-port-accent hover:bg-port-accent/30 disabled:opacity-50 disabled:cursor-not-allowed';

const quotaText = (window) => {
  if (!window || typeof window !== 'object') return null;
  const used = typeof window.usedPercent === 'number' ? Math.max(0, Math.min(100, Math.round(window.usedPercent))) : null;
  const label = typeof window.limitName === 'string' && window.limitName.trim() ? window.limitName.trim() : 'Usage window';
  const reset = typeof window.resetsAt === 'string' && window.resetsAt.trim() ? ` · resets ${window.resetsAt.trim()}` : '';
  return used === null ? `${label}${reset}` : `${label}: ${used}% used${reset}`;
};

const ACCOUNT_STATUS_HELP = {
  'runtime-missing': 'Install Codex CLI from the runtime control below.',
  'signed-out': 'Sign in with ChatGPT to use this subscription.',
  'reauth-required': 'Sign in with ChatGPT to use this subscription.',
  'quota-exhausted': 'Wait for a reported usage window to reset, then check the account again.',
  'login-pending': 'Finish sign-in in the opened browser or use the device-code fallback.',
  ready: 'This provider uses ChatGPT subscription limits, not an OpenAI API key.',
  unknown: 'Check the account again. PortOS could not determine this state.',
};

export default function CodexSubscriptionPanel({ codex = {}, provider, routingOverridden }) {
  const { account, models } = codex;
  const status = account?.status || 'unknown';
  const login = account?.login;
  const windows = [quotaText(account?.rateLimits?.primary), quotaText(account?.rateLimits?.secondary)].filter(Boolean);
  const catalogCount = Array.isArray(models?.models) ? models.models.length : null;
  const modelError = models?.error;

  return (
    <div className="max-w-3xl text-xs rounded border border-port-border bg-port-bg/50 px-3 py-2.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-gray-200">ChatGPT subscription</p>
        <span className="text-gray-400">{account?.account?.planType ? `${account.account.planType} plan` : status.replaceAll('-', ' ')}</span>
      </div>
      <p className="text-gray-400">{Object.hasOwn(ACCOUNT_STATUS_HELP, status) ? ACCOUNT_STATUS_HELP[status] : ACCOUNT_STATUS_HELP.unknown}</p>
      {windows.length > 0 && <p className="text-gray-400">{windows.join(' · ')}</p>}
      {routingOverridden && (
        <p className="text-port-warning">
          These are this ChatGPT account’s limits. Your Codex config re-points model routing, so PortOS
          runs on this provider may not be counted here.
        </p>
      )}
      {typeof account?.checkedAt === 'number' && <p className="text-gray-500">Last usage refresh: {formatDateTime(account.checkedAt)}</p>}
      {catalogCount !== null && <p className="text-gray-500">Subscription catalog: {catalogCount} model{catalogCount === 1 ? '' : 's'} available.</p>}
      {modelError && <p role="status" className="text-port-warning">Using the last known model catalog while a refresh is unavailable.</p>}
      <CodexSubscriptionLoginLinks login={login} onCopyCode={codex.onCopyCode} />
      <CodexSubscriptionActions codex={codex} provider={provider} status={status} login={login} />
    </div>
  );
}

function CodexSubscriptionLoginLinks({ login, onCopyCode }) {
  const verificationUrl = isHttpsUrl(login?.verificationUrl) ? login.verificationUrl : null;
  const authUrl = isHttpsUrl(login?.authUrl) ? login.authUrl : null;
  return (
    <>
      {verificationUrl && (
        <div className="rounded bg-port-card px-2.5 py-2 text-gray-300 space-y-1">
          <p>Headless sign-in: open the verification page and enter this code.</p>
          {login.userCode && (
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-port-accent font-semibold">{login.userCode}</code>
              <button type="button" className={BUTTON_CLASS} onClick={() => onCopyCode?.(login.userCode)}>Copy code</button>
            </div>
          )}
          <a className="inline-flex items-center gap-1 text-port-accent hover:underline" href={verificationUrl} target="_blank" rel="noreferrer">
            Open verification page <ExternalLink size={12} />
          </a>
        </div>
      )}
      {authUrl && (
        <a className="inline-flex items-center gap-1 text-port-accent hover:underline" href={authUrl} target="_blank" rel="noreferrer">
          Open ChatGPT sign-in <ExternalLink size={12} />
        </a>
      )}
    </>
  );
}

function CodexSubscriptionActions({ codex, provider, status, login }) {
  const { loading, loginLoading, onCheck, onSignIn, onCancel, onLogout, onRefreshModels, onEnable } = codex;
  const canSignIn = ['signed-out', 'reauth-required', 'unknown'].includes(status);
  const signInBusy = loading || loginLoading;
  return (
    <div className="flex flex-wrap gap-2">
      {canSignIn && (
        <button type="button" className={BUTTON_CLASS} disabled={signInBusy} onClick={() => onSignIn?.(false)}>
          {loginLoading ? 'Starting sign-in…' : 'Sign in with ChatGPT'}
        </button>
      )}
      {(canSignIn || status === 'login-pending') && (
        <button type="button" className="px-3 py-1.5 text-sm rounded transition-colors bg-port-border hover:bg-port-border/80 text-white disabled:opacity-50" disabled={signInBusy} onClick={() => onSignIn?.(true)}>
          Use device code
        </button>
      )}
      {status === 'login-pending' && login?.loginId && (
        <button type="button" className="px-3 py-1.5 text-sm rounded transition-colors bg-port-warning/20 text-port-warning hover:bg-port-warning/30 disabled:opacity-50" disabled={signInBusy} onClick={() => onCancel?.(login.loginId)}>
          Cancel sign-in
        </button>
      )}
      {status === 'ready' && (
        <>
          {provider.textTransportEnabled !== true && (
            <button type="button" className={BUTTON_CLASS} disabled={loading} onClick={() => onEnable?.(provider)}>
              Enable subscription transport
            </button>
          )}
          <button type="button" className={BUTTON_CLASS} disabled={loading} onClick={onRefreshModels}>Refresh subscription models</button>
          <button type="button" className="px-3 py-1.5 text-sm rounded transition-colors bg-port-warning/20 text-port-warning hover:bg-port-warning/30 disabled:opacity-50" disabled={loading} onClick={onLogout}>Log out</button>
        </>
      )}
      {(status === 'quota-exhausted' || status === 'unknown') && (
        <button type="button" className={BUTTON_CLASS} disabled={loading} onClick={onCheck}>{loading ? 'Checking…' : 'Check account'}</button>
      )}
    </div>
  );
}
