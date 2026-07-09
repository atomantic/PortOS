import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Save, Loader2, Music, Link2, LogOut, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import {
  getSettings,
  updateSettings,
  getSpotifyStatus,
  getSpotifyAuthUrl,
  saveSpotifyCredentials,
  clearSpotifyAuth,
  syncSpotify,
} from '../../services/api';

// Settings → Spotify (#2152). Opt-in, machine-local ingestion of Spotify
// listening history (recently-played) into the activity timeline. OFF by
// default — requires a user-created Spotify developer app + OAuth connection.
export function SpotifyTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(25);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savedInterval, setSavedInterval] = useState(25);
  const [saving, setSaving] = useState(false);

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [savingCreds, setSavingCreds] = useState(false);

  const [status, setStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const loadStatus = () => getSpotifyStatus({ silent: true }).catch(() => null).then((st) => { if (st) setStatus(st); return st; });

  useEffect(() => {
    Promise.all([
      getSettings({ silent: true }).catch(() => ({})),
      getSpotifyStatus({ silent: true }).catch(() => null),
    ])
      .then(([settings, st]) => {
        const c = settings?.spotify || {};
        const en = typeof c.enabled === 'boolean' ? c.enabled : false;
        const iv = Number.isFinite(c.intervalMinutes) ? c.intervalMinutes : 25;
        setEnabled(en);
        setIntervalMinutes(iv);
        setSavedEnabled(en);
        setSavedInterval(iv);
        setStatus(st);
      })
      .finally(() => setLoading(false));
  }, []);

  // Surface the OAuth callback outcome (the browser redirect lands back here).
  useEffect(() => {
    if (searchParams.get('oauthConnected')) {
      toast.success('Spotify connected');
      loadStatus();
      searchParams.delete('oauthConnected');
      setSearchParams(searchParams, { replace: true });
    } else if (searchParams.get('oauthError')) {
      toast.error(`Spotify connect failed: ${searchParams.get('oauthError')}`);
      searchParams.delete('oauthError');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const dirty = enabled !== savedEnabled || Number(intervalMinutes) !== Number(savedInterval);
  const auth = status?.auth;

  const handleSave = async () => {
    const iv = Math.max(1, Math.min(1440, Math.floor(Number(intervalMinutes) || 25)));
    setSaving(true);
    const merged = await updateSettings({ spotify: { enabled, intervalMinutes: iv } }).catch(() => null);
    setSaving(false);
    if (!merged) return;
    setIntervalMinutes(iv);
    setSavedEnabled(enabled);
    setSavedInterval(iv);
    toast.success('Saved — scheduler applies on next server restart');
  };

  const handleSaveCreds = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error('Enter both client ID and client secret');
      return;
    }
    setSavingCreds(true);
    const result = await saveSpotifyCredentials(
      { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
      { silent: true },
    ).catch(() => null);
    setSavingCreds(false);
    if (!result) { toast.error('Failed to save credentials'); return; }
    toast.success('Spotify credentials saved');
    setClientSecret('');
    loadStatus();
  };

  const handleConnect = async () => {
    setConnecting(true);
    const result = await getSpotifyAuthUrl({ silent: true }).catch(() => null);
    setConnecting(false);
    if (result?.url) {
      window.location.href = result.url;
    } else {
      toast.error('Save your Spotify credentials first');
    }
  };

  const handleDisconnect = async () => {
    const result = await clearSpotifyAuth({ silent: true }).catch(() => null);
    if (result?.cleared) {
      toast.success('Spotify disconnected');
      loadStatus();
    } else {
      toast.error('Failed to disconnect');
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    const result = await syncSpotify({ silent: true }).catch(() => ({ ok: false, error: 'Sync failed' }));
    setSyncing(false);
    if (result?.ok) {
      toast.success(`Synced: ${result.recorded} listen(s)${result.hasMore ? ' — more history remains, run again' : ''}`);
      setStatus((prev) => ({ ...(prev || {}), state: { ...(prev?.state || {}), cursorAfter: result.cursorAfter, lastResult: result, lastRunAt: new Date().toISOString() } }));
    } else {
      toast.error(result?.needsAuth ? 'Connect Spotify first' : (result?.error || 'Sync failed'));
    }
  };

  if (loading) return <BrailleSpinner />;

  const lastResult = status?.state?.lastResult;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Music size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Spotify listening history</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Polls your Spotify recently-played tracks and feeds the activity timeline (taste signal for the digital
          twin). Machine-local — nothing federates to peers. Requires a free{' '}
          <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer" className="text-port-accent hover:underline">
            Spotify developer app
          </a>{' '}
          — create one, add the redirect URI below, then paste its client ID and secret.
        </p>

        {/* Step 1 — developer app credentials */}
        <div className="space-y-3 border-b border-port-border pb-5 mb-5">
          <h4 className="text-sm font-semibold text-gray-200">1. Developer app credentials</h4>
          {auth?.redirectUri && (
            <p className="text-xs text-gray-500">
              Add this exact redirect URI in your Spotify app settings:{' '}
              <code className="text-gray-300 break-all">{auth.redirectUri}</code>
            </p>
          )}
          <div>
            <label htmlFor="spotify-client-id" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Client ID
            </label>
            <input
              id="spotify-client-id"
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={auth?.hasCredentials ? '•••••••• (saved — re-enter to change)' : 'Spotify app client ID'}
              className="w-full max-w-md px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
          </div>
          <div>
            <label htmlFor="spotify-client-secret" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Client secret
            </label>
            <input
              id="spotify-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={auth?.hasCredentials ? '•••••••• (saved — re-enter to change)' : 'Spotify app client secret'}
              className="w-full max-w-md px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
          </div>
          <button
            type="button"
            onClick={handleSaveCreds}
            disabled={savingCreds}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40"
          >
            {savingCreds ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save credentials
          </button>
        </div>

        {/* Step 2 — connect via OAuth */}
        <div className="space-y-3 border-b border-port-border pb-5 mb-5">
          <h4 className="text-sm font-semibold text-gray-200">2. Connect your Spotify account</h4>
          <div className="flex items-center gap-2 text-sm">
            {auth?.hasTokens ? (
              <span className="inline-flex items-center gap-1.5 text-port-success"><CheckCircle2 size={14} /> Connected</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-gray-400"><AlertCircle size={14} /> Not connected</span>
            )}
            {auth?.expiresAt && <span className="text-gray-500 text-xs">token expires {new Date(auth.expiresAt).toLocaleString()}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting || !auth?.hasCredentials}
              title={!auth?.hasCredentials ? 'Save credentials first' : undefined}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
              {auth?.hasTokens ? 'Reconnect' : 'Connect Spotify'}
            </button>
            {auth?.hasTokens && (
              <button
                type="button"
                onClick={handleDisconnect}
                className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-error text-gray-200 rounded-lg text-sm transition-colors"
              >
                <LogOut size={14} /> Disconnect
              </button>
            )}
          </div>
        </div>

        {/* Step 3 — schedule */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-200">3. Scheduled sync</h4>
          <label htmlFor="spotify-enabled" className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              id="spotify-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 accent-port-accent"
            />
            Enable scheduled Spotify sync
          </label>

          <div>
            <label htmlFor="spotify-interval" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Sync interval (minutes)
            </label>
            <input
              id="spotify-interval"
              type="number"
              min={1}
              max={1440}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(e.target.value)}
              className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              Spotify only exposes the last 50 plays — keep this under ~25 min so no listens are missed.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleSyncNow}
              disabled={syncing || !auth?.hasTokens}
              title={!auth?.hasTokens ? 'Connect Spotify first' : undefined}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Sync now
            </button>
          </div>
        </div>
      </div>

      {(lastResult || status?.state?.cursorAfter > 0) && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-white mb-2">Last sync</h3>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div><dt className="text-gray-500 text-xs uppercase">Listens recorded</dt><dd className="text-gray-200">{lastResult?.recorded ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Scanned</dt><dd className="text-gray-200">{lastResult?.scanned ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">More remaining</dt><dd className="text-gray-200">{lastResult?.hasMore ? 'yes' : 'no'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Last run</dt><dd className="text-gray-200">{status?.state?.lastRunAt ? new Date(status.state.lastRunAt).toLocaleString() : '—'}</dd></div>
          </dl>
        </div>
      )}
    </div>
  );
}

export default SpotifyTab;
