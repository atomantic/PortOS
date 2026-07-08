import { useEffect, useState } from 'react';
import { Save, Loader2, Lock, ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import {
  getSettings,
  updateSettings,
  getSignalStatus,
  checkSignalSetup,
  syncSignal,
} from '../../services/api';

// Settings → Signal (#2154). Opt-in, machine-local ingestion of Signal Desktop's
// SQLCipher-encrypted chat database into the Tribe touchpoint log + activity
// timeline. OFF by default — reading the DB needs Signal's keychain-wrapped key.
// Highest-fragility source: everything degrades gracefully to an actionable error.
export function SignalTab() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savedInterval, setSavedInterval] = useState(60);
  const [saving, setSaving] = useState(false);

  const [status, setStatus] = useState(null);
  const [setup, setSetup] = useState(null);
  const [checking, setChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    Promise.all([
      getSettings({ silent: true }).catch(() => ({})),
      getSignalStatus({ silent: true }).catch(() => null),
    ])
      .then(([settings, st]) => {
        const c = settings?.signal || {};
        const en = typeof c.enabled === 'boolean' ? c.enabled : false;
        const iv = Number.isFinite(c.intervalMinutes) ? c.intervalMinutes : 60;
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
    const iv = Math.max(1, Math.min(1440, Math.floor(Number(intervalMinutes) || 60)));
    setSaving(true);
    const merged = await updateSettings({ signal: { enabled, intervalMinutes: iv } }).catch(() => null);
    setSaving(false);
    if (!merged) return;
    setIntervalMinutes(iv);
    setSavedEnabled(enabled);
    setSavedInterval(iv);
    toast.success('Saved — scheduler applies on next server restart');
  };

  const handleCheck = async () => {
    setChecking(true);
    const report = await checkSignalSetup({ silent: true }).catch(() => ({ ok: false, error: 'Setup check failed' }));
    setChecking(false);
    setSetup(report);
    if (report?.ok) toast.success(`Signal DB reachable — ${report.messageCount ?? 0} message(s)`);
    else toast.error(report?.error || 'Signal DB not reachable');
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    const result = await syncSignal({ silent: true }).catch(() => ({ ok: false, error: 'Sync failed' }));
    setSyncing(false);
    if (result?.ok) {
      toast.success(`Synced: ${result.recorded} event(s), ${result.touchpointsCreated} touchpoint(s)${result.hasMore ? ' — more history remains, run again' : ''}`);
      setStatus((prev) => ({ ...(prev || {}), state: { ...(prev?.state || {}), cursorRowid: result.cursorRowid, lastResult: result, lastRunAt: new Date().toISOString() } }));
    } else {
      toast.error(result?.error || 'Sync failed');
      setSetup(result);
    }
  };

  if (loading) return <BrailleSpinner />;

  const lastResult = status?.state?.lastResult;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Lock size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Signal Desktop ingestion</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Reads your local Signal Desktop chat database
          (<code className="text-gray-300">~/Library/Application Support/Signal</code>) — decrypting its
          SQLCipher store with the keychain-wrapped key — and feeds both Tribe touchpoints and the activity timeline.
          Machine-local; nothing federates to peers. Signal never stores an API for this, so PortOS reads a
          temporary decrypted <strong>copy</strong> and never touches the live database.
          This is the most fragile source: if a Signal update changes its key or storage format, ingestion
          degrades to an actionable error rather than failing hard.
        </p>

        <div className="space-y-3">
          <label htmlFor="signal-enabled" className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              id="signal-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 accent-port-accent"
            />
            Enable scheduled Signal sync
          </label>

          <div>
            <label htmlFor="signal-interval" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Sync interval (minutes)
            </label>
            <input
              id="signal-interval"
              type="number"
              min={1}
              max={1440}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(e.target.value)}
              className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
            />
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
              onClick={handleCheck}
              disabled={checking}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {checking ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Check setup
            </button>
            <button
              type="button"
              onClick={handleSyncNow}
              disabled={syncing}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
            >
              {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Sync now
            </button>
          </div>
        </div>
      </div>

      {setup && (
        <div className={`bg-port-card border rounded-lg p-4 sm:p-6 ${setup.ok ? 'border-port-success/40' : 'border-port-error/40'}`}>
          <div className="flex items-center gap-2 mb-2">
            {setup.ok
              ? <ShieldCheck size={16} className="text-port-success" />
              : <ShieldAlert size={16} className="text-port-error" />}
            <h3 className="text-sm font-semibold text-white">{setup.ok ? 'Setup OK' : 'Setup blocked'}</h3>
          </div>
          {setup.ok ? (
            <p className="text-sm text-gray-300">
              Signal DB reachable — {setup.messageCount ?? 0} message(s){setup.keySource ? ` (key via ${setup.keySource})` : ''}.
            </p>
          ) : (
            <div className="text-sm text-gray-300 space-y-2">
              <p className="text-port-error">{setup.error}</p>
              {setup.remediation && <p className="text-gray-400">{setup.remediation}</p>}
            </div>
          )}
        </div>
      )}

      {(lastResult || status?.state?.cursorRowid > 0) && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-white mb-2">Last sync</h3>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div><dt className="text-gray-500 text-xs uppercase">Cursor rowid</dt><dd className="text-gray-200">{status?.state?.cursorRowid ?? 0}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Events recorded</dt><dd className="text-gray-200">{lastResult?.recorded ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Touchpoints</dt><dd className="text-gray-200">{lastResult?.touchpointsCreated ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Scanned</dt><dd className="text-gray-200">{lastResult?.scanned ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Key source</dt><dd className="text-gray-200">{lastResult?.keySource ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Last run</dt><dd className="text-gray-200">{status?.state?.lastRunAt ? new Date(status.state.lastRunAt).toLocaleString() : '—'}</dd></div>
          </dl>
        </div>
      )}
    </div>
  );
}

export default SignalTab;
