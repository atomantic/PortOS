import { useState } from 'react';
import { Loader2, Save, ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import SettingsLoadError from '../ui/SettingsLoadError';
import UnreadableSyncStateNotice from '../ui/UnreadableSyncStateNotice';
import BrailleSpinner from '../BrailleSpinner';
import { formatDateTime } from '../../utils/formatters';
import { useSyncSourceSettings } from '../../hooks/useSyncSourceSettings';

export default function LocalMessageSyncSettings({
  domain, defaultInterval, getStatus, icon: Icon, heading, description,
  checkSetup, syncNow, checkSuccessMessage, checkErrorMessage, syncSuccessMessage, syncErrorMessage,
  setupSuccess, setupError, remediation, afterSetup, metrics, syncDisabled = false,
}) {
  const {
    loading, loadError, retry, enabled, setEnabled, intervalMinutes, setIntervalMinutes, saving,
    status, setStatus, dirty, save,
  } = useSyncSourceSettings({ domain, defaultInterval, getStatus });
  const [setup, setSetup] = useState(null);
  const [checking, setChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const handleSave = async () => {
    if (!await save()) return;
    toast.success('Saved');
  };

  const handleCheck = async () => {
    setChecking(true);
    const report = await checkSetup({ silent: true }).catch(() => ({ ok: false, error: 'Setup check failed' }));
    setChecking(false);
    setSetup(report);
    if (report?.ok) toast.success(checkSuccessMessage(report));
    else toast.error(checkErrorMessage(report));
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    const result = await syncNow({ silent: true }).catch(() => ({ ok: false, error: 'Sync failed' }));
    setSyncing(false);
    if (result?.ok) {
      toast.success(syncSuccessMessage(result));
      setStatus((prev) => ({ ...(prev || {}), state: { ...(prev?.state || {}), cursorRowid: result.cursorRowid, lastResult: result, lastRunAt: new Date().toISOString() } }));
    } else {
      toast.error(syncErrorMessage(result));
      setSetup(result);
    }
  };

  if (loading) return <BrailleSpinner />;
  const lastResult = status?.state?.lastResult;
  const actionsDisabled = !enabled || dirty || saving || loadError;

  return (
    <div className="space-y-6">
      {loadError && <SettingsLoadError onRetry={retry} />}
      <UnreadableSyncStateNotice status={status} />
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Icon size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">{heading}</h3>
        </div>
        <div className="text-sm text-gray-400 mb-4">{description}</div>
        <div className="space-y-3">
          <label htmlFor={`${domain}-enabled`} className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input id={`${domain}-enabled`} type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4 accent-port-accent" />
            {`Enable scheduled ${domain === 'imessage' ? 'iMessage' : 'Signal'} sync`}
          </label>
          <div>
            <label htmlFor={`${domain}-interval`} className="block text-xs uppercase tracking-wider text-gray-500 mb-1">Sync interval (minutes)</label>
            <input id={`${domain}-interval`} type="number" min={1} max={1440} value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)} className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm" />
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" onClick={handleSave} disabled={!dirty || saving || loadError} className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}{saving ? 'Saving...' : 'Save'}
            </button>
            <button type="button" onClick={handleCheck} disabled={checking || (syncDisabled && actionsDisabled)} className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40">
              {checking ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}Check setup
            </button>
            <button type="button" onClick={handleSyncNow} disabled={syncing || (syncDisabled && actionsDisabled)} className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40">
              {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}Sync now
            </button>
          </div>
        </div>
      </div>
      {setup && <div className={`bg-port-card border rounded-lg p-4 sm:p-6 ${setup.ok ? 'border-port-success/40' : 'border-port-error/40'}`}>
        <div className="flex items-center gap-2 mb-2">{setup.ok ? <ShieldCheck size={16} className="text-port-success" /> : <ShieldAlert size={16} className="text-port-error" />}<h3 className="text-sm font-semibold text-white">{setup.ok ? 'Setup OK' : 'Setup blocked'}</h3></div>
        {setup.ok ? setupSuccess(setup) : <div className="text-sm text-gray-300 space-y-2"><p className="text-port-error">{setupError(setup)}</p>{remediation?.(setup, handleCheck, checking)}</div>}
      </div>}
      {afterSetup}
      {(lastResult || status?.state?.cursorRowid > 0) && <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <h3 className="text-sm font-semibold text-white mb-2">Last sync</h3>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          {metrics({ status, lastResult }).map(({ label, value }) => <div key={label}><dt className="text-gray-500 text-xs uppercase">{label}</dt><dd className="text-gray-200">{value}</dd></div>)}
          <div><dt className="text-gray-500 text-xs uppercase">Last run</dt><dd className="text-gray-200">{formatDateTime(status?.state?.lastRunAt, '—')}</dd></div>
        </dl>
      </div>}
    </div>
  );
}
