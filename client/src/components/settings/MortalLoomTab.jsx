import { useState, useEffect, useCallback, useId } from 'react';
import { Save, Download, ExternalLink, CheckCircle2, AlertCircle } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ToggleSwitch from '../ToggleSwitch';
import SettingsLoadError from '../ui/SettingsLoadError';
import useSettingsForm from '../../hooks/useSettingsForm.js';
import { getSettings, updateSettings } from '../../services/apiSystem.js';
import { downloadMortalLoomRecovery, getMortalLoomStatus, importMortalLoom, previewMortalLoomRecovery, restoreMortalLoom } from '../../services/apiMortalLoom.js';
import { downloadBlob } from '../../lib/downloadBlob.js';
import { formatBytes, formatDateTime } from '../../utils/formatters';

// The server reports a machine-readable `reason`; these are the ones worth
// rewriting for a human. An evicted (iCloud-offloaded) store is deliberately
// distinct from a missing one — telling the user the file is "not found" would
// invite them to repoint the path or re-seed on top of real data.
const IMPORT_FAILURE_MESSAGES = {
  'mortalloom-file-not-found': 'MortalLoom.json was not found at the configured path.',
  'mortalloom-file-unreadable': 'MortalLoom.json is in iCloud but has not been downloaded to this Mac yet. A download was requested — try again shortly.',
};

const STATUS_MESSAGES = {
  missing: 'File not found. Check the path or use Restore from File in MortalLoom. PortOS will not create a replacement automatically.',
  notCurrent: 'iCloud has not finished syncing this file. Wait, then check again before editing.',
  conflicted: 'iCloud has conflicting versions. Keep both copies and resolve the conflict in MortalLoom before editing in PortOS.',
  reduced: 'This file has substantially less history than a verified recovery copy. Edits are paused. Review the copies before continuing.',
  invalid: 'MortalLoom cannot safely read this file. Edits are paused. Restore a known-good copy below or in MortalLoom.',
  helperUnavailable: 'Editing the iCloud file requires the macOS Command Line Tools (xcode-select --install).',
  oversized: 'This file is too large for PortOS to safely replace. Export a backup from MortalLoom before editing.',
  unsupported: 'Editing the shared iCloud file requires PortOS on a Mac.',
  unavailable: 'PortOS could not verify the shared file. Check the path and retry before editing.',
};

