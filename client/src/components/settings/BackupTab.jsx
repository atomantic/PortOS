import { MIN_RETENTION_COUNT, MAX_RETENTION_COUNT, DEFAULT_RETENTION_COUNT } from '../../../../server/lib/backupConfig.js';
import { useState, useEffect, useId, useRef, useCallback } from 'react';
import useSettingsForm from '../../hooks/useSettingsForm';
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
import { anchorUserExclude, anchorUserExcludes, isSafeExcludePattern } from '../../lib/backupExcludes';
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
  backup_snapshot_busy: 'A backup is capturing the database, or an asset publication did not finish in time. Nothing was changed. Retry once the backup completes; if it keeps happening, the details that follow name the blocking publication and docs/BACKUP_PUBLICATION_ADMISSION.md explains recovery.',
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
  const [newExclude, setNewExclude] = useState('');
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
  // Disclosure open/closed flags for the collapsible panels, all collapsed by default.
  const [disclosure, setDisclosure] = useState({});
  const toggleDisclosure = (key, next) => setDisclosure(prev => ({ ...prev, [key]: typeof next === 'function' ? next(!!prev[key]) : next }));
  const reviewExclusions = () => {
    setDisclosure(prev => ({ ...prev, exclusions: true, defaultExcludes: true, effectiveExcludes: true }));
    exclusionsRef.current?.querySelector('button')?.focus({ preventScroll: true });
    exclusionsRef.current?.scrollIntoView?.({ block: 'start' });
  };
  const [restoreTarget, setRestoreTarget] = useState(null); // source-bound request pending confirm
  const [restorePreview, setRestorePreview] = useState(null); // dry-run result
  // A committed database restore awaiting recovery (#9725): the server keeps
  // ordinary database work fenced until it is resumed to completion.
  const [restoreRecovery, setRestoreRecovery] = useState(null);
  const [recovering, setRecovering] = useState(false);
  const restorePreviewGenerationRef = useRef(0);
  const [deleteTarget, setDeleteTarget] = useState(null); // snapshot pending delete confirm
  const [deletingIds, setDeletingIds] = useState(new Set());
  const pendingDeletes = useRef(new Set());
  // The default-exclusions catalog is a 15+ row reference list the user rarely
  // edits — collapsed by default so the fields they came to change (destination,
  // enabled, schedule) and the action bar are what the tab actually shows.
  // Same reasoning as the catalog above: the effective list is defaults + user
  // entries, so it is longer still. Collapsed by default, one click from visible.

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
      setSnapshots(result);
      setSnapshotState('loaded');
    } catch {
      if (generation === snapshotGenerationRef.current) setSnapshotState('error');
    } finally {
      if (generation === snapshotGenerationRef.current) snapshotLoadingRef.current = false;
    }
  };

  useEffect(() => {
    if (disclosure.snapshots && !savingRef.current) refreshSnapshots();
    return () => { snapshotGenerationRef.current += 1; };
  }, [disclosure.snapshots, snapshotRevision]);

  const handleSave = async () => {
    savingRef.current = true;
    snapshotGenerationRef.current += 1;
    setSnapshotState('idle');
    if (destPath !== savedDestPath) {
      destinationGenerationRef.current += 1;
      setDeletingIds(new Set());
      restorePreviewGenerationRef.current += 1;
      setRestoreTarget(null);
      setRestorePreview(null);
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

  // Anchor exactly as the server does on read, so the chip the user sees IS the
  // rsync filter that will run. A bare `repos/` would otherwise match every
  // `repos/` at any depth under data/ and silently drop unrelated records (#7241).
  const addExclude = () => {
    const anchored = anchorUserExclude(newExclude);
    if (!anchored) return;
    if (!excludePaths.includes(anchored)) set('excludePaths', [...excludePaths, anchored]);
    setNewExclude('');
  };

  const removeExclude = (index) => {
    set('excludePaths', excludePaths.filter((_, i) => i !== index));
  };

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
  const snapshotSummary = snapshotState === 'error'
    ? 'Unavailable — open to retry'
    : snapshotState === 'loading' ? 'Loading…'
    : snapshotState !== 'loaded' ? 'Open to load'
    : snapshots.length > 0
    ? `${snapshots.length} ${snapshots.length === 1 ? 'snapshot' : 'snapshots'}`
    : 'No snapshots yet';
  const exclusionsSummary = loadFailures.exclusions
    ? 'Unavailable — reload to retry'
    : excludePaths.length > 0
    ? `${excludePaths.length} custom · ${effectiveExcludes.length} active patterns`
    : `${effectiveExcludes.length} active patterns`;

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
      .catch(err => ({ status: 'failed', reason: 'request_error', error: err?.message }));
    if (restorePreviewGenerationRef.current !== generation) return;
    if (preview?.status !== 'ok') {
      reportRestoreFailure(preview);
      return;
    }
    setRestorePreview(preview);
    setRestoreTarget({ request, sourceLabel: snapshotSourceLabel(snapshot) });
  };

  const confirmRestoreDb = async () => {
    const target = restoreTarget;
    setRestoreTarget(null);
    const result = await restoreDatabase({ ...target.request, dryRun: false }, { silent: true })
      .catch(err => ({ status: 'failed', reason: 'request_error', error: err?.message }));
    if (result?.status === 'ok') {
      toast.success(`Database restored from ${target.request.snapshotId}`, { icon: '💾' });
    } else {
      reportRestoreFailure(result);
    }
    setRestorePreview(null);
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

      <div ref={exclusionsRef} className="scroll-mt-20 border-t border-port-border pt-5">
        <CollapsibleSection
          label="Exclusions"
          icon={ShieldOff}
          summary={exclusionsSummary}
          id={exclusionsPanelId}
          open={!!disclosure.exclusions}
          onOpenChange={(next) => toggleDisclosure('exclusions', next)}
          size="bar"
          className="space-y-3"
          bodyClassName="space-y-4 pt-2"
        >
          {loadFailures.exclusions ? (
            <p className="text-sm text-port-warning">Backup exclusion details are unavailable — reload to retry before editing these rules.</p>
          ) : (
            <>
              <p className="text-sm text-gray-400">Review default and custom rules that keep data out of snapshots. Optional defaults can be disabled; always-excluded rules cannot. Custom rules still apply independently.</p>

          {defaultExcludeRows.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => toggleDisclosure('defaultExcludes', v => !v)}
                aria-expanded={!!disclosure.defaultExcludes}
                aria-controls={defaultExcludesPanelId}
                className="flex items-center gap-2 w-full text-left text-sm text-gray-400 hover:text-white transition-colors min-h-[44px]"
              >
                {disclosure.defaultExcludes ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
                <ShieldOff size={14} className="text-gray-500 shrink-0" />
                <span>Default exclusions — {enabledDefaultCount} enabled, {disabledDefaultCount} disabled</span>
              </button>
              {disclosure.defaultExcludes && (
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
                          <span className="text-gray-400">{d.overridable ? 'Optional' : 'Always excluded'} · </span>{d.reason}
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
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex items-center justify-center min-w-[40px] min-h-[40px] px-3 py-2 bg-port-border hover:bg-port-border/70 text-white rounded-lg transition-colors disabled:opacity-50 shrink-0"
              >
                <Plus size={16} />
              </button>
            </div>
            {excludePaths.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {excludePaths.map((path, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-port-bg border border-port-border rounded-lg text-sm text-gray-300">
                    <code className="text-xs break-all">{path}</code>
                    <button onClick={() => removeExclude(i)} aria-label="Dismiss" className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-port-error transition-colors">
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
                  onClick={() => toggleDisclosure('effectiveExcludes', v => !v)}
                  aria-expanded={!!disclosure.effectiveExcludes}
                  aria-controls={effectiveExcludesPanelId}
                  className="flex items-center gap-2 w-full text-left text-sm text-gray-400 hover:text-white transition-colors min-h-[44px]"
                >
                  {disclosure.effectiveExcludes ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
                  <span>Effective exclude list — {effectiveExcludes.length} rsync {effectiveExcludes.length === 1 ? 'pattern' : 'patterns'}</span>
                </button>
                {disclosure.effectiveExcludes && (
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
          open={!!disclosure.snapshots}
          onOpenChange={(next) => {
            historyOpenRef.current = next;
            if (!next) snapshotGenerationRef.current += 1;
            toggleDisclosure('snapshots', next);
          }}
          size="bar"
          className="space-y-3"
          bodyClassName="space-y-2 pt-2"
        >
          {saving || snapshotState === 'idle' || snapshotState === 'loading' ? (
            <BrailleSpinner text="Loading snapshot history" />
          ) : snapshotState === 'error' ? (
            <div className="text-sm text-port-warning">
              Snapshot history is unavailable.{' '}
              <button type="button" onClick={refreshSnapshots} className="px-3 py-2 border border-port-border rounded-lg hover:bg-port-border">Retry</button>
            </div>
          ) : snapshots.length === 0 ? (
            <p className="text-sm text-gray-500">No snapshots have been recorded on this machine yet.</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {(disclosure.allSnapshots ? snapshots : snapshots.slice(0, 10)).map((snap) => {
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
                            {snap.interrupted ? (
                              <span className="block text-port-warning">Interrupted</span>
                            ) : snap.failed && (
                              <span className="block text-port-error">Backup failed — download only</span>
                            )}
                            {snap.incomplete && (
                              <span className="block text-gray-500">Still being written…</span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <button
                              onClick={() => handleRestoreDb(snap)}
                              disabled={snap.failed || snap.incomplete || snap.interrupted}
                              title={snap.interrupted
                                ? 'An interrupted backup snapshot cannot be restored'
                                : snap.failed ? 'Failed backup snapshots can only be downloaded for salvage' : undefined}
                              className="px-2 py-2 min-h-[40px] bg-port-border hover:bg-port-border/70 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Restore DB
                            </button>
                            <button
                              onClick={() => handleDeleteSnapshot(snap)}
                              disabled={snap.incomplete}
                              title="Permanently delete this snapshot"
                              aria-label={`Delete snapshot ${snap.id}`}
                              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 min-h-[40px] min-w-[40px] bg-port-border hover:bg-port-error/80 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                  onClick={() => toggleDisclosure('allSnapshots', v => !v)}
                  aria-expanded={!!disclosure.allSnapshots}
                  className="text-xs text-port-accent hover:text-port-accent/80 transition-colors min-h-[32px]"
                >
                  {disclosure.allSnapshots ? 'Show newest 10 snapshots' : `Show all ${snapshots.length} snapshots`}
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
            {restorePreview && <> ({formatBytes(restorePreview.sizeBytes || 0)} · {pluralize(restorePreview.tableCount, 'table')})</>}
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
