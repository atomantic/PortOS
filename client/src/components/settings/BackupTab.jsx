import { useState, useEffect, useId, useRef } from 'react';
import { AlertTriangle, Archive, CalendarClock, CheckCircle2, Database, Play, Plus, Save, ShieldOff, Trash2, X, ChevronDown, ChevronRight } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ToggleSwitch from '../ToggleSwitch';
import FolderPicker from '../FolderPicker';
import { useBackupRun } from '../../hooks/useBackupRun';
import Modal from '../ui/Modal';
import Banner from '../ui/Banner';
import CollapsibleSection from '../ui/CollapsibleSection';
import CollapsibleListItem from '../ui/CollapsibleListItem';
import { getSettings, updateSettings, getBackupStatus, getBackupSnapshots, restoreDatabase, deleteBackupSnapshot } from '../../services/api';
import { formatBytes } from '../../utils/formatters';
import { describeCron } from '../../utils/cronHelpers';
import CronSchedulePicker from '../CronSchedulePicker';
import { anchorUserExclude, anchorUserExcludes, isSafeExcludePattern } from '../../lib/backupExcludes';

// Mirrors MIN_RETENTION_COUNT/MAX_RETENTION_COUNT in server/lib/backupConfig.js —
// the server is the source of truth and re-validates on save; these only bound
// the input control.
const MIN_RETENTION_COUNT = 1;
const MAX_RETENTION_COUNT = 365;
const DEFAULT_RETENTION_COUNT = 30;

// Set equality — rsync --exclude flags are order-independent, so reordering
// is NOT a dirty state; only membership changes (added/removed entries) are.
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// settings.json is hand-editable and the GET /settings endpoint is unvalidated,
// so an incoming `excludePaths`/`disabledDefaultExcludes` value can be a string,
// null, or any other shape. Normalize before it reaches React state — otherwise
// downstream `.some` / `.includes` / `.filter` calls crash the Backup tab.
const asArray = (v) => Array.isArray(v) ? v : [];
// Stored exclude patterns are now bounded at the settings boundary (`..`/NUL and
// blanks rejected). A settings.json written before that — or hand-edited since —
// can still hold an entry the PATCH would now 400 on, which would wedge the whole
// Backup form. Drop those on load instead: the spelling of the survivors is left
// untouched (anchoring is a read-time concern), so the form is not dirty.
const asExcludeArray = (v) => asArray(v).filter(isSafeExcludePattern);
const snapshotIdentity = (snapshot) =>
  snapshot.selectionKey || `${snapshot.source || 'current'}/${snapshot.id}`;
const snapshotSourceLabel = (snapshot) =>
  snapshot.sourceLabel || snapshot.source || 'Current machine';

