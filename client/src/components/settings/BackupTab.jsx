import { MIN_RETENTION_COUNT, MAX_RETENTION_COUNT, DEFAULT_RETENTION_COUNT } from '../../../../server/lib/backupConfig.js';
import { useState, useEffect, useId, useRef, useCallback } from 'react';
import useSettingsForm from '../../hooks/useSettingsForm';
import { AlertTriangle, CalendarClock, CheckCircle2, Database, Play, Save } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ToggleSwitch from '../ToggleSwitch';
import FolderPicker from '../FolderPicker';
import { useBackupRun } from '../../hooks/useBackupRun';
import Banner from '../ui/Banner';
import BackupExclusionsSection from './BackupExclusionsSection';
import BackupSnapshotsSection from './BackupSnapshotsSection';
import {
  getSettings,
  updateSettings,
  getBackupStatus,
  getBackupSnapshots,
  restoreDatabase,
  recoverDatabaseRestore,
  deleteBackupSnapshot,
} from '../../services/apiSystem.js';
import { formatBytes } from '../../utils/formatters';
import { describeCron } from '../../utils/cronHelpers';
import CronSchedulePicker from '../CronSchedulePicker';
import { isSafeExcludePattern } from '../../lib/backupExcludes';
import { pluralize } from '../../lib/textUtils';
import { failureMessage } from '../messages/failureMessage';

// Set equality — rsync --exclude flags are order-independent, so reordering
// is NOT a dirty state; only membership changes (added/removed entries) are.
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const FORM_COMPARATORS = { excludePaths: sameSet, disabledDefaultExcludes: sameSet };

// Schedule fields stay null/undefined until the API's resolved values land.
// `null` retentionCount = unlimited; undefined only before the initial load.
const INITIAL_FORM = {
  destPath: '', enabled: null, cronExpression: null, retentionCount: undefined,
  excludePaths: [], disabledDefaultExcludes: [],
};

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
// User-facing restore failures shared by preview and confirmation. Only proven
// refusals promise unchanged data; transport and unknown outcomes stay uncertain.
const DB_RESTORE_FAILURE_MESSAGES = {
  manifest_mismatch: 'Snapshot dump failed integrity verification',
  manifest_unreadable: 'Snapshot verification metadata could not be read. Choose another snapshot or repair the backup media before retrying.',
  dump_unreadable: 'The snapshot database dump could not be read or staged for restore. Nothing was changed; check the backup media and free temp space, then retry.',
  dump_incomplete: 'The snapshot database dump is incomplete (truncated or damaged). Nothing was changed; choose another snapshot.',
  restore_preflight: 'Database restore was refused because the database contains unexpected objects, ownership, or dependencies. Nothing was changed. Check the server logs and resolve the reported database conflict before trying again.',
  restore_preflight_unavailable: 'Database restore preflight check could not be completed because the database query failed. Nothing was changed. Restore database connectivity and retry preview before restoring.',
  restore_journal: 'The restore recovery journal could not be written. Nothing was changed. Check the server logs and available disk space before trying again.',
  backup_snapshot_busy: 'A backup is capturing the database, or an asset publication did not finish in time. Nothing was changed. Retry once the backup completes; if it keeps happening, the details that follow name the blocking publication and the Interrupted ownership recovery section of docs/BACKUP.md explains recovery.',
  database_restore_busy: 'The database restore was refused before changing any data.',
  no_dump: 'No DB dump in this snapshot',
  not_configured: 'The database is unavailable for restore. Check Database status and the server logs for connection details.',
  restore_error: 'Database restore failed. Check Backup status, any recovery warning, and the server logs for details.',
  timeout: 'Database restore timed out. Check Backup status, any recovery warning, and the server logs before taking further action.',
  request_error: 'Could not confirm the database restore result. Check Backup status and any recovery warning before starting another restore.',
};
const dbRestoreFailureMessage = (result) => {
  const message = DB_RESTORE_FAILURE_MESSAGES[result?.reason]
    || 'Database restore could not be confirmed. Check Backup status and the server logs for details.';
  // Producer explanations can name the specific missing table or database
  // conflict. Keep them in the owned toast alongside the safe next step.
  const details = typeof result?.error === 'string' ? result.error.trim() : '';
  return details ? `${message} Details: ${details}` : message;
};

