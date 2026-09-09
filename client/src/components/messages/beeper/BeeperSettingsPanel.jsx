import { useCallback, useEffect, useState } from 'react';
import { Save, Loader2, MessageCircle, ShieldCheck, ShieldAlert, RefreshCw, Clock, Link2, Unlink, HardDrive, Download } from 'lucide-react';
import toast from '../../ui/Toast';
import Modal from '../../ui/Modal';
import BrailleSpinner from '../../BrailleSpinner';
import { useBeeperSettings } from '../../../hooks/useBeeperSettings';
import useMounted from '../../../hooks/useMounted';
import ConnectionStatusDot from '../../ui/ConnectionStatusDot';
import BeeperOutboxBreakerBanner from './BeeperOutboxBreakerBanner';
import { formatBytes, formatClockTime } from '../../../utils/formatters';
import {
  getBeeperStatus, checkBeeperConnection, startBeeperOAuth, saveBeeperToken, disconnectBeeper,
  getBeeperAttachmentSummary, backfillBeeperAttachments,
} from '../../../services/api';

// The Beeper connection story (#30 + #31, fork issue #1): ingestion settings,
// the tri-state status card, the connect flow, token expiry, and the read-only
// account roster #27's schema mirrors. #35 turned `/messages/beeper` into the
// chat surface itself, so this MOVED off the page body and into a settings
// drawer over it — the same treatment iMessage gives its own ingestion config
// (`?settings=1`). It is reachable, not removed: an actionable fault renders
// HERE and never as a global banner (#12 decision 4).
//
// Two connect paths, both first-class (#11 decision 3): OAuth, which PortOS
// runs itself, and pasting a token, which is the only way to get one that never
// expires. Neither ever puts a token value into this component's state beyond
// the paste field the user typed it into, and no response here carries one.
// The OAuth *outcome* is read off the URL by the page shell, which is mounted
// whether or not this drawer is open — Beeper's consent screen redirects the
// browser back to the page, not to the drawer.
//
// `realtime` is a PROP, not a subscription this panel opens itself. Several
// Beeper surfaces may each pair their own useBeeperRealtime subscribe/
// unsubscribe (client/src/hooks/README.md sanctions this — see
// useBeeperOutbox, mounted inside BeeperChatSurface); the page-level instance
// in BeeperTab is the one that owns the status card, so this drawer just
// reads what it's handed rather than opening a second one.
export default function BeeperSettingsPanel({ realtime: realtimeProp = null, onRealtimeSeed, onBreakerCleared }) {
  const {
    loading: settingsLoading, form, setForm, saving, dirty, save, loadFailed: settingsLoadFailed,
  } = useBeeperSettings();
  const [status, setStatus] = useState(null);
  // Distinguishes "the GET failed" from "the GET succeeded and says no token
  // is configured" — the absent-vs-empty rule (root AGENTS.md). Collapsing
  // both into `status = null` would tell a working-token install to
  // "Connect Beeper" just because the status request itself errored.
  const [statusError, setStatusError] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusRetrying, setStatusRetrying] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [pastedToken, setPastedToken] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const mountedRef = useMounted();

  const loadStatus = useCallback(async () => {
    const [result, error] = await getBeeperStatus({ silent: true })
      .then((value) => [value, null])
      .catch((err) => [null, err]);
    if (!mountedRef.current) return;
    setStatus(result);
    setStatusError(error ? (error?.message || 'Could not read Beeper status') : null);
    setStatusLoading(false);
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Transport liveness (#33). The socket is the live source; the status GET
  // carries the same snapshot, handed up so the dot is right before the first
  // socket frame lands.
  useEffect(() => {
    if (status?.realtime) onRealtimeSeed?.(status.realtime);
  }, [status?.realtime, onRealtimeSeed]);

  const retryStatus = async () => {
    setStatusRetrying(true);
    await loadStatus();
    if (mountedRef.current) setStatusRetrying(false);
  };

  const handleSave = async () => {
    if (!await save()) return;
    toast.success('Saved');
    loadStatus();
  };

  // Write paths never retry — a repeat exchange burns an already-used
  // authorization code — so each of these reports its failure once and stops.
  // `silent: true` because the catch owns the toast (client/src/AGENTS.md).
  const handleConnect = async () => {
    setConnecting(true);
    const result = await startBeeperOAuth({ silent: true })
      .catch((err) => ({ error: err?.message || 'Could not start the Beeper connect flow' }));
    if (!mountedRef.current) return;
    setConnecting(false);
    if (result?.error || !result?.authorizationUrl) {
      toast.error(result?.error || 'Could not start the Beeper connect flow');
      return;
    }
    window.open(result.authorizationUrl, '_blank', 'noopener');
    toast.success('Approve the request in the opened Beeper window');
  };

  const handleSaveToken = async (event) => {
    event.preventDefault();
    const token = pastedToken.trim();
    if (!token) return;
    setSavingToken(true);
    const result = await saveBeeperToken(token, { silent: true })
      .catch((err) => ({ error: err?.message || 'Could not save that Beeper token' }));
    if (!mountedRef.current) return;
    setSavingToken(false);
    if (result?.error) {
      toast.error(result.error);
      return;
    }
    setPastedToken('');
    toast.success('Beeper token saved');
    loadStatus();
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    const result = await disconnectBeeper({ silent: true })
      .catch((err) => ({ error: err?.message || 'Could not disconnect Beeper' }));
    if (!mountedRef.current) return;
    setDisconnecting(false);
    setConfirmingDisconnect(false);
    if (result?.error) {
      toast.error(result.error);
      return;
    }
    toast.success('Beeper disconnected');
    loadStatus();
  };

  const connect = {
    onConnect: handleConnect,
    connecting,
    token: pastedToken,
    onTokenChange: setPastedToken,
    onSaveToken: handleSaveToken,
    savingToken,
    onDisconnect: handleDisconnect,
    disconnecting,
    confirmingDisconnect,
    onConfirmDisconnect: setConfirmingDisconnect,
  };

  const handleCheck = async () => {
    setChecking(true);
    const result = await checkBeeperConnection({ silent: true }).catch((err) => ({ ok: false, error: err?.message || 'Could not reach Beeper Desktop' }));
    setChecking(false);
    if (result?.reachable) {
      toast.success(`Beeper Desktop reachable${result.info?.app?.version ? ` — v${result.info.app.version}` : ''}`);
    } else {
      toast.error(result?.error || 'Could not reach Beeper Desktop');
    }
    loadStatus();
  };

  if (settingsLoading) return <BrailleSpinner text="Loading Beeper settings" />;

  // A failed GET must never render as though it read DEFAULTS off this
  // install — `form`/`saved` inside the hook are the hardcoded fallback, not
  // this install's actual config, so hiding the ingestion form (rather than
  // showing it "successfully" pre-filled with defaults) and refusing Save is
  // what keeps a retry from PUTting those defaults over whatever is really
  // stored.
  if (settingsLoadFailed) {
    return (
      <div className="bg-port-card border border-port-error/40 rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert size={16} className="text-port-error" />
          <h3 className="text-sm font-semibold text-white">Could not load Beeper settings</h3>
        </div>
        <p className="text-sm text-port-error">
          Reload the page and try again — saving now would overwrite the stored configuration with defaults.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <MessageCircle size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Beeper ingestion</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Talks to the local Beeper Desktop API (default <code className="text-gray-300">{form.baseUrl}</code>) to
          mirror bridged-network conversations — WhatsApp, Discord, Telegram, Instagram, X, Slack, and more —
          into PortOS. Machine-local; nothing federates to peers. Connecting is handled by the card below —
          the credential is encrypted at rest and never stored in settings.
        </p>

        <div className="space-y-3">
          <label htmlFor="beeper-enabled" className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              id="beeper-enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
              className="w-4 h-4 accent-port-accent"
            />
            Enable scheduled Beeper sync
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="beeper-interval" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Sync interval (minutes)
              </label>
              <input
                id="beeper-interval"
                type="number"
                min={1}
                max={1440}
                value={form.intervalMinutes}
                onChange={(e) => setForm((prev) => ({ ...prev, intervalMinutes: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              />
            </div>
            <div>
              <label htmlFor="beeper-budget" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Attachment budget (GB)
              </label>
              <input
                id="beeper-budget"
                type="number"
                min={0.1}
                step={0.1}
                max={1000}
                value={form.attachmentBudgetGb}
                onChange={(e) => setForm((prev) => ({ ...prev, attachmentBudgetGb: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              />
            </div>
            <div className="sm:col-span-1">
              <label htmlFor="beeper-base-url" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Base URL
              </label>
              <input
                id="beeper-base-url"
                type="text"
                value={form.baseUrl}
                onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono"
              />
            </div>
          </div>

          {/* Loopback-only by default (SEC-2) — a non-loopback base URL would
              carry the Beeper access token off this machine on every request. */}
          <label htmlFor="beeper-allow-non-loopback" className="flex items-start gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              id="beeper-allow-non-loopback"
              type="checkbox"
              checked={form.allowNonLoopbackBaseUrl}
              onChange={(e) => setForm((prev) => ({ ...prev, allowNonLoopbackBaseUrl: e.target.checked }))}
              className="w-4 h-4 mt-0.5 accent-port-accent"
            />
            <span>
              Allow a non-loopback base URL
              <span className="block text-xs text-gray-500">
                Off by default — a non-loopback address sends the Beeper access token off this machine on every request.
              </span>
            </span>
          </label>

          <div className="pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* The outbound runaway breaker (#36) — an actionable fault, so it renders
          on this settings surface with the other actionable faults rather than
          on the chat surface or as a global banner. Absent entirely unless it
          has actually tripped. `onBreakerCleared` (from `BeeperTab`) refreshes
          the page-level snapshot the composer reads, so Send re-enables the
          moment this clears rather than waiting on the composer's own next
          status fetch. */}
      <BeeperOutboxBreakerBanner
        breaker={status?.outbox?.breaker}
        onCleared={() => { loadStatus(); onBreakerCleared?.(); }}
      />

      <AttachmentMirrorCard budgetGb={form.attachmentBudgetGb} settingsDirty={dirty || saving} />

      {statusLoading ? (
        <BrailleSpinner text="Checking Beeper status" />
      ) : (
        <BeeperStatusCard
          status={status}
          realtime={realtimeProp || status?.realtime || null}
          error={statusError}
          connect={connect}
          checking={checking}
          onCheck={handleCheck}
          checkDisabled={dirty || saving}
          onRetryStatus={retryStatus}
          retryingStatus={statusRetrying}
        />
      )}
    </div>
  );
}

// The two connect paths, side by side rather than one behind the other (#11
// decision 3): OAuth is the quick path, pasting is the durable one, because
// Beeper's own UI can mint a token that never expires and nothing in the OAuth
// surface accepts a lifetime. The pasted value goes straight to the vaulted
// write path — it is never echoed back, never stored in settings, and never
// read back into this field.
function BeeperConnectPanel({ connect, submitLabel = 'Connect Beeper' }) {
  return (
    <div className="space-y-4">
      <div>
        <button
          type="button"
          onClick={connect.onConnect}
          disabled={connect.connecting}
          className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {connect.connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
          {connect.connecting ? 'Opening Beeper…' : submitLabel}
        </button>
        <p className="text-xs text-gray-500 mt-1.5">
          Opens Beeper&apos;s approval screen and asks for read and send access. Tokens issued this way expire.
        </p>
      </div>

      <form onSubmit={connect.onSaveToken} className="space-y-2 border-t border-port-border pt-4">
        <label htmlFor="beeper-token" className="block text-xs uppercase tracking-wider text-gray-500">
          Or paste an access token
        </label>
        <p className="text-xs text-gray-500">
          Beeper&apos;s own settings can mint a token that never expires — the one credential the approval
          flow above cannot produce. PortOS stores it encrypted and never shows it again.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            id="beeper-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={connect.token}
            onChange={(e) => connect.onTokenChange(e.target.value)}
            placeholder="Access token"
            className="flex-1 min-w-0 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono"
          />
          <button
            type="submit"
            disabled={!connect.token.trim() || connect.savingToken}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {connect.savingToken ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {connect.savingToken ? 'Saving…' : 'Save token'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Inline two-step confirmation — no window.confirm (client/src/AGENTS.md).
// Disconnecting revokes the credential where the authorization server supports
// it and always deletes the local copy, so it is worth a deliberate second
// click but not a modal.
function DisconnectButton({ connect }) {
  if (!connect.confirmingDisconnect) {
    return (
      <button
        type="button"
        onClick={() => connect.onConfirmDisconnect(true)}
        className="inline-flex items-center justify-center gap-2 min-h-[36px] px-3 py-1.5 bg-port-bg border border-port-border hover:border-port-error text-gray-300 rounded-lg text-xs transition-colors"
      >
        <Unlink size={12} />
        Disconnect
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-gray-400">Forget this Beeper credential?</span>
      <button
        type="button"
        onClick={connect.onDisconnect}
        disabled={connect.disconnecting}
        className="inline-flex items-center justify-center gap-2 min-h-[36px] px-3 py-1.5 bg-port-error/20 hover:bg-port-error/30 text-port-error-text rounded-lg text-xs transition-colors disabled:opacity-40"
      >
        {connect.disconnecting ? <Loader2 size={12} className="animate-spin" /> : <Unlink size={12} />}
        {connect.disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
      </button>
      <button
        type="button"
        onClick={() => connect.onConfirmDisconnect(false)}
        disabled={connect.disconnecting}
        className="min-h-[36px] px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-40"
      >
        Cancel
      </button>
    </div>
  );
}

// Shown whenever a stored token is inside the expiry warning window,
// regardless of whether Beeper Desktop is currently reachable — an expired
// token is exactly as actionable on an unreachable install as on a
// connected one, so this renders in both the `reachable === false` and
// `reachable === true` branches below.
function TokenExpiryNotice({ status }) {
  if (!status?.tokenExpiringSoon) return null;
  const days = status.tokenExpiresInDays;
  const label = Number.isFinite(days) && days <= 0
    ? 'Token has expired — reconnect to keep syncing.'
    : `Token expires in ${days} day(s) — reconnect soon.`;
  return (
    <p className="text-xs text-port-warning flex items-center gap-1.5">
      <Clock size={12} />
      {label}
    </p>
  );
}

// The granted-scopes line (fork issue #78): sits beside `TokenExpiryNotice`
// for the same reason — a read-only grant is exactly the kind of thing that
// should be visible on the card BEFORE a send fails, not discovered from the
// error it causes. `tokenScopes` is always an array (`[]` when unknown), the
// absent-vs-empty rule applied to a source rather than a value: a pasted
// token (#11 decision 3) never carries scopes back from Beeper's own paste
// UI, so `[]` there is honest and gets said out loud; `[]` from anywhere else
// (the legacy plaintext path) has nothing worth claiming, so this renders
// nothing rather than a bogus "no scopes granted" line.
function TokenScopesNotice({ status }) {
  const scopes = Array.isArray(status?.tokenScopes) ? status.tokenScopes : [];
  if (scopes.length === 0) {
    if (status?.tokenSource !== 'pasted') return null;
    return (
      <p className="text-xs text-gray-500">Scopes unknown (pasted token).</p>
    );
  }
  const readOnly = !scopes.includes('write');
  return (
    <div className="space-y-1">
      <p className="text-xs text-gray-500">Scopes: {scopes.join(', ')}</p>
      {readOnly && (
        <p className="text-xs text-port-warning flex items-center gap-1.5">
          <ShieldAlert size={12} />
          Read-only grant — sending will fail.
        </p>
      )}
    </div>
  );
}

// The transport liveness row (#33 decision 4): a Moltworld-shape dot, and — on
// the same card, never in a global banner — the one `app.state` value a human
// has to act on. Rendered in EVERY branch where a token is configured, not only
// the reachable one: the HTTP probe failing is exactly when the socket's own
// liveness and its `needs-login` remedy are worth reading. `initializing` is deliberately absent from the actionable set:
// it was measured lying for 105 continuous seconds on a fully working install,
// so surfacing it would train the user to ignore this line.
const APP_STATE_REMEDY = {
  'needs-login': 'Beeper Desktop needs you to sign in again.',
  'needs-verification': 'Beeper Desktop needs this device verified.',
  'needs-secrets': 'Beeper Desktop is missing its encryption secrets.',
  'needs-cross-signing-setup': 'Beeper Desktop needs cross-signing set up.',
};

// The transport stood down because Beeper answered the upgrade with 401/403.
// Reconnecting could only ever produce the same answer, so the fix is a human's.
const TOKEN_REJECTED_REMEDY = 'Beeper Desktop rejected the stored token — reconnect Beeper.';

// `showRemedy` exists for the one card that IS the remedy: the expired-token
// branch below already says "reconnect Beeper" in its heading, its body and its
// button, and a token that expired is exactly the token the transport's own
// 401 stand-down reports as `authRejected` — so the dot still belongs there
// (it corroborates that the socket is down for that reason and not looping),
// while a fourth copy of the same instruction does not.
function BeeperRealtimeRow({ realtime, showRemedy = true }) {
  // `null` = the transport has not reported yet. Never rendered as offline.
  if (!realtime?.state) return null;
  const remedy = !showRemedy ? null : (realtime.authRejected
    ? TOKEN_REJECTED_REMEDY
    : (realtime.appStateActionable ? APP_STATE_REMEDY[realtime.appState] : null));
  return (
    <div className="space-y-1">
      <ConnectionStatusDot status={realtime.state} label="Realtime:" />
      {remedy && (
        <p className="text-xs text-port-warning flex items-center gap-1.5">
          <ShieldAlert size={12} />
          {remedy}
        </p>
      )}
    </div>
  );
}

/**
 * The sweep-visibility row (#80), rendered in EVERY reachability state
 * alongside `BeeperRealtimeRow` — the drawer card's own copy of the same
 * "Syncing… N of M accounts" / "Last synced HH:MM" strip the chat surface's
 * list header shows, so a user who opened settings instead of the chat
 * surface still sees whether ingestion is doing anything. `null` (no sweep
 * has ever run on this install) renders nothing, same absent-vs-never rule
 * `BeeperRealtimeRow` follows for a transport that has not reported yet.
 */
function SweepStatusRow({ sweep }) {
  if (!sweep) return null;
  if (sweep.running) {
    const total = Number.isFinite(sweep.accountsTotal) ? sweep.accountsTotal : null;
    const done = Number.isFinite(sweep.accountsDone) ? sweep.accountsDone : 0;
    return (
      <p className="text-xs text-gray-400 flex items-center gap-1.5">
        <Loader2 size={12} className="animate-spin" />
        {total === null ? 'Syncing…' : `Syncing… ${done} of ${total} account${total === 1 ? '' : 's'}`}
      </p>
    );
  }
  if (!sweep.finishedAt) return null;
  return (
    <p className="text-xs text-gray-500">
      Last synced {formatClockTime(sweep.finishedAt, { seconds: false })}
    </p>
  );
}

/**
 * The mirrored account roster (#30), rendered in EVERY reachability state.
 *
 * These rows come from `beeper_accounts` — PortOS's own mirror — not from a
 * live call, which is the whole reason #27 stores them: the card is supposed to
 * render with Beeper Desktop closed. Hiding the roster whenever the probe fails
 * threw away information the install already had and made an unreachable app
 * look like an empty one, so reachability is stated on its own line above and
 * the roster stands beside it.
 *
 * Read-only by design: it never offers to add a network. Joined by `accountId`,
 * never by `network`.
 *
 * `accounts: null` (paired with `error`) is a FAILED mirror read, distinct
 * from `accounts: []` (a successful read that legitimately found none yet) —
 * the absent-vs-empty sentinel (root AGENTS.md). Collapsing the two would show
 * "No accounts mirrored yet" for a DB hiccup, which reads as a healthy,
 * disconnected-feeling install rather than the unknown state it actually is.
 */
function AccountRoster({ accounts, error }) {
  if (error) {
    return (
      <div className="space-y-1.5">
        <p className="text-[11px] uppercase tracking-wide text-gray-500">Mirrored accounts</p>
        <p role="alert" data-testid="beeper-roster-unknown" className="text-sm text-port-error">{error}</p>
      </div>
    );
  }
  const rows = Array.isArray(accounts) ? accounts : [];
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">Mirrored accounts</p>
      {rows.length === 0 ? (
        <p data-testid="beeper-roster-empty" className="text-sm text-gray-500">No accounts mirrored yet.</p>
      ) : (
        <ul data-testid="beeper-roster" className="space-y-1.5">
          {rows.map((account) => (
            <li key={account.accountId} className="flex items-center justify-between text-sm text-gray-300 border-t border-port-border pt-1.5 first:border-t-0 first:pt-0">
              <span>{account.displayName || account.accountId}</span>
              <span className="text-xs text-gray-500 uppercase">{account.network || '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Every state the status card can be in, decided at fork issue #11 and
// carried into #30's Acceptance criteria. `reachable` is read with strict
// equality throughout (`=== false` / `=== true` / `=== null`) — never
// truthiness — so the absent-vs-empty sentinel (`null` = not yet probed)
// can never fall through to the "offline" branch. A failed status fetch is
// handled by the `error` branch immediately below, before any of this ever
// runs, so a broken GET can never collapse into "no token configured".
function BeeperStatusCard({
  status, realtime, error, connect, checking, onCheck, checkDisabled, onRetryStatus, retryingStatus,
}) {
  if (error) {
    return (
      <div className="bg-port-card border border-port-error/40 rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert size={16} className="text-port-error" />
          <h3 className="text-sm font-semibold text-white">Could not read Beeper status</h3>
        </div>
        <p role="alert" className="text-sm text-port-error">{error}</p>
        <button
          type="button"
          onClick={onRetryStatus}
          disabled={retryingStatus}
          className="mt-3 inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
        >
          {retryingStatus ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Retry
        </button>
      </div>
    );
  }

  if (!status?.tokenConfigured) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <MessageCircle size={16} className="text-gray-400" />
          <h3 className="text-sm font-semibold text-white">Connect Beeper</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Beeper is a local desktop app that bridges WhatsApp, Discord, Telegram, and other networks into one
          API on this machine — PortOS talks to it over loopback, never over the network.
        </p>
        <BeeperConnectPanel connect={connect} />
      </div>
    );
  }

  // An expired credential is its own state, not a generic API failure: there is
  // no refresh grant anywhere in Beeper's OAuth metadata, so the only way
  // forward is connecting again. Checked BEFORE reachability so a user whose
  // token lapsed while Beeper Desktop happens to be closed still gets the
  // action that fixes it rather than "unreachable".
  if (status.tokenExpired) {
    return (
      <div className="bg-port-card border border-port-warning/40 rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Clock size={16} className="text-port-warning" />
          <h3 className="text-sm font-semibold text-white">Beeper token expired</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Beeper issues no refresh grant, so an expired token is reconnected rather than renewed.
        </p>
        <div className="mb-3"><BeeperRealtimeRow realtime={realtime} showRemedy={false} /></div>
        <BeeperConnectPanel connect={connect} submitLabel="Reconnect Beeper" />
        <div className="mt-4 border-t border-port-border pt-3">
          <DisconnectButton connect={connect} />
        </div>
      </div>
    );
  }

  if (status.reachable === false) {
    return (
      <div className="bg-port-card border border-port-error/40 rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert size={16} className="text-port-error" />
          <h3 className="text-sm font-semibold text-white">Beeper Desktop unreachable</h3>
        </div>
        <p className="text-sm text-port-error">{status.lastProbeError || 'Could not reach Beeper Desktop.'}</p>
        <p className="text-xs text-gray-500 mt-1">Checked against {status.baseUrl}.</p>
        <TokenExpiryNotice status={status} />
        <TokenScopesNotice status={status} />
        <div className="mt-2"><BeeperRealtimeRow realtime={realtime} /></div>
        <div className="mt-1"><SweepStatusRow sweep={status.sweep} /></div>
        {/* The mirror still knows which accounts exist even with Beeper closed. */}
        <div className="mt-3"><AccountRoster accounts={status.accounts} error={status.accountsError} /></div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCheck}
            disabled={checking || checkDisabled}
            title={checkDisabled ? 'Save your changes before rechecking' : undefined}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
          >
            {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Retry
          </button>
          <DisconnectButton connect={connect} />
        </div>
      </div>
    );
  }

  if (status.reachable === true) {
    // Fork issue #61, decision 7: a probe timeout shortly after Beeper
    // Desktop proved itself alive (a real API call, or a live socket ping)
    // stays on THIS card — `reachable` never flips to false for it — with an
    // inline note naming the latency, rather than jumping to the unreachable/
    // actionable-fault card below. The empty-state ("Connect Beeper") and
    // Retry-button branches never see `probeState` at all, so neither can flip
    // on a slow probe.
    const isSlow = status.probeState === 'slow';
    return (
      <div className="bg-port-card border border-port-success/40 rounded-lg p-4 sm:p-6 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-port-success" />
          <h3 className="text-sm font-semibold text-white">Beeper Desktop connected</h3>
          {status.appVersion && <span className="text-xs text-gray-500">v{status.appVersion}</span>}
        </div>
        {isSlow && (
          <p className="text-xs text-port-warning flex items-center gap-1.5">
            <Clock size={12} />
            Slow to respond{Number.isFinite(status.probeLatencyMs) ? ` (${status.probeLatencyMs}ms)` : ''} — Beeper Desktop is up but answered the last check slowly.
          </p>
        )}
        <TokenExpiryNotice status={status} />
        <TokenScopesNotice status={status} />
        <BeeperRealtimeRow realtime={realtime} />
        <SweepStatusRow sweep={status.sweep} />
        <AccountRoster accounts={status.accounts} error={status.accountsError} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCheck}
            disabled={checking || checkDisabled}
            title={checkDisabled ? 'Save your changes before rechecking' : undefined}
            className="inline-flex items-center justify-center gap-2 min-h-[36px] px-3 py-1.5 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-xs transition-colors disabled:opacity-40"
          >
            {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Recheck
          </button>
          <DisconnectButton connect={connect} />
        </div>
      </div>
    );
  }

  // reachable === null: a token is configured but the probe never ran (a
  // transient gap between saving settings and the status refresh landing).
  // Neutral, never rendered as offline.
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6 space-y-2">
      <div className="flex items-center gap-2">
        <Loader2 size={16} className="text-gray-400 animate-spin" />
        <h3 className="text-sm font-semibold text-white">Checking Beeper Desktop…</h3>
      </div>
      <BeeperRealtimeRow realtime={realtime} />
      <SweepStatusRow sweep={status.sweep} />
      <AccountRoster accounts={status.accounts} error={status.accountsError} />
    </div>
  );
}

/**
 * The attachment byte mirror's own card (#37): what is on disk against the
 * budget, and the ONE place a bulk backfill can be started.
 *
 * The backfill is gated behind a consent modal that names the count and the
 * byte size first. That is the root AGENTS.md no-unbidden-work policy applied
 * to bytes rather than to LLM calls, and it is the same split as
 * `meatspacePostDrillCache` / `CacheFillConsentModal`: the incremental
 * fetch-on-view needs no prompt because the user opened the thread, while a
 * from-zero batch of thousands of files does.
 *
 * "Mirror all" gates on the SAVED budget, not the form input: the server reads
 * `settings.beeper.attachmentBudgetGb` when it decides where to stop, so
 * running with an unsaved number would silently use the old one.
 */
function AttachmentMirrorCard({ budgetGb, settingsDirty }) {
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [consentOpen, setConsentOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const mountedRef = useMounted();

  const loadSummary = useCallback(async () => {
    const [result, error] = await getBeeperAttachmentSummary({ silent: true })
      .then((value) => [value, null])
      .catch((err) => [null, err]);
    if (!mountedRef.current) return;
    setSummary(result);
    // "The request failed" and "the mirror is empty" are different answers, and
    // only one of them means the numbers below are trustworthy.
    setSummaryError(error ? (error?.message || 'Could not read the attachment mirror') : null);
    setLoading(false);
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const handleBackfill = async () => {
    setConsentOpen(false);
    setRunning(true);
    const result = await backfillBeeperAttachments({}, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Attachment backfill failed');
      return null;
    });
    if (!mountedRef.current) return;
    setRunning(false);
    if (result) {
      toast.success(
        `Mirrored ${result.fetched} attachment(s)${result.failed ? `, ${result.failed} unavailable` : ''}`
        + `${result.stoppedForBudget ? ' — stopped at the disk budget' : ''}`,
      );
    }
    loadSummary();
  };

  if (loading) return <BrailleSpinner text="Reading the attachment mirror" />;

  const budgetBytes = summary?.budgetBytes || 0;
  const usedBytes = summary?.usedBytes || 0;
  const usedPercent = budgetBytes > 0 ? Math.min(100, Math.round((usedBytes / budgetBytes) * 100)) : 0;
  const pending = summary?.pendingCount || 0;

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6 space-y-3">
      <div className="flex items-center gap-2">
        <HardDrive size={16} className="text-port-accent" />
        <h3 className="text-lg font-semibold text-white">Attachment mirror</h3>
      </div>
      <p className="text-sm text-gray-400">
        Attachment bytes are downloaded when you first open the thread that shows them, kept under the
        {' '}{budgetGb} GB budget above, and evicted least-recently-viewed first — never a file Beeper can no
        longer re-supply, and never one you locked. Photos and files stay on this machine.
      </p>

      {summaryError ? (
        <p className="text-xs text-port-error">{summaryError}</p>
      ) : (
        <>
          <div>
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>{formatBytes(usedBytes)} of {formatBytes(budgetBytes)}</span>
              <span>{summary?.storedFiles || 0} file(s) mirrored</span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-port-bg">
              <div className="h-full rounded-full bg-port-accent" style={{ width: `${usedPercent}%` }} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Not mirrored" value={pending} />
            <Stat label="Kept" value={summary?.keptCount || 0} />
            <Stat label="Over limit" value={summary?.overCapCount || 0} />
            <Stat label="Unavailable" value={summary?.unavailableCount || 0} />
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => setConsentOpen(true)}
              disabled={running || pending === 0 || settingsDirty}
              title={settingsDirty ? 'Save your settings first — the backfill reads the saved budget' : undefined}
              className="inline-flex items-center justify-center gap-2 min-h-[36px] px-3 py-1.5 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-xs transition-colors disabled:opacity-40"
            >
              {running ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {running ? 'Mirroring…' : 'Mirror all attachments'}
            </button>
            <button
              type="button"
              onClick={loadSummary}
              className="inline-flex items-center justify-center gap-2 min-h-[36px] px-3 py-1.5 text-gray-400 hover:text-gray-200 rounded-lg text-xs transition-colors"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
        </>
      )}

      <BackfillConsentModal
        open={consentOpen}
        summary={summary}
        onCancel={() => setConsentOpen(false)}
        onConfirm={handleBackfill}
      />
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded border border-port-border bg-port-bg/50 px-2 py-1.5">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-sm text-gray-200">{value}</p>
    </div>
  );
}

/**
 * Names the cost before the transfer starts: how many attachments, how many
 * bytes, and — separately — how many the bridge never reported a size for, so
 * the total is never quietly presented as complete when it isn't.
 */
function BackfillConsentModal({ open, summary, onCancel, onConfirm }) {
  if (!open || !summary) return null;
  const unknown = summary.pendingUnknownCount || 0;
  return (
    <Modal open={open} onClose={onCancel} size="sm" ariaLabel="Mirror all Beeper attachments">
      <div className="bg-port-card border border-port-border rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Download size={18} className="text-port-accent" />
          <h3 className="text-white font-medium">Mirror all attachments?</h3>
        </div>
        <p className="text-sm text-gray-400">
          PortOS will download <span className="text-gray-200">{summary.pendingCount} attachment(s)</span>
          {' '}from Beeper Desktop — about <span className="text-gray-200">{formatBytes(summary.pendingBytes)}</span>
          {unknown > 0 && <> plus {unknown} whose size Beeper did not report</>}.
          {' '}It stops when the mirror reaches its {formatBytes(summary.budgetBytes)} budget, skips anything over
          {' '}{formatBytes(summary.maxBytes)}, and runs one file at a time so Beeper Desktop stays usable.
        </p>
        <p className="text-xs text-gray-500">
          You do not need this to read attachments: opening a thread mirrors what it shows. This is for having
          them all on disk in advance.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[36px] px-3 text-xs text-gray-400 transition-colors hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-port-accent/20 px-3 text-xs text-port-accent transition-colors hover:bg-port-accent/30"
          >
            <Download size={12} />
            Mirror {summary.pendingCount} attachment(s)
          </button>
        </div>
      </div>
    </Modal>
  );
}