export function BackupTab() {
  const destPathId = useId();
  const retentionId = useId();
  const additionalExcludeId = useId();
  const defaultExcludesPanelId = useId();
  const effectiveExcludesPanelId = useId();
  const exclusionsPanelId = useId();
  const snapshotsPanelId = useId();
  const [loading, setLoading] = useState(true);
  // A settings response that never resolved is NOT 'the defaults' — the schedule
  // fields stay null and the form is replaced by an error panel, so an unreachable
  // API can't be saved back as invented values (#6632).
  const [loadFailed, setLoadFailed] = useState(false);
  const [statusLoadFailed, setStatusLoadFailed] = useState(false);
  const [exclusionsLoadFailed, setExclusionsLoadFailed] = useState(false);
  const [snapshotsLoadFailed, setSnapshotsLoadFailed] = useState(false);
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
  // `null` = unlimited. Undefined only before the initial load resolves.
  const [retentionCount, setRetentionCount] = useState(undefined);
  const [savedRetentionCount, setSavedRetentionCount] = useState(undefined);
  // The number input's own DISPLAYED text, decoupled from the committed
  // `retentionCount`. A controlled `value` bound directly to a clamped
  // number snaps back to the old value the instant the field is cleared
  // (parseInt('') is NaN), which makes it impossible to select-all and type
  // a replacement. Free-typing lives here; `retentionCount` (used for dirty
  // checking and the save payload) only updates once the text parses.
  const [retentionInputText, setRetentionInputText] = useState('');
  const [excludePaths, setExcludePaths] = useState([]);
  const [savedExcludePaths, setSavedExcludePaths] = useState([]);
  const [disabledDefaultExcludes, setDisabledDefaultExcludes] = useState([]);
  const [savedDisabledDefaultExcludes, setSavedDisabledDefaultExcludes] = useState([]);
  const [defaultExcludes, setDefaultExcludes] = useState([]);
  const [newExclude, setNewExclude] = useState('');
  const [pgBackup, setPgBackup] = useState(null);
  const [backupStatus, setBackupStatus] = useState('never');
  const [snapshots, setSnapshots] = useState([]);
  const [showAllSnapshots, setShowAllSnapshots] = useState(false);
  const [showExclusions, setShowExclusions] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState(null); // source-bound request pending confirm
  const [restorePreview, setRestorePreview] = useState(null); // dry-run result
  const restorePreviewGenerationRef = useRef(0);
  const [deleteTarget, setDeleteTarget] = useState(null); // snapshot pending delete confirm
  const [deletingIds, setDeletingIds] = useState(new Set());
  const pendingDeletes = useRef(new Set());
  // The default-exclusions catalog is a 15+ row reference list the user rarely
  // edits — collapsed by default so the fields they came to change (destination,
  // enabled, schedule) and the action bar are what the tab actually shows.
  const [showDefaultExcludes, setShowDefaultExcludes] = useState(false);
  // Same reasoning as the catalog above: the effective list is defaults + user
  // entries, so it is longer still. Collapsed by default, one click from visible.
  const [showEffectiveExcludes, setShowEffectiveExcludes] = useState(false);

  useEffect(() => {
    Promise.allSettled([
      getSettings({ silent: true }),
      getBackupStatus({ silent: true }),
      getBackupSnapshots({ silent: true }),
    ])
      .then(([settingsResult, statusResult, snapshotsResult]) => {
        if (settingsResult.status === 'rejected') throw settingsResult.reason;
        const statusLoadError = statusResult.status === 'rejected';
        const snapshotsLoadError = snapshotsResult.status === 'rejected';
        const settings = settingsResult.value;
        const status = statusLoadError ? null : statusResult.value;
        const snaps = snapshotsLoadError ? null : snapshotsResult.value;
        const backup = settings?.backup || {};
        const saved = backup.destPath || '';
        const savedExcludes = asExcludeArray(backup.excludePaths);
        const savedDisabled = asArray(backup.disabledDefaultExcludes);
        setStatusLoadFailed(statusLoadError);
        setExclusionsLoadFailed(statusLoadError);
        setSnapshotsLoadFailed(snapshotsLoadError);
        setDestPath(saved);
        setSavedDestPath(saved);
        // The GET projects the effective schedule, so these are always present.
        // Anything else is an unresolved response and is treated as a load failure
        // rather than being papered over with a locally invented default.
        if (typeof backup.enabled !== 'boolean'
          || typeof backup.cronExpression !== 'string'
          || !backup.cronExpression.trim()) {
          throw new Error('Settings response did not include a resolved backup schedule');
        }
        // retentionCount is resolved server-side too (null = unlimited), so
        // an absent KEY (not merely a null/number value) means the same
        // unresolved-response case as enabled/cronExpression above.
        if (!('retentionCount' in backup)) {
          throw new Error('Settings response did not include a resolved backup schedule');
        }
        const savedEnabledValue = backup.enabled;
        const savedCron = backup.cronExpression;
        const savedRetention = backup.retentionCount;
        setEnabled(savedEnabledValue);
        setSavedEnabled(savedEnabledValue);
        setCronExpression(savedCron);
        setSavedCronExpression(savedCron);
        setRetentionCount(savedRetention);
        setSavedRetentionCount(savedRetention);
        setRetentionInputText(savedRetention === null ? '' : String(savedRetention));
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
      await updateSettings({ backup: { destPath, enabled, cronExpression, retentionCount, excludePaths, disabledDefaultExcludes } }, { silent: true });
      setSavedDestPath(destPath);
      setSavedEnabled(enabled);
      setSavedCronExpression(cronExpression);
      setSavedRetentionCount(retentionCount);
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
    setStatusLoadFailed(false);
    // A completed run establishes health, but does not include the exclusion
    // catalog. Recover that separately before enabling its controls.
    return Promise.all([
      getBackupSnapshots({ silent: true }).then(s => {
        setSnapshots(Array.isArray(s) ? s : []);
        setSnapshotsLoadFailed(false);
      }).catch((err) => { console.warn(`⚠️ Failed to refresh snapshots: ${err?.message || err}`); }),
      exclusionsLoadFailed
        ? getBackupStatus({ silent: true }).then(status => {
          setDefaultExcludes(asArray(status?.defaultExcludes));
          setExclusionsLoadFailed(false);
        }).catch((err) => { console.warn(`⚠️ Failed to refresh backup exclusions: ${err?.message || err}`); })
        : Promise.resolve(),
    ]);
  });

  // Anchor exactly as the server does on read, so the chip the user sees IS the
  // rsync filter that will run. A bare `repos/` would otherwise match every
  // `repos/` at any depth under data/ and silently drop unrelated records (#7241).
  const addExclude = () => {
    const anchored = anchorUserExclude(newExclude);
    if (!anchored) return;
    if (!excludePaths.includes(anchored)) setExcludePaths([...excludePaths, anchored]);
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
    || retentionCount !== savedRetentionCount
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

  // The rsync filter list this configuration actually produces — the client half
  // of `computeEffectiveExcludes`, built from the same anchoring helper so the
  // preview cannot drift from the run. Rendering it is the point: without it the
  // user never sees how a pattern was interpreted until a restore comes up short.
  const effectiveExcludes = [...new Set([
    ...defaultExcludeRows.filter(d => d.defaultActive).map(d => d.path),
    ...anchorUserExcludes(excludePaths),
  ])];
  const scheduleSummary = savedEnabled
    ? (describeCron(savedCronExpression) || savedCronExpression)
    : 'Scheduled backups are off';
  const snapshotSummary = snapshotsLoadFailed
    ? 'Unavailable — reload to retry'
    : snapshots.length > 0
    ? `${snapshots.length} ${snapshots.length === 1 ? 'snapshot' : 'snapshots'}`
    : 'No snapshots yet';
  const exclusionsSummary = exclusionsLoadFailed
    ? 'Unavailable — reload to retry'
    : excludePaths.length > 0
    ? `${excludePaths.length} custom · ${effectiveExcludes.length} active patterns`
    : `${effectiveExcludes.length} active patterns`;

  const renderPgStatus = () => {
    if (statusLoadFailed) return <span className="text-port-warning">Backup status unavailable — reload to retry</span>;
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

  const handleRestoreDb = async (snapshot) => {
    const generation = restorePreviewGenerationRef.current + 1;
    restorePreviewGenerationRef.current = generation;
    setRestorePreview(null);
    setRestoreTarget(null);
    const request = {
      snapshotId: snapshot.id,
      ...(snapshot.source ? { source: snapshot.source } : {}),
    };
    // Dry-run first to show what would restore, then open the confirm modal.
    const preview = await restoreDatabase({ ...request, dryRun: true }, { silent: true })
      .catch(() => null);
    if (restorePreviewGenerationRef.current !== generation) return;
    if (!preview || preview.status === 'skipped') {
      toast.error(preview?.reason === 'no_dump' ? 'No DB dump in this snapshot' : 'DB restore unavailable');
      return;
    }
    if (preview.status !== 'ok') {
      const message = preview.reason === 'manifest_mismatch'
        ? 'Snapshot dump failed integrity verification'
        : preview.reason === 'manifest_unreadable'
          ? 'Snapshot verification metadata could not be read. Choose another snapshot or repair the backup media before retrying.'
          : `DB restore unavailable: ${preview.reason || 'unknown'}`;
      toast.error(message);
      return;
    }
    setRestorePreview(preview);
    setRestoreTarget({ request, sourceLabel: snapshotSourceLabel(snapshot) });
  };

  const confirmRestoreDb = async () => {
    const target = restoreTarget;
    setRestoreTarget(null);
    const result = await restoreDatabase({ ...target.request, dryRun: false }, { silent: true })
      .catch(() => ({ status: 'failed', reason: 'request_error' }));
    if (result.status === 'ok') {
      toast.success(`Database restored from ${target.request.snapshotId}`, { icon: '💾' });
    } else if (result.reason === 'restore_schema_reconciliation') {
      toast.error('The database dump was applied, but schema recovery is incomplete. It was not rolled back. Restart PortOS to retry recovery; if it still fails, check the server logs and repair the database before continuing.', { duration: Infinity });
    } else if (result.reason === 'restore_sync_resync') {
      toast.error('The database dump was applied, but peer sync could not be reset. Memories and Catalog records pulled from peers after this snapshot may stay missing; check the server logs and repeat the restore.', { duration: Infinity });
    } else {
      toast.error(`DB restore failed: ${result.reason || 'unknown'}`);
    }
    setRestorePreview(null);
  };

  const handleDeleteSnapshot = (snapshot) => {
    setDeleteTarget({
      identity: snapshotIdentity(snapshot),
      snapshotId: snapshot.id,
      source: snapshot.source,
      sourceLabel: snapshotSourceLabel(snapshot),
    });
  };

  const confirmDeleteSnapshot = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target || pendingDeletes.current.has(target.identity)) return;
    pendingDeletes.current.add(target.identity);
    const result = await deleteBackupSnapshot(target.snapshotId, target.source, { silent: true })
      .catch(err => ({ deleted: false, error: err }));
    pendingDeletes.current.delete(target.identity);
    if (!result?.deleted) {
      toast.error(result?.error?.message || 'Failed to delete snapshot');
      return;
    }
    toast.success(`Deleted snapshot ${target.snapshotId}`);
    setDeletingIds(previous => new Set(previous).add(target.identity));
  };

  return (
    <section
      aria-labelledby="backup-settings-heading"
      data-testid="backup-settings-workspace"
      className="@container bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5"
    >
      <h2 id="backup-settings-heading" className="sr-only">Backup operations and configuration</h2>
      {backupStatus === 'degraded' && (
        <Banner tone="warning" icon={AlertTriangle} title="Last backup degraded" size="md">
          Files were saved but the database dump failed.{' '}
          {pgBackup?.reason === 'version_mismatch' ? (
            <>Your <code>pg_dump</code> is older than the running PostgreSQL server. Install/point at a <code>pg_dump</code> at least as new as the server (for example, <code>brew install postgresql@17</code>), or set <code>PORTOS_PGDUMP</code> to its path.</>
          ) : (
            <>Check that <code>pg_dump</code> is installed and PostgreSQL is reachable.</>
          )}
        </Banner>
      )}

      <div className="grid grid-cols-1 @min-[52rem]:grid-cols-2 gap-4 items-start">
        <div className="min-w-0 rounded-xl border border-port-border/70 bg-port-bg/30 p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="flex items-center gap-2 text-base font-semibold text-white">
              <Database size={17} className="text-port-accent shrink-0" aria-hidden="true" />
              Backup health
            </h3>
            {backupStatus === 'ok' && <CheckCircle2 size={17} className="text-port-success shrink-0" aria-label="Healthy" />}
          </div>
          <p className="mt-1 text-sm text-gray-400">The latest file and database result before you change the next run.</p>
          <div className="mt-4 space-y-1">
            <p className="text-xs uppercase tracking-wide text-gray-500">Database backup</p>
            <div className="text-sm">{renderPgStatus()}</div>
          </div>
        </div>

        <div className="min-w-0 rounded-xl border border-port-border/70 bg-port-bg/30 p-4">
          <h3 className="flex items-center gap-2 text-base font-semibold text-white">
            <CalendarClock size={17} className="text-port-accent shrink-0" aria-hidden="true" />
            Saved schedule
          </h3>
          <p className="mt-1 text-sm text-gray-300 break-words">{scheduleSummary}</p>
          <p className="mt-2 text-xs text-gray-500 break-all">
            {savedDestPath ? `Destination: ${savedDestPath}` : 'No saved destination — scheduled and manual runs are unavailable.'}
          </p>
          <p className="mt-2 text-xs text-gray-500">Run Backup Now uses these saved values, not an unsaved draft.</p>
        </div>
      </div>

      <div className="border-t border-port-border pt-5 space-y-4">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-white">Destination and schedule</h3>
          <p className="mt-1 text-sm text-gray-400">Choose where snapshots go and when scheduled backups run.</p>
        </div>
        <div className="grid grid-cols-1 @min-[52rem]:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] gap-4 items-start">
          <div className="space-y-1 min-w-0">
            <label htmlFor={destPathId} className="block text-sm text-gray-400">Destination Path</label>
            <div className="flex flex-wrap gap-2 items-stretch">
              <input
                id={destPathId}
                type="text"
                value={destPath}
                onChange={e => setDestPath(e.target.value)}
                className="flex-1 min-w-[12rem] bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                placeholder="/path/to/backups"
              />
              <FolderPicker value={destPath} onChange={setDestPath} />
            </div>
          </div>

          <div className="space-y-4 min-w-0">
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
            <div className="space-y-1">
              <label htmlFor={retentionId} className="block text-sm text-gray-400">Retention (snapshots kept on this machine)</label>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  id={retentionId}
                  type="number"
                  min={MIN_RETENTION_COUNT}
                  max={MAX_RETENTION_COUNT}
                  step={1}
                  disabled={retentionCount === null}
                  value={retentionInputText}
                  onChange={e => {
                    const raw = e.target.value;
                    // Let the field show exactly what was typed — including a
                    // momentarily empty or out-of-range value — so clearing it to
                    // type a replacement never snaps back to the old digits.
                    setRetentionInputText(raw);
                    const parsed = Number.parseInt(raw, 10);
                    if (Number.isNaN(parsed)) return;
                    setRetentionCount(Math.min(MAX_RETENTION_COUNT, Math.max(MIN_RETENTION_COUNT, parsed)));
                  }}
                  onBlur={() => {
                    // Reconcile the displayed text with the committed (clamped)
                    // value once editing stops, so an out-of-range or blank entry
                    // doesn't linger on screen looking accepted.
                    setRetentionInputText(retentionCount === null ? '' : String(retentionCount));
                  }}
                  className="w-24 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                />
                <span className="inline-flex items-center gap-2 text-sm text-gray-400">
                  <ToggleSwitch
                    enabled={retentionCount === null}
                    onChange={() => {
                      const next = retentionCount === null ? DEFAULT_RETENTION_COUNT : null;
                      setRetentionCount(next);
                      setRetentionInputText(next === null ? '' : String(next));
                    }}
                    size="sm"
                    ariaLabel="Unlimited retention"
                  />
                  Unlimited
                </span>
              </div>
              <p className="text-xs text-gray-500">After each successful backup, the oldest completed snapshots on this machine beyond this count are deleted. Other machines&apos; snapshots in a shared destination are never affected.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Keep saved-state actions before the detail disclosures. The bar remains
          sticky while the longer exclusion and snapshot regions are open. */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 bg-port-card/95 sm:backdrop-blur border-y border-port-border">
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

      <div className="border-t border-port-border pt-5">
        <CollapsibleSection
          label="Exclusions"
          icon={ShieldOff}
          summary={exclusionsSummary}
          id={exclusionsPanelId}
          open={showExclusions}
          onOpenChange={setShowExclusions}
          size="bar"
          className="space-y-3"
          bodyClassName="space-y-4 pt-2"
        >
          {exclusionsLoadFailed ? (
            <p className="text-sm text-port-warning">Backup exclusion details are unavailable — reload to retry before editing these rules.</p>
          ) : (
            <>
              <p className="text-sm text-gray-400">Review what stays out of snapshots. Detailed rules are one click away so the recovery actions remain easy to find.</p>

          {defaultExcludeRows.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowDefaultExcludes(v => !v)}
                aria-expanded={showDefaultExcludes}
                aria-controls={defaultExcludesPanelId}
                className="flex items-center gap-2 w-full text-left text-sm text-gray-400 hover:text-white transition-colors min-h-[44px]"
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
            <p className="text-xs text-gray-500">Custom directories/patterns to skip during backup (relative to data/). Patterns are anchored to the data root, so <code>repos/</code> is stored as <code>/repos/</code> and skips only <code>data/repos/</code>. Start a pattern with <code>**/</code> to match at any depth instead. Additional rules still apply when a default exclusion is disabled. Disabling a default does not guarantee matching files will be backed up.</p>
            <div className="flex flex-wrap gap-2">
              <input
                id={additionalExcludeId}
                type="text"
                value={newExclude}
                onChange={e => setNewExclude(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addExclude()}
                className="flex-1 min-w-[12rem] bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                placeholder="/repos/"
              />
              <button
                onClick={addExclude}
                disabled={!anchorUserExclude(newExclude)}
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
                    <code className="text-xs break-all">{path}</code>
                    <button onClick={() => removeExclude(i)} aria-label="Dismiss" className="text-gray-500 hover:text-port-error transition-colors">
                      <X size={14} />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {effectiveExcludes.length > 0 && (
              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowEffectiveExcludes(v => !v)}
                  aria-expanded={showEffectiveExcludes}
                  aria-controls={effectiveExcludesPanelId}
                  className="flex items-center gap-2 w-full text-left text-sm text-gray-400 hover:text-white transition-colors min-h-[44px]"
                >
                  {showEffectiveExcludes ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
                  <span>Effective exclude list — {effectiveExcludes.length} rsync {effectiveExcludes.length === 1 ? 'pattern' : 'patterns'}</span>
                </button>
                {showEffectiveExcludes && (
                  <div id={effectiveExcludesPanelId} className="space-y-2">
                    <p className="text-xs text-gray-500">The exact <code>--exclude</code> filters the next snapshot will use: enabled default rules plus your anchored patterns. Saved changes above are reflected here.</p>
                    <ul className="flex flex-wrap gap-1.5">
                      {effectiveExcludes.map((pattern) => (
                        <li key={pattern}>
                          <code className="inline-block px-1.5 py-0.5 bg-port-bg border border-port-border rounded text-xs text-gray-300 break-all">{pattern}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
              </div>
            </>
          )}
        </CollapsibleSection>
      </div>

      <div className="border-t border-port-border pt-5">
        <CollapsibleSection
          label="Snapshot history"
          icon={Archive}
          summary={snapshotSummary}
          id={snapshotsPanelId}
          open={showSnapshots}
          onOpenChange={setShowSnapshots}
          size="bar"
          className="space-y-3"
          bodyClassName="space-y-2 pt-2"
        >
          {snapshotsLoadFailed ? (
            <p className="text-sm text-port-warning">Snapshot history is unavailable — reload to retry.</p>
          ) : snapshots.length === 0 ? (
            <p className="text-sm text-gray-500">No snapshots have been recorded on this machine yet.</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {(showAllSnapshots ? snapshots : snapshots.slice(0, 10)).map((snap) => {
                  const identity = snapshotIdentity(snap);
                  return (
                    <li key={identity}>
                      <CollapsibleListItem
                        removing={deletingIds.has(identity)}
                        spacing="0.375rem"
                        onExited={() => {
                          setSnapshots(previous => previous.filter(s => snapshotIdentity(s) !== identity));
                          setDeletingIds(previous => {
                            const next = new Set(previous);
                            next.delete(identity);
                            return next;
                          });
                        }}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs bg-port-bg border border-port-border rounded-lg px-2.5 py-1.5">
                          <span className="min-w-0">
                            <span className="block text-gray-300 truncate">{snap.id}</span>
                            <span className="block text-gray-500 truncate">Source: {snapshotSourceLabel(snap)}</span>
                            {snap.failed && (
                              <span className="block text-port-error">Backup failed — download only</span>
                            )}
                            {snap.incomplete && (
                              <span className="block text-gray-500">Still being written…</span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <button
                              onClick={() => handleRestoreDb(snap)}
                              disabled={snap.failed || snap.incomplete}
                              title={snap.failed ? 'Failed backup snapshots can only be downloaded for salvage' : undefined}
                              className="px-2 py-2 min-h-[40px] bg-port-border hover:bg-port-border/70 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Restore DB
                            </button>
                            <button
                              onClick={() => handleDeleteSnapshot(snap)}
                              disabled={snap.incomplete}
                              title="Permanently delete this snapshot"
                              aria-label={`Delete snapshot ${snap.id}`}
                              className="p-2 min-h-[40px] min-w-[40px] bg-port-border hover:bg-port-error/80 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Trash2 size={14} />
                            </button>
                          </span>
                        </div>
                      </CollapsibleListItem>
                    </li>
                  );
                })}
              </ul>
              {snapshots.length > 10 && (
                <button
                  type="button"
                  onClick={() => setShowAllSnapshots(value => !value)}
                  aria-expanded={showAllSnapshots}
                  className="text-xs text-port-accent hover:text-port-accent/80 transition-colors min-h-[32px]"
                >
                  {showAllSnapshots ? 'Show newest 10 snapshots' : `Show all ${snapshots.length} snapshots`}
                </button>
              )}
            </>
          )}
        </CollapsibleSection>
      </div>

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
            This replays <code>portos-db.sql</code> from snapshot <code className="text-gray-300">{restoreTarget?.request.snapshotId}</code>
            {' '}on <span className="text-gray-300">{restoreTarget?.sourceLabel}</span>
            {restorePreview && <> ({formatBytes(restorePreview.sizeBytes || 0)} · {restorePreview.tableCount} tables)</>}
            {' '}as a full replacement of the live PostgreSQL database. All current application tables and rows are replaced, including tables added after this snapshot. Newer tables are recreated empty and current migrations run afterward.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setRestoreTarget(null); setRestorePreview(null); }} className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
            <button onClick={confirmRestoreDb} className="px-3 py-2 text-sm bg-port-warning hover:bg-port-warning/80 text-black font-medium rounded-lg transition-colors">Restore</button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        size="sm"
        usePortal
        ariaLabel="Delete snapshot"
      >
        <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
          <h3 className="text-white text-sm font-medium">Delete snapshot?</h3>
          <p className="text-sm text-gray-400">
            This permanently deletes snapshot <code className="text-gray-300">{deleteTarget?.snapshotId}</code>
            {' '}on <span className="text-gray-300">{deleteTarget?.sourceLabel}</span>, including its files and database dump. This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDeleteTarget(null)} className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors">Cancel</button>
            <button onClick={confirmDeleteSnapshot} className="px-3 py-2 text-sm bg-port-error hover:bg-port-error/80 text-white font-medium rounded-lg transition-colors">Delete</button>
          </div>
        </div>
      </Modal>

    </section>
  );
}

export default BackupTab;