function RecoveryCopies({ status, disabled, refreshStatus }) {
  const [selected, setSelected] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [checkingCopy, setCheckingCopy] = useState(null);
  const snapshots = status?.recoverySnapshots ?? [];
  if (!snapshots.length) return null;
  const canRestore = Boolean(status.revision) && !disabled && !restoring;
  const confirmation = selected?.revision === status.revision ? selected : null;
  const select = async (snapshot) => {
    if (!canRestore || checkingCopy) return;
    setSelected(null);
    setCheckingCopy(snapshot.id);
    try {
      const summary = await previewMortalLoomRecovery(snapshot.id, { silent: true });
      setSelected({ ...snapshot, summary, revision: status.revision });
    } catch (error) {
      toast.error(error.message || 'Could not verify the recovery copy');
    } finally {
      setCheckingCopy(null);
    }
  };
  const restore = async () => {
    if (!canRestore || !confirmation) return;
    setRestoring(true);
    try {
      await restoreMortalLoom({ id: confirmation.id, expectedRevision: confirmation.revision }, { silent: true });
      toast.success('MortalLoom recovery copy restored');
    } catch (error) {
      toast.error(error.message || 'Could not restore MortalLoom');
    } finally {
      setSelected(null);
      await refreshStatus();
      setRestoring(false);
    }
  };
  const download = async (id) => {
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await downloadMortalLoomRecovery(id, { silent: true });
      downloadBlob(blob, 'MortalLoom-Recovery.json');
    } catch (error) {
      toast.error(error.message || 'Could not download the recovery copy');
    } finally {
      setDownloading(false);
    }
  };
  return (
    <section className="space-y-2 border-t border-port-border pt-3">
      <h4 className="text-sm font-semibold">Private recovery copies</h4>
      <p className="text-xs text-gray-400">PortOS keeps the previous file before each save. Restoring replaces the shared file, not just one record.</p>
      {!status.revision && <p className="text-xs text-port-warning">PortOS cannot verify that it is safe to replace the shared file. Download a verified copy and use Restore from File in MortalLoom, or recheck sync here.</p>}
      <ul className="space-y-1">
        {snapshots.map(snapshot => (
          <li key={snapshot.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span>{formatDateTime(snapshot.savedAt)}</span>
            <button type="button" disabled={!canRestore || !!checkingCopy}
              onClick={() => select(snapshot)}
              className="rounded border border-port-border px-3 py-2 text-port-accent hover:border-port-accent disabled:opacity-50">
              {checkingCopy === snapshot.id ? 'Checking copy…' : 'Select copy'}
            </button>
            <button type="button" onClick={() => download(snapshot.id)}
              disabled={downloading || restoring || disabled}
              className="rounded border border-port-border px-3 py-2 hover:border-port-accent disabled:opacity-50">
              Download copy
            </button>
          </li>
        ))}
      </ul>
      {confirmation && (
        <div role="alert" className="space-y-2 text-sm text-port-warning">
          <p>Replace the shared file with the {formatDateTime(confirmation.savedAt)} copy? It has {confirmation.summary.goals} goals and {confirmation.summary.healthMetrics} daily health records. The current file will also be backed up.</p>
          <button type="button" onClick={restore} disabled={!canRestore}
            className="me-3 rounded border border-port-warning px-3 py-2 disabled:opacity-50">
            {restoring ? 'Restoring…' : 'Restore recovery copy'}
          </button>
          <button type="button" onClick={() => setSelected(null)} disabled={restoring} className="px-3 py-2">Cancel</button>
        </div>
      )}
    </section>
  );
}

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
  const importDisabled = saveDisabled || !saved.enabled || isDirty || (status?.state ? status.state !== 'ready' : !status?.exists);

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
  const fileState = status?.state ?? (status?.exists ? 'ready' : 'missing');

  return (
    <div className="space-y-5">
      {loadError && <SettingsLoadError onRetry={loadAll} />}
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-white mb-1">MortalLoom iCloud Sync</h3>
          <p className="text-sm text-gray-400">
            Share Goals and Meatspace data with the MortalLoom iOS/macOS app. MortalLoom writes
            a canonical <code className="text-port-accent">MortalLoom.json</code> to its iCloud
            container &mdash; enabling this lets you view and edit supported records from either app.
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">iCloud file status</h3>
          {status && <button type="button" disabled={saveDisabled} onClick={refreshStatus}
            className="rounded border border-port-border px-3 py-2 text-xs hover:border-port-accent disabled:opacity-50">
            Recheck status
          </button>}
        </div>
        {checkingStatus && <BrailleSpinner text="Checking iCloud file status" />}
        {!checkingStatus && statusError && (loadError
          ? <p className="text-xs text-port-warning">MortalLoom file status is unavailable.</p>
          : <SettingsLoadError onRetry={refreshStatus}>MortalLoom file status is unavailable.</SettingsLoadError>
        )}
        {!checkingStatus && status && (
          <div className="text-xs text-gray-400 space-y-1 font-mono">
            <div className="flex items-start gap-2">
              {status?.exists && (!status.state || status.state === 'ready') ? (
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
            ) : null}
            {STATUS_MESSAGES[fileState] && <div className="text-port-warning">{STATUS_MESSAGES[fileState]}</div>}
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
        {!checkingStatus && <RecoveryCopies status={status} disabled={saveDisabled || isDirty} refreshStatus={refreshStatus} />}
      </div>
    </div>
  );
}

export default MortalLoomTab;
