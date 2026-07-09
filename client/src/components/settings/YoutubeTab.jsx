import { useEffect, useState } from 'react';
import { Save, Loader2, MonitorPlay, RefreshCw, CheckCircle2, AlertCircle, ShieldQuestion } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import {
  getSettings,
  updateSettings,
  getYoutubeStatus,
  getYoutubeSetupCheck,
  syncYoutube,
} from '../../services/api';

// Settings → YouTube (#2153). Opt-in, machine-local ingestion of YouTube watch
// history into the activity timeline. OFF by default — the YouTube watch-history
// API is gone, so this scrapes the signed-in history page in the managed browser.
// Requires being logged into YouTube there; the Takeout backfill on the Timeline
// page is the reliable historical path.
export function YoutubeTab() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(480);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savedInterval, setSavedInterval] = useState(480);
  const [saving, setSaving] = useState(false);

  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [setup, setSetup] = useState(null);

  useEffect(() => {
    Promise.all([
      getSettings({ silent: true }).catch(() => ({})),
      getYoutubeStatus({ silent: true }).catch(() => null),
    ])
      .then(([settings, st]) => {
        const c = settings?.youtube || {};
        const en = typeof c.enabled === 'boolean' ? c.enabled : false;
        const iv = Number.isFinite(c.intervalMinutes) ? c.intervalMinutes : 480;
        setEnabled(en);
        setIntervalMinutes(iv);
        setSavedEnabled(en);
        setSavedInterval(iv);
        setStatus(st);
      })
      .finally(() => setLoading(false));
  }, []);

  const dirty = enabled !== savedEnabled || Number(intervalMinutes) !== Number(savedInterval);

  const handleSave = async () => {
    const iv = Math.max(1, Math.min(1440, Math.floor(Number(intervalMinutes) || 480)));
    setSaving(true);
    const merged = await updateSettings({ youtube: { enabled, intervalMinutes: iv } }).catch(() => null);
    setSaving(false);
    if (!merged) return;
    setIntervalMinutes(iv);
    setSavedEnabled(enabled);
    setSavedInterval(iv);
    toast.success('Saved — scheduler applies on next server restart');
  };

  const handleCheckSetup = async () => {
    setChecking(true);
    const result = await getYoutubeSetupCheck({ silent: true }).catch(() => null);
    setChecking(false);
    setSetup(result);
    if (result?.ok) toast.success('Signed into YouTube in the managed browser');
    else if (result) toast.error(result.error || 'YouTube not ready');
    else toast.error('Setup check failed');
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    const result = await syncYoutube({ silent: true }).catch(() => ({ ok: false, error: 'Sync failed' }));
    setSyncing(false);
    if (result?.ok) {
      toast.success(`Scraped ${result.scanned} entr${result.scanned === 1 ? 'y' : 'ies'} — ${result.recorded} new watch(es)`);
      setStatus((prev) => ({ ...(prev || {}), state: { ...(prev?.state || {}), lastResult: result, lastRunAt: new Date().toISOString() } }));
    } else {
      toast.error(result?.needsAuth ? 'Log into YouTube in the managed browser first' : (result?.error || 'Sync failed'));
    }
  };

  if (loading) return <BrailleSpinner />;

  const lastResult = status?.state?.lastResult;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <MonitorPlay size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">YouTube watch history</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Scrapes your{' '}
          <a href="https://www.youtube.com/feed/history" target="_blank" rel="noreferrer" className="text-port-accent hover:underline">
            YouTube history
          </a>{' '}
          in the managed browser and feeds the activity timeline (taste signal for the digital twin). There is no
          watch-history API, so this reads the signed-in page — log into YouTube in the managed browser first.
          Machine-local — nothing federates to peers. For full historical data, use the Google Takeout backfill on
          the Timeline page.
        </p>

        {/* Step 1 — sign in / setup check */}
        <div className="space-y-3 border-b border-port-border pb-5 mb-5">
          <h4 className="text-sm font-semibold text-gray-200">1. Sign into YouTube in the managed browser</h4>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCheckSetup}
              disabled={checking}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {checking ? <Loader2 size={14} className="animate-spin" /> : <ShieldQuestion size={14} />}
              Check setup
            </button>
            {setup && (
              setup.ok ? (
                <span className="inline-flex items-center gap-1.5 text-port-success text-sm"><CheckCircle2 size={14} /> Signed in &amp; ready</span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-port-warning text-sm"><AlertCircle size={14} /> {setup.error || 'Not ready'}</span>
              )
            )}
          </div>
          {setup && !setup.ok && setup.remediation && (
            <p className="text-xs text-gray-500">{setup.remediation}</p>
          )}
        </div>

        {/* Step 2 — schedule */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-200">2. Scheduled scrape</h4>
          <label htmlFor="youtube-enabled" className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              id="youtube-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 accent-port-accent"
            />
            Enable scheduled YouTube scrape
          </label>

          <div>
            <label htmlFor="youtube-interval" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Scrape interval (minutes)
            </label>
            <input
              id="youtube-interval"
              type="number"
              min={1}
              max={1440}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(e.target.value)}
              className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              The history page only shows day-bucketed entries — a few times a day (e.g. 480 min) is plenty. Be a polite scraper.
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
              disabled={syncing}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Scrape now
            </button>
          </div>
        </div>
      </div>

      {lastResult && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-white mb-2">Last scrape</h3>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div><dt className="text-gray-500 text-xs uppercase">Watches recorded</dt><dd className="text-gray-200">{lastResult?.recorded ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Entries scanned</dt><dd className="text-gray-200">{lastResult?.scanned ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Status</dt><dd className="text-gray-200">{lastResult?.ok ? 'ok' : (lastResult?.error || lastResult?.status || 'error')}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Last run</dt><dd className="text-gray-200">{status?.state?.lastRunAt ? new Date(status.state.lastRunAt).toLocaleString() : '—'}</dd></div>
          </dl>
        </div>
      )}
    </div>
  );
}

export default YoutubeTab;
