import { useState } from 'react';
import { Link } from 'react-router';
import { Save, Loader2, MessageSquare, ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { formatDateTime } from '../../utils/formatters';
import { useSyncSourceSettings } from '../../hooks/useSyncSourceSettings';
import {
  getImessageStatus,
  checkImessageSetup,
  syncImessage,
} from '../../services/api';

// iMessage ingestion settings (#2151). Opt-in, machine-local ingestion of the
// macOS Messages database (chat.db) into the Tribe touchpoint log + activity
// timeline. OFF by default — reading chat.db needs macOS Full Disk Access.
//
// Hosted as a right-side Drawer on Comms → Messages → iMessage rather than its
// own Settings page, so the config sits next to the data it governs (same
// pattern as Media Gen Settings over the Image page). `onSynced` lets the host
// page refresh its conversation list after a sync run from in here.
export function IMessageSettingsPanel({ onSynced }) {
  const {
    loading, enabled, setEnabled, intervalMinutes, setIntervalMinutes, saving,
    status, setStatus, dirty, save,
  } = useSyncSourceSettings({ domain: 'imessage', defaultInterval: 30, getStatus: getImessageStatus });
  const [setup, setSetup] = useState(null);
  const [checking, setChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const handleSave = async () => {
    if (!await save()) return;
    toast.success('Saved');
  };

  const handleCheck = async () => {
    setChecking(true);
    const report = await checkImessageSetup({ silent: true }).catch(() => ({ ok: false, error: 'Setup check failed' }));
    setChecking(false);
    setSetup(report);
    if (report?.ok) toast.success(`chat.db reachable — ${report.messageCount ?? 0} message(s)`);
    else toast.error(report?.fullDiskAccessRequired ? 'Full Disk Access required' : 'chat.db not reachable');
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    const result = await syncImessage({ silent: true }).catch(() => ({ ok: false, error: 'Sync failed' }));
    setSyncing(false);
    if (result?.ok) {
      toast.success(`Synced: ${result.recorded} event(s), ${result.touchpointsCreated} touchpoint(s)${result.hasMore ? ' — more history remains, run again' : ''}`);
      setStatus((prev) => ({ ...(prev || {}), state: { ...(prev?.state || {}), cursorRowid: result.cursorRowid, lastResult: result, lastRunAt: new Date().toISOString() } }));
      onSynced?.();
    } else {
      toast.error(result?.fullDiskAccessRequired ? 'Full Disk Access required' : (result?.error || 'Sync failed'));
      setSetup(result);
    }
  };

  if (loading) return <BrailleSpinner />;

  const lastResult = status?.state?.lastResult;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">iMessage ingestion</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Reads your local macOS Messages database (<code className="text-gray-300">~/Library/Messages/chat.db</code>) read-only
          and feeds both Tribe touchpoints and the activity timeline. Machine-local — nothing federates to peers.
          Requires macOS <strong>Full Disk Access</strong> for the process running PortOS.
          Browse, purge spam, and manage ingested events on the page behind this panel
          — deletes there remove PortOS copies only, never Apple Messages.
          For names instead of phone numbers, sync{' '}
          <Link to="/messages/contacts" className="text-port-accent hover:underline">Comms → Contacts</Link>
          {' '}(and optionally fill Tribe phones/emails).
        </p>

        <div className="space-y-3">
          <label htmlFor="imessage-enabled" className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              id="imessage-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 accent-port-accent"
            />
            Enable scheduled iMessage sync
          </label>

          <div>
            <label htmlFor="imessage-interval" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Sync interval (minutes)
            </label>
            <input
              id="imessage-interval"
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
            <p className="text-sm text-gray-300">chat.db reachable at <code className="text-gray-400">{setup.dbPath}</code> — {setup.messageCount ?? 0} message(s).</p>
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
            <div><dt className="text-gray-500 text-xs uppercase">Cursor ROWID</dt><dd className="text-gray-200">{status?.state?.cursorRowid ?? 0}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Events recorded</dt><dd className="text-gray-200">{lastResult?.recorded ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Touchpoints</dt><dd className="text-gray-200">{lastResult?.touchpointsCreated ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Scanned</dt><dd className="text-gray-200">{lastResult?.scanned ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Decode skips</dt><dd className="text-gray-200">{lastResult?.decodeFailures ?? '—'}</dd></div>
            <div><dt className="text-gray-500 text-xs uppercase">Last run</dt><dd className="text-gray-200">{formatDateTime(status?.state?.lastRunAt, '—')}</dd></div>
          </dl>
          {lastResult?.hasMore && (
            <p className="mt-3 text-xs text-port-warning">
              More history remains in chat.db — run Sync now again until the cursor catches up.
              First batches are often older messages; open{' '}
              <Link to="/timeline" className="text-port-accent hover:underline">Timeline</Link>
              {' '}on those dates, or close this panel to browse by conversation.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default IMessageSettingsPanel;