export function BackupTab() {
  const destPathId = useId();
  const retentionId = useId();
  const exclusionsRef = useRef(null);
  const [loading, setLoading] = useState(true);
  // A settings response that never resolved is NOT 'the defaults' — the schedule
  // fields stay null and the form is replaced by an error panel, so an unreachable
  // API can't be saved back as invented values (#6632).
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadFailures, setLoadFailures] = useState({ status: false, exclusions: false });
  const patchLoadFailures = (patch) => setLoadFailures(prev => ({ ...prev, ...patch }));
  const [saving, setSaving] = useState(false);
  // Schedule state is seeded ONLY from the API's resolved values. The server
  // owns how a sparse backup config resolves (server/lib/backupConfig.js); a
  // client-side fallback here would be a second, conflicting interpretation —
  // which is exactly what silently cancelled destination-only schedules (#6632).
  const { values: form, saved, isDirty: dirty, set, load, markSaved } = useSettingsForm(INITIAL_FORM, { comparators: FORM_COMPARATORS });
  const { destPath, enabled, cronExpression, retentionCount, excludePaths, disabledDefaultExcludes } = form;
  const savedDestPath = saved.destPath;
  const savedEnabled = saved.enabled;
  const savedCronExpression = saved.cronExpression;
  // The number input's own DISPLAYED text, decoupled from the committed
  // `retentionCount`. A controlled `value` bound directly to a clamped
  // number snaps back to the old value the instant the field is cleared
  // (parseInt('') is NaN), which makes it impossible to select-all and type
  // a replacement. Free-typing lives here; `retentionCount` (used for dirty
  // checking and the save payload) only updates once the text parses.
  const [retentionInputText, setRetentionInputText] = useState('');
  const [defaultExcludes, setDefaultExcludes] = useState([]);
  const [pgBackup, setPgBackup] = useState(null);
  const [backupStatus, setBackupStatus] = useState('never');
  const [restoreWarning, setRestoreWarning] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [snapshotState, setSnapshotState] = useState('idle');
  const snapshotGenerationRef = useRef(0);
  const snapshotLoadingRef = useRef(false);
  const destinationGenerationRef = useRef(0);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const historyOpenRef = useRef(false);
  const savingRef = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const handleHistoryOpenChange = (next) => {
    historyOpenRef.current = next;
    if (!next) snapshotGenerationRef.current += 1;
    setHistoryOpen(next);
  };
  const [exclusionDisclosure, setExclusionDisclosure] = useState({});
  const toggleExclusionDisclosure = (key, next) => setExclusionDisclosure(prev => ({ ...prev, [key]: next }));
  const reviewExclusions = () => {
    setExclusionDisclosure({ exclusions: true, defaultExcludes: true, effectiveExcludes: true });
    exclusionsRef.current?.querySelector('button')?.focus({ preventScroll: true });
    exclusionsRef.current?.scrollIntoView?.({ block: 'start' });
  };
  const [restoreAction, setRestoreAction] = useState(null);
  // Claim the action synchronously so another event cannot enter before React
  // commits disabled controls.
  const restoreActionRef = useRef(null);
  const updateRestoreAction = (operation) => {
    restoreActionRef.current = operation;
    setRestoreAction(operation);
  };

  const closeRestore = () => {
    if (restoreActionRef.current?.phase === 'confirm') updateRestoreAction(null);
  };

  // A committed database restore awaiting recovery (#9725): the server keeps
  // ordinary database work fenced until it is resumed to completion.
  const [restoreRecovery, setRestoreRecovery] = useState(null);
  const [recovering, setRecovering] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // snapshot pending delete confirm
  const [deletingIds, setDeletingIds] = useState(new Set());
  const pendingDeletes = useRef(new Set());

  const loadInitialSettings = useCallback(() => {
    setLoading(true);
    setLoadFailed(false);
    Promise.allSettled([
      getSettings({ silent: true }),
      getBackupStatus({ silent: true }),
    ])
      .then(([settingsResult, statusResult]) => {
        if (settingsResult.status === 'rejected') throw settingsResult.reason;
        const statusLoadError = statusResult.status === 'rejected';
        const settings = settingsResult.value;
        const status = statusLoadError ? null : statusResult.value;
        const backup = settings?.backup || {};
        const savedDest = backup.destPath || '';
        const savedExcludes = asExcludeArray(backup.excludePaths);
        const savedDisabled = asArray(backup.disabledDefaultExcludes);
        patchLoadFailures({ status: statusLoadError, exclusions: statusLoadError });
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
        const savedRetention = backup.retentionCount;
        load({
          destPath: savedDest,
          enabled: backup.enabled,
          cronExpression: backup.cronExpression,
          retentionCount: savedRetention,
          excludePaths: savedExcludes,
          disabledDefaultExcludes: savedDisabled,
        });
        setRetentionInputText(savedRetention === null ? '' : String(savedRetention));
        setDefaultExcludes(asArray(status?.defaultExcludes));
        setPgBackup(status?.pgBackup ?? null);
        setBackupStatus(status?.status ?? 'never');
        setRestoreWarning(status?.restoreWarning ?? null);
        setRestoreRecovery(status?.restoreRecovery?.pending ? status.restoreRecovery : null);
      })
      .catch((err) => {
        setLoadFailed(true);
        toast.error(failureMessage('Could not load backup settings', err, 'Retry the request.'));
      })
      .finally(() => setLoading(false));
  }, [load]);

  useEffect(() => { loadInitialSettings(); }, [loadInitialSettings]);

  const refreshSnapshots = async () => {
    const generation = ++snapshotGenerationRef.current;
    snapshotLoadingRef.current = true;
    setSnapshotState('loading');
    try {
      const result = await getBackupSnapshots({ silent: true });
      if (generation !== snapshotGenerationRef.current) return;
      if (!Array.isArray(result)) throw new Error('Invalid snapshot history');
      setSnapshots(result.map(snapshot => ({
        ...snapshot,
        selectionKey: snapshot.selectionKey || `${snapshot.source || 'current'}/${snapshot.id}`,
        sourceLabel: snapshot.sourceLabel || snapshot.source || 'Current machine',
      })));
      setSnapshotState('loaded');
    } catch {
      if (generation === snapshotGenerationRef.current) setSnapshotState('error');
    } finally {
      if (generation === snapshotGenerationRef.current) snapshotLoadingRef.current = false;
    }
  };

  useEffect(() => {
    if (historyOpen && !savingRef.current) refreshSnapshots();
    return () => { snapshotGenerationRef.current += 1; };
  }, [historyOpen, snapshotRevision]);

  const handleSave = async () => {
    if (restoreActionRef.current?.phase === 'restore') return;
    savingRef.current = true;
    snapshotGenerationRef.current += 1;
    setSnapshotState('idle');
    if (destPath !== savedDestPath) {
      destinationGenerationRef.current += 1;
      setDeletingIds(new Set());
      closeRestore();
      setDeleteTarget(null);
    }
    setSaving(true);
    try {
      const submitted = { destPath, enabled, cronExpression, retentionCount, excludePaths, disabledDefaultExcludes };
      await updateSettings({ backup: submitted }, { silent: true });
      // Acknowledge only the submitted snapshot; edits made while the request
      // was pending stay dirty.
      markSaved(submitted, submitted);
      toast.success('Settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save settings');
    } finally {
      savingRef.current = false;
      setSaving(false);
      setSnapshotRevision(revision => revision + 1);
    }
  };

  const toggleDefaultExclude = (path) => {
    set('disabledDefaultExcludes', prev => prev.includes(path)
      ? prev.filter(p => p !== path)
      : [...prev, path]);
  };

  const [handleRunNow, running] = useBackupRun((result) => {
    setPgBackup(result?.pgBackup ?? null);
    setBackupStatus(result?.status ?? 'ok');
    setRestoreWarning(result?.restoreWarning ?? null);
    patchLoadFailures({ status: false });
    // A completed run establishes health, but does not include the exclusion
    // catalog. Recover that separately before enabling its controls.
    if (!historyOpenRef.current) setSnapshotState('idle');
    return Promise.all([
      historyOpenRef.current && !savingRef.current
        ? refreshSnapshots()
        : Promise.resolve(),
      loadFailures.exclusions
        ? getBackupStatus({ silent: true }).then(status => {
          setDefaultExcludes(asArray(status?.defaultExcludes));
          patchLoadFailures({ exclusions: false });
        }).catch((err) => { console.warn(`⚠️ Failed to refresh backup exclusions: ${err?.message || err}`); })
        : Promise.resolve(),
    ]);
  });

  if (loading) {
    return <BrailleSpinner text="Loading backup settings" />;
  }

  if (loadFailed) {
    return (
      <div className="text-sm text-port-error">
        <p>Failed to load backup settings. The form stays hidden so an unresolved response can&apos;t be saved over your schedule.</p>
        <button type="button" className="mt-3 px-3 py-2 border border-port-border rounded-lg hover:bg-port-border" onClick={loadInitialSettings}>Retry</button>
      </div>
    );
  }

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

  const scheduleSummary = savedEnabled
    ? (describeCron(savedCronExpression) || savedCronExpression)
    : 'Scheduled backups are off';
  const renderPgStatus = () => {
    if (loadFailures.status) return <span className="text-port-warning">Backup status unavailable — reload to retry</span>;
    if (!pgBackup) return <span className="text-gray-500">No backup run yet</span>;
    if (pgBackup.status === 'ok') {
      return <span className="text-port-success">✅ {formatBytes(pgBackup.sizeBytes || 0)} · {pluralize(pgBackup.tableCount, 'table')}</span>;
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

  const reportRestoreFailure = (result) => {
    if (result?.recovery) {
      // Committed (or not yet provably rolled back): resume, never replay.
      setRestoreRecovery({ pending: true, ...result.recovery });
      toast.error(result.error || 'The database restore needs recovery before the database can be used.', { duration: Infinity });
      return;
    }
    toast.error(dbRestoreFailureMessage(result));
  };

  const handleRestoreDb = async (snapshot) => {
    if (restoreActionRef.current || deleteTarget || savingRef.current) return;
    const destinationGeneration = destinationGenerationRef.current;
    const request = {
      snapshotId: snapshot.id,
      ...(snapshot.source ? { source: snapshot.source } : {}),
    };
    updateRestoreAction({ phase: 'preview', snapshotId: snapshot.id });
    let confirmation = null;
    try {
      // Dry-run first to show what would restore, then open the confirm modal.
      const preview = await restoreDatabase({ ...request, dryRun: true }, { silent: true })
        .catch(err => ({ status: 'failed', reason: 'request_error', error: err?.message }));
      if (destinationGenerationRef.current !== destinationGeneration) return;
      if (preview?.status !== 'ok') {
        reportRestoreFailure(preview);
        return;
      }
      confirmation = { phase: 'confirm', request, sourceLabel: snapshot.sourceLabel, preview };
    } finally {
      updateRestoreAction(confirmation);
    }
  };

  const confirmRestoreDb = async () => {
    const target = restoreActionRef.current;
    if (target?.phase !== 'confirm' || savingRef.current) return;
    updateRestoreAction({ ...target, phase: 'restore' });
    try {
      const result = await restoreDatabase({ ...target.request, dryRun: false }, { silent: true })
        .catch(err => ({ status: 'failed', reason: 'request_error', error: err?.message }));
      if (result?.status === 'ok') {
        toast.success(`Database restored from ${target.request.snapshotId}`, { icon: '💾' });
      } else {
        reportRestoreFailure(result);
      }
    } finally {
      updateRestoreAction(null);
    }
  };

  const resumeRestoreRecovery = async () => {
    if (!restoreRecovery?.id || recovering) return;
    setRecovering(true);
    const result = await recoverDatabaseRestore(restoreRecovery.id, { silent: true })
      .catch(err => ({ status: 'failed', error: err?.message }))
      .finally(() => setRecovering(false));
    if (result.status === 'ok') {
      setRestoreRecovery(null);
      toast.success(result.outcome === 'rolled_back'
        ? 'The restore had rolled back; the database is unchanged and available again.'
        : 'Database restore recovery finished; the database is available again.', { icon: '💾' });
      return;
    }
    if (result.recovery) setRestoreRecovery({ pending: true, ...result.recovery });
    toast.error(result.error || 'Database restore recovery is still pending; check the server logs.');
  };

  const handleDeleteSnapshot = (snapshot) => {
    if (restoreActionRef.current || deleteTarget || savingRef.current) return;
    setDeleteTarget({
      identity: snapshot.selectionKey,
      snapshotId: snapshot.id,
      source: snapshot.source,
      sourceLabel: snapshot.sourceLabel,
    });
  };

  const confirmDeleteSnapshot = async () => {
    const target = deleteTarget;
    if (!target || restoreActionRef.current || savingRef.current || pendingDeletes.current.has(target.identity)) return;
    setDeleteTarget(null);
    pendingDeletes.current.add(target.identity);
    const destinationGeneration = destinationGenerationRef.current;
    const result = await deleteBackupSnapshot(target.snapshotId, target.source, { silent: true })
      .catch(err => ({ deleted: false, error: err }));
    pendingDeletes.current.delete(target.identity);
    if (!result?.deleted) {
      toast.error(result?.error?.message || 'Failed to delete snapshot');
      return;
    }
    toast.success(`Deleted snapshot ${target.snapshotId}`);
    if (destinationGeneration !== destinationGenerationRef.current) return;
    snapshotGenerationRef.current += 1;
    setDeletingIds(previous => new Set(previous).add(target.identity));
    if (snapshotLoadingRef.current && historyOpenRef.current && !savingRef.current) refreshSnapshots();
  };

  const finishDeleteAnimation = (identity) => {
    setSnapshots(previous => previous.filter(snapshot => snapshot.selectionKey !== identity));
    setDeletingIds(previous => {
      const next = new Set(previous);
      next.delete(identity);
      return next;
    });
  };

  return (
    <section
      aria-labelledby="backup-settings-heading"
      data-testid="backup-settings-workspace"
      className="@container bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5"
    >
      <h2 id="backup-settings-heading" className="sr-only">Backup operations and configuration</h2>
      <div className="space-y-2 text-sm text-gray-400">
        <p>Use Time Machine for Mac-wide recovery. You can leave scheduled PortOS backups off if you&apos;ve verified that your backups can restore both the PortOS data folder and PostgreSQL. Use PortOS snapshots if you want an app-only restore or a portable PostgreSQL dump.</p>
        <p>PortOS snapshots cover app data and, when successful, a PostgreSQL dump, not your whole installation or Mac. Defaults exclude some large data, such as Blender film render frames and training checkpoints. Some exclusions are optional and others always apply, so even disabling every optional exclusion does not make a complete backup.</p>
        <button type="button" onClick={reviewExclusions} className="min-h-[40px] px-3 py-2 border border-port-border rounded-lg hover:bg-port-border text-gray-300">Review backup exclusions</button>
      </div>
      {restoreRecovery && (
        <Banner tone="error" icon={AlertTriangle} title="Database restore needs recovery" size="md">
          {restoreRecovery.damaged ? (
            <>The restore recovery journal is unreadable, so database features stay paused. Check the server logs; the journal is never cleared automatically.</>
          ) : (
            <>
              The restore from snapshot <code>{restoreRecovery.snapshotId}</code> is not finished, so database features are paused.
              Resume it to finish schema and peer-sync repair. The dump is never replayed again.{' '}
              <button
                type="button"
                onClick={resumeRestoreRecovery}
                disabled={recovering}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-error hover:bg-port-error/80 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {recovering ? <BrailleSpinner text="Recovering" className="text-white" /> : <><Database size={14} aria-hidden="true" /> Resume recovery</>}
              </button>
            </>
          )}
        </Banner>
      )}
      {backupStatus === 'degraded' && (
        <Banner tone="warning" icon={AlertTriangle} title="Last backup degraded" size="md">
          {restoreWarning?.message && <p>{restoreWarning.message}</p>}
          {pgBackup?.status === 'failed' && <>
            Files were saved but the database dump failed.{' '}
            {pgBackup?.reason === 'version_mismatch' ? (
              <>Your <code>pg_dump</code> is older than the running PostgreSQL server. Install/point at a <code>pg_dump</code> at least as new as the server (for example, <code>brew install postgresql@17</code>), or set <code>PORTOS_PGDUMP</code> to its path.</>
            ) : (
              <>Check that <code>pg_dump</code> is installed and PostgreSQL is reachable.</>
            )}
          </>}
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
                onChange={e => set('destPath', e.target.value)}
                className="flex-1 min-w-[12rem] bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                placeholder="/path/to/backups"
              />
              <FolderPicker value={destPath} onChange={(value) => set('destPath', value)} />
            </div>
          </div>

          <div className="space-y-4 min-w-0">
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-400">Enabled</span>
              <ToggleSwitch size="sm" enabled={enabled} onChange={() => set('enabled', !enabled)} ariaLabel="Scheduled backups" />
            </div>
            <div className="space-y-1">
              <span className="block text-sm text-gray-400">Schedule</span>
              <CronSchedulePicker value={cronExpression} onChange={(value) => set('cronExpression', value)} cronAriaLabel="Schedule (cron)" />
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
                    set('retentionCount', Math.min(MAX_RETENTION_COUNT, Math.max(MIN_RETENTION_COUNT, parsed)));
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
                      set('retentionCount', next);
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
          type="button"
          onClick={handleSave}
          disabled={saving || restoreAction?.phase === 'restore'}
          className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? <BrailleSpinner /> : <Save size={16} />}
          Save
        </button>
        <button
          type="button"
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

      <BackupExclusionsSection
        sectionRef={exclusionsRef}
        unavailable={loadFailures.exclusions}
        defaultExcludes={defaultExcludes}
        excludePaths={excludePaths}
        disabledDefaultExcludes={disabledDefaultExcludes}
        disclosure={exclusionDisclosure}
        toggleDisclosure={toggleExclusionDisclosure}
        toggleDefaultExclude={toggleDefaultExclude}
        setExcludePaths={(paths) => set('excludePaths', paths)}
      />

      <BackupSnapshotsSection
        snapshots={snapshots}
        snapshotState={snapshotState}
        saving={saving}
        open={historyOpen}
        onOpenChange={handleHistoryOpenChange}
        refreshSnapshots={refreshSnapshots}
        restoreAction={restoreAction}
        handleRestoreDb={handleRestoreDb}
        closeRestore={closeRestore}
        confirmRestoreDb={confirmRestoreDb}
        deleteTarget={deleteTarget}
        handleDeleteSnapshot={handleDeleteSnapshot}
        closeDelete={() => setDeleteTarget(null)}
        confirmDeleteSnapshot={confirmDeleteSnapshot}
        deletingIds={deletingIds}
        finishDeleteAnimation={finishDeleteAnimation}
      />

    </section>
  );
}

export default BackupTab;
