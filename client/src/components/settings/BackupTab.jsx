import { useState, useEffect, useId } from 'react';
import { Save, Plus, X, Play, ShieldOff, ChevronDown, ChevronRight } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ToggleSwitch from '../ToggleSwitch';
import FolderPicker from '../FolderPicker';
import { useBackupRun } from '../../hooks/useBackupRun';
import Modal from '../ui/Modal';
import { getSettings, updateSettings, getBackupStatus, getBackupSnapshots, restoreDatabase } from '../../services/api';
import { formatBytes } from '../../utils/formatters';
import CronSchedulePicker from '../CronSchedulePicker';

// Set equality — rsync --exclude flags are order-independent, so reordering
// is NOT a dirty state; only membership changes (added/removed entries) are.
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// settings.json is hand-editable and the GET /settings endpoint is unvalidated,
// so an incoming `excludePaths`/`disabledDefaultExcludes` value can be a string,
// null, or any other shape. Normalize before it reaches React state — otherwise
// downstream `.some` / `.includes` / `.filter` calls crash the Backup tab.
const asArray = (v) => Array.isArray(v) ? v : [];

export function BackupTab() {
  const destPathId = useId();
  const additionalExcludeId = useId();
  const defaultExcludesPanelId = useId();
  const [loading, setLoading] = useState(true);
  // A settings response that never resolved is NOT 'the defaults' — the schedule
  // fields stay null and the form is replaced by an error panel, so an unreachable
  // API can't be saved back as invented values (#6632).
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [destPath, setDestPath] = useState('');
  const [savedDestPath, setSavedDestPath] = useState('');
  // Schedule state is seeded ONLY from the API's resolved values. The server
  // owns how a sparse backup config resolves (server/lib/backupConfig.js); a
  // client-side fallback here would be a second, conflicting interpretation —
  // which is exactly what silently cancelled destination-only schedules (#6632).
  const [enabled, setEnabled] = useState(null);
  const [savedEnabled, setSavedEnabled] = useState(null);
  const [cronExpression, setCronExpression] = useState(null);
  const [savedCronExpression, setSavedCronExpression] = useState(null);
  const [excludePaths, setExcludePaths] = useState([]);
  const [savedExcludePaths, setSavedExcludePaths] = useState([]);
  const [disabledDefaultExcludes, setDisabledDefaultExcludes] = useState([]);
  const [savedDisabledDefaultExcludes, setSavedDisabledDefaultExcludes] = useState([]);
  const [defaultExcludes, setDefaultExcludes] = useState([]);
  const [newExclude, setNewExclude] = useState('');
  const [pgBackup, setPgBackup] = useState(null);
  const [backupStatus, setBackupStatus] = useState('never');
  const [snapshots, setSnapshots] = useState([]);
  const [restoreTarget, setRestoreTarget] = useState(null); // snapshotId pending confirm
  const [restorePreview, setRestorePreview] = useState(null); // dry-run result
  // The default-exclusions catalog is a 15+ row reference list the user rarely
  // edits — collapsed by default so the fields they came to change (destination,
  // enabled, schedule) and the action bar are what the tab actually shows.
  const [showDefaultExcludes, setShowDefaultExcludes] = useState(false);

  useEffect(() => {
    Promise.all([
      getSettings({ silent: true }),
      getBackupStatus({ silent: true }).catch(() => null),
      getBackupSnapshots({ silent: true }).catch(() => []),
    ])
      .then(([settings, status, snaps]) => {
        const backup = settings?.backup || {};
        const saved = backup.destPath || '';
        const savedExcludes = asArray(backup.excludePaths);
        const savedDisabled = asArray(backup.disabledDefaultExcludes);
        setDestPath(saved);
        setSavedDestPath(saved);
        // The GET projects the effective schedule, so these are always present.
        // Anything else is an unresolved response and is treated as a load failure
        // rather than being papered over with a locally invented default.
        if (typeof backup.enabled !== 'boolean' || !backup.cronExpression) {
          throw new Error('Settings response did not include a resolved backup schedule');
        }
        const savedEnabledValue = backup.enabled;
        const savedCron = backup.cronExpression;
        setEnabled(savedEnabledValue);
        setSavedEnabled(savedEnabledValue);
        setCronExpression(savedCron);
        setSavedCronExpression(savedCron);
        setExcludePaths(savedExcludes);
        setSavedExcludePaths(savedExcludes);
        setDisabledDefaultExcludes(savedDisabled);
        setSavedDisabledDefaultExcludes(savedDisabled);
        setDefaultExcludes(asArray(status?.defaultExcludes));
        setPgBackup(status?.pgBackup ?? null);
        setBackupStatus(status?.status ?? 'never');
        setSnapshots(Array.isArray(snaps) ? snaps : []);
      })
      .catch(() => {
        setLoadFailed(true);
        toast.error('Failed to load settings');
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings({ backup: { destPath, enabled, cronExpression, excludePaths, disabledDefaultExcludes } }, { silent: true });
      setSavedDestPath(destPath);
      setSavedEnabled(enabled);
      setSavedCronExpression(cronExpression);
      setSavedExcludePaths(excludePaths);
      setSavedDisabledDefaultExcludes(disabledDefaultExcludes);
      toast.success('Settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const toggleDefaultExclude = (path) => {
    setDisabledDefaultExcludes(prev => prev.includes(path)
      ? prev.filter(p => p !== path)
      : [...prev, path]);
  };

  const [handleRunNow, running] = useBackupRun((result) => {
    setPgBackup(result?.pgBackup ?? null);
    setBackupStatus(result?.status ?? 'ok');
    getBackupSnapshots({ silent: true }).then(s => setSnapshots(Array.isArray(s) ? s : [])).catch((err) => { console.warn(`⚠️ Failed to refresh snapshots: ${err?.message || err}`); });
  });

  const addExclude = () => {
    const trimmed = newExclude.trim();
    if (!trimmed || excludePaths.includes(trimmed)) return;
    setExcludePaths([...excludePaths, trimmed]);
    setNewExclude('');
  };

  const removeExclude = (index) => {
    setExcludePaths(excludePaths.filter((_, i) => i !== index));
  };

  if (loading) {
    return <BrailleSpinner text="Loading backup settings" />;
  }

  if (loadFailed) {
    return (
      <div className="text-sm text-port-error">
        Failed to load backup settings. Reload the page to try again — the form stays hidden so an
        unresolved response can&apos;t be saved over your schedule.
      </div>
    );
  }

  const dirty = destPath !== savedDestPath
    || enabled !== savedEnabled
    || cronExpression !== savedCronExpression
    || !sameSet(excludePaths, savedExcludePaths)
    || !sameSet(disabledDefaultExcludes, savedDisabledDefaultExcludes);
  const canRun = !!savedDestPath && !running && !saving && !dirty;
  const runDisabledReason = running
    ? null
    : saving && (destPath || savedDestPath)
      ? 'Waiting for save to finish — Run Backup Now will use the saved settings.'
      : !savedDestPath && destPath
        ? 'Save this destination before running — Run Backup Now uses saved settings.'
      : !savedDestPath
        ? 'Configure and save a destination path first'
      : dirty
        ? 'Unsaved changes. Save your changes before running — Run Backup Now uses saved settings.'
        : null;
  const runTitle = runDisabledReason || 'Run a backup snapshot now using saved settings';
  const formStatus = saving ? 'Saving…' : dirty ? 'Unsaved changes' : '';

  const defaultExcludeRows = defaultExcludes.map(d => ({
    ...d,
    defaultActive: !(d.overridable && disabledDefaultExcludes.includes(d.path)),
  }));
  const enabledDefaultCount = defaultExcludeRows.filter(d => d.defaultActive).length;
  const disabledDefaultCount = defaultExcludeRows.length - enabledDefaultCount;

  const renderPgStatus = () => {
    if (!pgBackup) return <span className="text-gray-500">No backup run yet</span>;
    if (pgBackup.status === 'ok') {
      return <span className="text-port-success">✅ {formatBytes(pgBackup.sizeBytes || 0)} · {pgBackup.tableCount} tables</span>;
    }
    if (pgBackup.status === 'skipped') {
      return <span className="text-gray-400">⏭️ Not configured (file mode)</span>;
    }
    // title carries the raw pg_dump stderr so the exact cause is one hover away.
    return (
      <span className="text-port-warning" title={pgBackup.error || undefined}>
        ❌ Dump failed: {pgBackup.reason}
      </span>
    );
  };

  const handleRestoreDb = async (snapshotId) => {
    setRestorePreview(null);
    setRestoreTarget(null);
    // Dry-run first to show what would restore, then open the confirm modal.
    const preview = await restoreDatabase({ snapshotId, dryRun: true }, { silent: true })
      .catch(() => null);
    if (!preview || preview.status === 'skipped') {
      toast.error(preview?.reason === 'no_dump' ? 'No DB dump in this snapshot' : 'DB restore unavailable');
      return;
    }
    if (preview.status !== 'ok') {
      toast.error(preview.reason === 'manifest_mismatch'
        ? 'Snapshot dump failed integrity verification'
        : `DB restore unavailable: ${preview.reason || 'unknown'}`);
      return;
    }
    setRestorePreview(preview);
    setRestoreTarget(snapshotId);
  };

  const confirmRestoreDb = async () => {
    const snapshotId = restoreTarget;
    setRestoreTarget(null);
    const result = await restoreDatabase({ snapshotId, dryRun: false }, { silent: true })
      .catch(() => ({ status: 'failed', reason: 'request_error' }));
    if (result.status === 'ok') {
      toast.success(`Database restored from ${snapshotId}`, { icon: '💾' });
    } else {
      toast.error(`DB restore failed: ${result.reason || 'unknown'}`);
    }
    setRestorePreview(null);
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5">
      {backupStatus === 'degraded' && (
        <div className="bg-port-warning/10 border border-port-warning/40 rounded-lg px-3 py-2 text-sm text-port-warning">
          ⚠️ Last backup degraded — files were saved but the database dump failed.{' '}
          {pgBackup?.reason === 'version_mismatch' ? (
            <>Your <code>pg_dump</code> is older than the running PostgreSQL server. Install/point at a <code>pg_dump</code> at least as new as the server (e.g. <code>brew install postgresql@17</code>), or set <code>PORTOS_PGDUMP</code> to its path.</>
          ) : (
            <>Check that <code>pg_dump</code> is installed and PostgreSQL is reachable.</>
          )}
        </div>
      )}

      <div className="space-y-1">
        <p className="block text-sm text-gray-400">Database Backup (last run)</p>
        <div className="text-sm">{renderPgStatus()}</div>
      </div>

      <div className="space-y-1">
        <label htmlFor={destPathId} className="block text-sm text-gray-400">Destination Path</label>
        <div className="flex gap-2 items-stretch">
          <input
            id={destPathId}
            type="text"
            value={destPath}
            onChange={e => setDestPath(e.target.value)}
            className="flex-1 min-w-0 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
            placeholder="/path/to/backups"
          />
          <FolderPicker value={destPath} onChange={setDestPath} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-400">Enabled</span>
        <button
          type="button"
          role="switch"
          onClick={() => setEnabled(!enabled)}
          aria-label="Scheduled backups"
          aria-checked={enabled}
          className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-port-accent' : 'bg-port-border'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      <div className="space-y-1">
        <span className="block text-sm text-gray-400">Schedule</span>
        <CronSchedulePicker value={cronExpression} onChange={setCronExpression} cronAriaLabel="Schedule (cron)" />
        <p className="text-xs text-gray-500">Default: 2:00 AM daily. Times use the configured timezone.</p>
      </div>

      {defaultExcludeRows.length > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowDefaultExcludes(v => !v)}
            aria-expanded={showDefaultExcludes}
            aria-controls={defaultExcludesPanelId}
            className="flex items-center gap-2 w-full text-left text-sm text-gray-400 hover:text-white transition-colors"
          >
            {showDefaultExcludes ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
            <ShieldOff size={14} className="text-gray-500 shrink-0" />
            <span>Default exclusions — {enabledDefaultCount} enabled, {disabledDefaultCount} disabled</span>
          </button>
          {showDefaultExcludes && (
            <div id={defaultExcludesPanelId} className="space-y-2">
              <p className="text-xs text-gray-500">Built-in exclusion rules keep snapshots small. Switch on to disable an overridable default rule; fixed rules remain enabled.</p>
              <ul className="space-y-1.5 mt-1">
                {defaultExcludeRows.map((d, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    {d.overridable ? (
                      <ToggleSwitch
                        enabled={!d.defaultActive}
                        onChange={() => toggleDefaultExclude(d.path)}
                        size="sm"
                        ariaLabel={`Disable default exclusion ${d.path}`}
                        className="mt-0.5"
                      />
                    ) : (
                      <span className="inline-flex items-center justify-center w-12 h-7 shrink-0 text-gray-600" title="Fixed default exclusion — always enabled">
                        <ShieldOff size={14} />
                      </span>
                    )}
                    <code className="px-1.5 py-0.5 bg-port-bg border rounded shrink-0 text-gray-300 border-port-border">{d.path}</code>
                    <span className="text-gray-500">
                      {d.reason}
                      {!d.defaultActive && <span className="text-gray-400 ml-1">(Default exclusion disabled)</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor={additionalExcludeId} className="block text-sm text-gray-400">Additional Exclude Paths</label>
        <p className="text-xs text-gray-500">Custom directories/patterns to skip during backup (relative to data/). Additional rules still apply when a default exclusion is disabled. Disabling a default does not guarantee matching files will be backed up.</p>
        <div className="flex gap-2">
          <input
            id={additionalExcludeId}
            type="text"
            value={newExclude}
            onChange={e => setNewExclude(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addExclude()}
            className="flex-1 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
            placeholder="repos/"
          />
          <button
            onClick={addExclude}
            disabled={!newExclude.trim()}
            aria-label="Add exclude path"
            className="inline-flex items-center justify-center min-w-[40px] min-h-[40px] px-3 py-2 bg-port-border hover:bg-port-border/70 text-white rounded-lg transition-colors disabled:opacity-50 shrink-0"
          >
            <Plus size={16} />
          </button>
        </div>
        {excludePaths.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {excludePaths.map((path, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-port-bg border border-port-border rounded-lg text-sm text-gray-300">
                <code className="text-xs">{path}</code>
                <button onClick={() => removeExclude(i)} aria-label="Dismiss" className="text-gray-500 hover:text-port-error transition-colors">
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {snapshots.length > 0 && (
        <div className="space-y-2">
          <p className="block text-sm text-gray-400">Snapshots</p>
          <ul className="space-y-1.5">
            {snapshots.slice(0, 10).map((snap) => (
              <li key={snap.id} className="flex items-center justify-between gap-2 text-xs bg-port-bg border border-port-border rounded-lg px-2.5 py-1.5">
                <span className="text-gray-300 truncate">{snap.id}</span>
                <button
                  onClick={() => handleRestoreDb(snap.id)}
                  className="shrink-0 px-2 py-1 bg-port-border hover:bg-port-border/70 text-white rounded transition-colors"
                >
                  Restore DB
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Modal
        open={!!restoreTarget}
        onClose={() => { setRestoreTarget(null); setRestorePreview(null); }}
        size="sm"
        usePortal
        ariaLabel="Restore database"
      >
        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
          <h3 className="text-white text-sm font-medium">Restore database?</h3>
          <p className="text-sm text-gray-400">
            This replays <code>portos-db.sql</code> from snapshot <code className="text-gray-300">{restoreTarget}</code>
            {restorePreview && <> ({formatBytes(restorePreview.sizeBytes || 0)} · {restorePreview.tableCount} tables)</>}
            {' '}into the live PostgreSQL database. Existing rows may be overwritten.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setRestoreTarget(null); setRestorePreview(null); }} className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
            <button onClick={confirmRestoreDb} className="px-3 py-2 text-sm bg-port-warning hover:bg-port-warning/80 text-black font-medium rounded-lg transition-colors">Restore</button>
          </div>
        </div>
      </Modal>

      {/* Sticky action bar — Save and Run Backup Now stay reachable no matter how
          far the exclusions/snapshot lists push the page, and the bar carries the
          unsaved-changes state so an edit at the top of the tab is never
          committed blind. Negative margins bleed it to the card edges. */}
      <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 -mx-4 sm:-mx-6 -mb-4 sm:-mb-6 px-4 sm:px-6 py-3 bg-port-card/95 sm:backdrop-blur border-t border-port-border rounded-b-xl">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? <BrailleSpinner /> : <Save size={16} />}
          Save
        </button>
        <button
          onClick={handleRunNow}
          disabled={!canRun}
          title={runTitle}
          aria-describedby={runDisabledReason ? 'backup-run-disabled-reason' : undefined}
          className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? <BrailleSpinner /> : <Play size={16} />}
          {running ? 'Running…' : 'Run Backup Now'}
        </button>
        <span
          id="backup-run-disabled-reason"
          className="text-xs text-gray-500"
          aria-live="polite"
        >
          {runDisabledReason || formStatus}
        </span>
      </div>
    </div>
  );
}

export default BackupTab;
