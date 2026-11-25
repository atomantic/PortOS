import { useState, useEffect, useCallback, useId } from 'react';
import { Save, Download, ExternalLink, CheckCircle2, AlertCircle } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ToggleSwitch from '../ToggleSwitch';
import SettingsLoadError from '../ui/SettingsLoadError';
import useSettingsForm from '../../hooks/useSettingsForm.js';
import { getSettings, updateSettings } from '../../services/apiSystem.js';
import { getMortalLoomStatus, importMortalLoom } from '../../services/apiMortalLoom.js';
import { formatBytes, formatDateTime } from '../../utils/formatters';

// The server reports a machine-readable `reason`; these are the ones worth
// rewriting for a human. An evicted (iCloud-offloaded) store is deliberately
// distinct from a missing one — telling the user the file is "not found" would
// invite them to repoint the path or re-seed on top of real data.
const IMPORT_FAILURE_MESSAGES = {
  'mortalloom-file-not-found': 'MortalLoom.json was not found at the configured path.',
  'mortalloom-file-unreadable': 'MortalLoom.json is in iCloud but has not been downloaded to this Mac yet. A download was requested — try again shortly.',
};

export function MortalLoomTab() {
  const icloudPathId = useId();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const { values, saved, isDirty, set, load, markSaved } = useSettingsForm({ enabled: false, path: '' });
  const { enabled, path } = values;
  const [status, setStatus] = useState(null);
  const [lastImport, setLastImport] = useState(null);

  const [statusError, setStatusError] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);

  const refreshStatus = useCallback(async () => {
    setCheckingStatus(true);
    try {
      setStatus(await getMortalLoomStatus({ silent: true }));
      setStatusError(false);
    } catch {
      setStatus(null);
      setStatusError(true);
    } finally {
      setCheckingStatus(false);
    }
  }, []);

  const loadAll = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    return Promise.all([
      getSettings({ silent: true }).then(settings => {
        const ml = settings.mortalloom ?? {};
        load({ enabled: Boolean(ml.enabled), path: ml.path || '' });
        setLastImport(ml.lastImportAt || null);
      }).catch(() => setLoadError(true)),
      refreshStatus(),
    ]).finally(() => setLoading(false));
  }, [load, refreshStatus]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const saveDisabled = saving || importing || loadError || checkingStatus;
  const importDisabled = saveDisabled || !saved.enabled || isDirty || !status?.exists;

  const handleSave = async () => {
    if (saveDisabled) return;
    setSaving(true);
    const submitted = { enabled, path: path.trim() };
    try {
      await updateSettings({
        mortalloom: { ...submitted, lastImportAt: lastImport }
      }, { silent: true });
      markSaved(submitted, values);
      toast.success('MortalLoom settings saved');
      await refreshStatus();
    } catch (err) {
      toast.error(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async () => {
    if (importDisabled) return;
    setImporting(true);
    try {
      const res = await importMortalLoom({ silent: true }).catch(() => null);
      if (!res?.ok) {
        toast.error('Import failed: ' + (IMPORT_FAILURE_MESSAGES[res?.reason] || res?.reason || 'unknown'));
        return;
      }
      const totalAdded = Object.values(res.added || {}).reduce((a, b) => a + b, 0);
      const totalSkipped = Object.values(res.skipped || {}).reduce((a, b) => a + b, 0);
      toast.success(`Imported ${totalAdded} new records (${totalSkipped} already present)`);
      const now = new Date().toISOString();
      setLastImport(now);
      await updateSettings({ mortalloom: { ...saved, lastImportAt: now } })
        .catch((err) => { console.warn(`⚠️ Failed to persist import timestamp: ${err?.message || err}`); });
      await refreshStatus();
    } finally {
      setImporting(false);
    }
  };

  if (loading) return <BrailleSpinner text="Loading MortalLoom settings" />;

  const effectivePath = status?.path || saved.path.trim() || status?.defaultPath || '';

  return (
    <div className="space-y-5">
      {loadError && <SettingsLoadError onRetry={loadAll} />}
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-white mb-1">MortalLoom iCloud Sync</h3>
          <p className="text-sm text-gray-400">
            Share Goals and Meatspace data with the MortalLoom iOS/macOS app. MortalLoom writes
            a canonical <code className="text-port-accent">MortalLoom.json</code> to its iCloud
            container &mdash; enabling this lets PortOS read from and import into the same file.
          </p>
          <a
            href="https://apps.apple.com/app/id6760883701"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-port-accent hover:underline mt-2"
          >
            Get MortalLoom on the App Store <ExternalLink size={12} />
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm text-gray-400">Enabled</span>
          <ToggleSwitch
            enabled={enabled}
            onChange={() => set('enabled', !enabled)}
            size="sm"
            ariaLabel={enabled ? 'Disable MortalLoom sync' : 'Enable MortalLoom sync'}
          />
          <span className="basis-full sm:basis-auto text-xs text-gray-500">
            When enabled, Goals and Meatspace views surface MortalLoom data.
          </span>
        </div>

        <div className="space-y-1">
          <label htmlFor={icloudPathId} className="block text-sm text-gray-400">iCloud file path</label>
          <input
            id={icloudPathId}
            type="text"
            value={path}
            onChange={e => set('path', e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent font-mono"
            placeholder={status?.defaultPath || ''}
          />
          <p className="text-xs text-gray-500">
            Leave blank to use the auto-detected MortalLoom container.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <button
            onClick={handleSave}
            disabled={saveDisabled}
            className="inline-flex items-center justify-center min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            <Save size={14} className="inline mr-1" />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={handleImport}
            disabled={importDisabled}
            className="inline-flex items-center justify-center min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-white rounded-lg text-sm transition-colors disabled:opacity-50"
            title={status?.exists === false ? 'MortalLoom.json not found' : 'Import into PortOS'}
          >
            <Download size={14} className="inline mr-1" />
            {importing ? 'Importing…' : 'Import from MortalLoom'}
          </button>
        </div>
        {(saving || isDirty) && (
          <p role="status" className="text-xs text-gray-400">
            {saving ? 'Wait for settings to finish saving before importing.' : 'Save your changes before importing.'}
          </p>
        )}
        <p className="text-xs text-gray-500">
          Import is non-destructive: records already present in PortOS (matched by id) are kept
          as-is. Only missing records are added.
        </p>
      </div>

      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-3">
        <h3 className="text-sm font-semibold text-white">iCloud file status</h3>
        {checkingStatus && <BrailleSpinner text="Checking iCloud file status" />}
        {!checkingStatus && statusError && (loadError
          ? <p className="text-xs text-port-warning">MortalLoom file status is unavailable.</p>
          : <SettingsLoadError onRetry={refreshStatus}>MortalLoom file status is unavailable.</SettingsLoadError>
        )}
        {!checkingStatus && status && (
          <div className="text-xs text-gray-400 space-y-1 font-mono">
            <div className="flex items-start gap-2">
              {status?.exists ? (
                <CheckCircle2 size={14} className="text-port-success mt-0.5 shrink-0" />
              ) : (
                <AlertCircle size={14} className="text-port-warning mt-0.5 shrink-0" />
              )}
              <span className="break-all">{effectivePath || '(no path)'}</span>
            </div>
            {status?.exists ? (
              <>
                <div>Size: {formatBytes(status.size)}</div>
                <div>Modified: {status.mtime ? formatDateTime(status.mtime) : '—'}</div>
                {lastImport && <div>Last import: {formatDateTime(lastImport)}</div>}
              </>
            ) : status.exists === false && (
              <div className="text-port-warning">File not found. Open MortalLoom on iPhone/Mac to create it, or verify the path.</div>
            )}
          </div>
        )}
        {!checkingStatus && status?.summary && (
          <div className="grid grid-cols-2 gap-2 text-xs text-gray-300 mt-2">
            <div>Goals: <span className="text-white">{status.summary.goals}</span></div>
            <div>Alcohol drinks: <span className="text-white">{status.summary.alcoholDrinks}</span></div>
            <div>Nicotine entries: <span className="text-white">{status.summary.nicotineEntries}</span></div>
            <div>Blood tests: <span className="text-white">{status.summary.bloodTests}</span></div>
            <div>Body entries: <span className="text-white">{status.summary.bodyEntries}</span></div>
            <div>Epigenetic tests: <span className="text-white">{status.summary.epigeneticTests}</span></div>
            <div>Eye exams: <span className="text-white">{status.summary.eyeExams}</span></div>
            <div>Sauna sessions: <span className="text-white">{status.summary.saunaSessions}</span></div>
            <div>Profile: <span className="text-white">{status.summary.hasProfile ? 'yes' : 'no'}</span></div>
            <div>Genome: <span className="text-white">{status.summary.hasGenome ? 'yes' : 'no'}</span></div>
          </div>
        )}
      </div>
    </div>
  );
}

export default MortalLoomTab;
