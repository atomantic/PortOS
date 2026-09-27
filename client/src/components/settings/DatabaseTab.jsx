import { useState, useEffect, useRef, useCallback } from 'react';
import { Container, HardDrive, Download, ArrowRightLeft, Wrench, RefreshCw, Square, RotateCw, Play, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { formatBytes, formatCount, formatDurationMs } from '../../utils/formatters';
import {
  getDatabaseStatus, setupNativeDatabase, exportDatabase, fixDatabase,
  syncDatabase, startDatabase, stopDatabase, destroyDatabase,
  getDatabaseMaintenanceStatus, cutoverDatabase, recoverDatabaseCutover
} from '../../services/api';
import socket from '../../services/socket';
import { safeReadJsonSession, safeWriteJsonSession, safeRemoveSession } from '../../lib/safeStorage';

// Session-scoped: the cutover restarts this server, so the tab reloads or
// reconnects mid-operation. Persisting only for the tab's lifetime keeps a
// stale marker from resurrecting a finished operation in a future session.
const OWN_OPERATION_KEY = 'portos-database-cutover-operation';
const CUTOVER_TOAST_ID = 'portos-database-cutover';

const STAGE_LABELS = {
  accepted: 'Preparing cutover',
  quiescing: 'Draining writers',
  exporting: 'Exporting source database',
  importing: 'Importing into target',
  committing: 'Committing configuration',
  verifying: 'Restarting and verifying target',
  verified: 'Verified',
};

function BackendCard({ label, icon: Icon, backend, isActive, dbStatus, runAction, setConfirmAction, actionInProgress, busy, exportDatabase: exportDb }) {
  const data = dbStatus?.[backend];
  const isRunning = backend === 'docker' ? data?.containerRunning : data?.running;
  const canStart = backend === 'docker'
    ? data?.installed && data?.daemonRunning && !data?.containerRunning
    : data?.configured && !data?.running;
  const canDestroy = !isActive && !isRunning && (backend === 'docker' ? data?.installed : data?.configured);
  const statusLabel = isRunning ? 'Running'
    : (backend === 'docker' ? (data?.installed ? 'Stopped' : 'Not installed')
      : (data?.configured ? 'Stopped' : data?.installed ? 'Not configured' : 'Not installed'));
  const statusColor = isRunning ? 'bg-port-success' : (data?.installed || data?.configured) ? 'bg-port-warning' : 'bg-gray-600';
  const displayLabel = backend === 'docker' ? 'Docker' : 'Native';
  const activeLabel = backend === 'docker' ? 'Native' : 'Docker';

  const btnClass = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50';

  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Icon size={14} />
          {label}
        </div>
        <div className="flex items-center gap-1.5">
          {isActive && (
            <span className="text-xs px-1.5 py-0.5 bg-port-accent/20 text-port-accent rounded">Active</span>
          )}
          <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        </div>
      </div>

      <div className="text-sm text-white">{statusLabel}</div>

      {/* Resource stats */}
      {data?.stats && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-gray-400 pt-1 border-t border-port-border/50">
          <span>CPU: <span className="text-gray-300">{data.stats.cpu}</span></span>
          <span>Memory: <span className="text-gray-300">{data.stats.memUsage}</span></span>
          <span>Mem%: <span className="text-gray-300">{data.stats.memPercent}</span></span>
          <span>PIDs: <span className="text-gray-300">{data.stats.pids}</span></span>
          {data.stats.netIO && <span>Net I/O: <span className="text-gray-300">{data.stats.netIO}</span></span>}
          {data.stats.blockIO && <span>Block I/O: <span className="text-gray-300">{data.stats.blockIO}</span></span>}
        </div>
      )}
      {data?.diskUsage && (
        <div className="text-xs text-gray-400">
          Disk: <span className="text-gray-300">{data.diskUsage}</span>
        </div>
      )}

      {/* Card actions */}
      <div className="flex flex-wrap gap-1.5 pt-1 border-t border-port-border/50">
        {/* Start / Stop */}
        {isRunning && !isActive && (
          <button
            onClick={() => runAction(`stop-${backend}`, () => stopDatabase(backend), `${displayLabel} stopped`)}
            disabled={busy}
            className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white`}
          >
            {actionInProgress === `stop-${backend}` ? <BrailleSpinner /> : <Square size={12} />}
            Stop
          </button>
        )}
        {canStart && (
          <button
            onClick={() => runAction(`start-${backend}`, () => startDatabase(backend), `${displayLabel} started`)}
            disabled={busy}
            className={`${btnClass} bg-port-success/20 hover:bg-port-success/30 text-port-success`}
          >
            {actionInProgress === `start-${backend}` ? <BrailleSpinner /> : <Play size={12} />}
            Start
          </button>
        )}

        {/* Export/Backup from this backend */}
        {isRunning && (
          <button
            onClick={() => runAction(`export-${backend}`, () => exportDb(backend), (r) => `Backed up to ${r.dumpFile}`)}
            disabled={busy}
            className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white`}
            title={`Export ${displayLabel} database to SQL dump`}
          >
            {actionInProgress === `export-${backend}` ? <BrailleSpinner /> : <Download size={12} />}
            Backup
          </button>
        )}

        {/* Non-active backend actions */}
        {!isActive && (data?.installed || data?.configured) && (
          <>
            {/* Sync data from active into this backend */}
            <button
              onClick={() => setConfirmAction({
                type: 'sync',
                label: `Sync from ${activeLabel} to ${displayLabel}?`,
                detail: `Copies data from the active ${activeLabel} database into ${displayLabel}. ${displayLabel} will be left in its current state (running or stopped).`,
                action: () => runAction(`sync-${backend}`, syncDatabase, `Data synced from ${activeLabel} to ${displayLabel}`)
              })}
              disabled={busy}
              className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white`}
            >
              <RotateCw size={12} />
              Sync from {activeLabel}
            </button>

            {/* Destroy */}
            {canDestroy && (
              <button
                onClick={() => setConfirmAction({
                  type: 'destroy',
                  label: `Destroy ${displayLabel} database and all its data?`,
                  detail: 'This permanently removes the database files. You can set it up again later.',
                  action: () => runAction(`destroy-${backend}`, () => destroyDatabase(backend), `${displayLabel} database destroyed`)
                })}
                disabled={busy}
                className={`${btnClass} bg-port-error/20 hover:bg-port-error/30 text-port-error`}
              >
                <Trash2 size={12} />
                Destroy
              </button>
            )}
          </>
        )}

        {/* Setup native (when not configured) */}
        {backend === 'native' && !data?.configured && (
          <button
            onClick={() => runAction('setup', setupNativeDatabase, 'Native PostgreSQL installed and configured')}
            disabled={busy}
            className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white`}
          >
            {actionInProgress === 'setup' ? <BrailleSpinner /> : <HardDrive size={12} />}
            {data?.installed ? 'Setup' : 'Install'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Coordinated offline backend cutover (#8811). The journal that backs
 * `GET /database/maintenance/status` is durable on disk and outlives the
 * server restart the cutover performs, so it is the single source of truth
 * for "what happened" — never the accepted-request response, a reconnect, or
 * a saved-mode change alone. Only a `fenced: false` read whose `lastCutover.id`
 * matches the operation THIS tab started counts as a verified success.
 */
function MigrationPanel({ dbStatus, maintenance, maintenanceLoading, downtimeMs, justVerified, onMigrate, onRecover, recovering, busy, recoverDisabled }) {
  if (maintenanceLoading && !maintenance) {
    return <BrailleSpinner text="Checking migration status" />;
  }
  if (!maintenance) {
    return (
      <p className="text-sm text-gray-500">Unable to check migration status. Use Refresh above to retry.</p>
    );
  }

  if (maintenance.fenced) {
    const needsRecovery = maintenance.coordinator === 'exited';
    const label = STAGE_LABELS[maintenance.stage] || maintenance.stage;
    return (
      <div className={`rounded-lg p-3 space-y-2 border ${needsRecovery ? 'bg-port-error/10 border-port-error/30' : 'bg-port-accent/10 border-port-accent/20'}`}>
        <div className="flex items-center gap-2 text-sm">
          {needsRecovery ? <AlertTriangle size={14} className="text-port-error" /> : <BrailleSpinner />}
          <span className={needsRecovery ? 'text-port-error' : 'text-port-accent'}>
            {maintenance.source} &rarr; {maintenance.target}: {label}
            {needsRecovery && ' (interrupted)'}
          </span>
        </div>
        {needsRecovery ? (
          <>
            <p className="text-xs text-gray-400">
              The cutover worker exited before finishing. It is safe to resume — the operation resumes from its recorded
              stage and will not reverse direction or repeat completed work.
            </p>
            <button
              onClick={() => onRecover(maintenance)}
              disabled={recoverDisabled}
              className="flex items-center gap-2 px-3 py-1.5 bg-port-error/20 hover:bg-port-error/30 text-port-error text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {recovering ? <BrailleSpinner /> : <RotateCw size={14} />}
              Resume cutover
            </button>
          </>
        ) : (
          <p className="text-xs text-gray-400">
            PortOS will stop and restart itself to complete this. Other database actions are disabled until it finishes.
          </p>
        )}
      </div>
    );
  }

  const target = dbStatus?.mode === 'docker' ? 'native' : 'docker';
  const targetLabel = target === 'docker' ? 'Docker' : 'Native';
  const sourceLabel = dbStatus?.mode === 'docker' ? 'Docker' : 'Native';

  return (
    <div className="space-y-2">
      {justVerified && maintenance.lastCutover && (
        <div className="flex items-center gap-2 text-sm text-port-success bg-port-success/10 border border-port-success/20 rounded-lg px-3 py-2">
          <CheckCircle2 size={14} />
          <span>
            Verified — now running on {maintenance.lastCutover.target}
            {downtimeMs != null && ` (downtime ${formatDurationMs(downtimeMs)})`}
          </span>
        </div>
      )}
      <button
        onClick={() => onMigrate({ source: dbStatus?.mode, target })}
        disabled={busy || !dbStatus?.mode}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-border hover:bg-port-border/70 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
      >
        <ArrowRightLeft size={14} />
        Migrate {sourceLabel} &rarr; {targetLabel}
      </button>
      <p className="text-xs text-gray-500">
        Stops PortOS, transfers data, commits the new backend, and restarts — verifying the restarted server before
        reporting success. Expect brief downtime. Backups remain available regardless.
      </p>
    </div>
  );
}

export function DatabaseTab() {
  const [dbStatus, setDbStatus] = useState(null);
  const [dbLoading, setDbLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState(null);
  const [progressMsg, setProgressMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState(null);
  const [maintenance, setMaintenance] = useState(null);
  const [maintenanceLoading, setMaintenanceLoading] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [downtimeMs, setDowntimeMs] = useState(null);
  const [justVerified, setJustVerified] = useState(false);
  const progressTimer = useRef(null);
  // The operation THIS tab started, if any: { id, source, target, acceptedAt }.
  // Session-scoped because the server restarts mid-operation; a page reload in
  // the same tab must still recognize its own cutover once it reconciles.
  const ownOperationRef = useRef(safeReadJsonSession(OWN_OPERATION_KEY));
  const wentDownAtRef = useRef(null);
  const hasConnectedOnceRef = useRef(socket.connected);

  const loadStatus = useCallback(() => {
    setDbLoading(true);
    getDatabaseStatus({ silent: true })
      .then(setDbStatus)
      .catch(() => toast.error('Failed to load database status'))
      .finally(() => setDbLoading(false));
  }, []);

  const reconcileMaintenance = useCallback(() => {
    setMaintenanceLoading(true);
    getDatabaseMaintenanceStatus()
      .then((status) => {
        setMaintenance(status);
        const own = ownOperationRef.current;
        if (!own) return;
        if (status.fenced && status.id !== own.id) {
          // A different operation is fenced (e.g. started from the CLI) —
          // this tab's own marker no longer applies.
          ownOperationRef.current = null;
          safeRemoveSession(OWN_OPERATION_KEY);
          toast.dismiss(CUTOVER_TOAST_ID);
          return;
        }
        if (!status.fenced) {
          if (status.lastCutover?.id === own.id) {
            const downtime = wentDownAtRef.current ? Date.now() - wentDownAtRef.current : null;
            setDowntimeMs(downtime);
            setJustVerified(true);
            toast.success(`Database migrated to ${status.lastCutover.target}`, { id: CUTOVER_TOAST_ID });
          } else {
            // No matching verified record — cancelled or superseded. Never
            // claim success for an accepted-but-unresolved operation.
            toast.dismiss(CUTOVER_TOAST_ID);
          }
          ownOperationRef.current = null;
          safeRemoveSession(OWN_OPERATION_KEY);
          wentDownAtRef.current = null;
        } else if (status.coordinator === 'exited') {
          toast.error('Database cutover was interrupted and needs recovery.', { id: CUTOVER_TOAST_ID });
        }
      })
      .catch(() => setMaintenance(null))
      .finally(() => setMaintenanceLoading(false));
  }, []);

  useEffect(() => {
    loadStatus();
    reconcileMaintenance();

    const handleProgress = (data) => {
      clearTimeout(progressTimer.current);
      setProgressMsg(data.message || '');
      if (data.event === 'complete') {
        progressTimer.current = setTimeout(() => setProgressMsg(''), 3000);
        loadStatus();
      }
      if (data.event === 'error') {
        progressTimer.current = setTimeout(() => setProgressMsg(''), 5000);
      }
    };

    // Push, don't poll: the cutover restarts this server, so there is no
    // event stream during that gap. Socket.IO's own reconnect (not a
    // client-driven interval) is the signal that it's safe to re-read the
    // durable maintenance journal.
    const handleConnect = () => {
      if (!hasConnectedOnceRef.current) {
        hasConnectedOnceRef.current = true;
        return;
      }
      // A real reconnect (not the initial connect) — the durable journal may
      // have moved on while this tab had no socket. Downtime (if any) was
      // already captured by handleDisconnect below.
      loadStatus();
      reconcileMaintenance();
    };
    const handleDisconnect = () => {
      if (ownOperationRef.current && wentDownAtRef.current == null) {
        wentDownAtRef.current = Date.now();
      }
    };

    socket.on('database:progress', handleProgress);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    return () => {
      socket.off('database:progress', handleProgress);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      clearTimeout(progressTimer.current);
    };
  }, [loadStatus, reconcileMaintenance]);

  const runAction = useCallback((key, fn, successMsg) => {
    setConfirmAction(null);
    setActionInProgress(key);
    fn()
      .then((result) => {
        if (successMsg) toast.success(typeof successMsg === 'function' ? successMsg(result) : successMsg);
        loadStatus();
      })
      .catch(() => { /* request() already surfaces API errors as a toast */ })
      .finally(() => setActionInProgress(null));
  }, [loadStatus]);

  const handleMigrate = useCallback((direction) => {
    setConfirmAction(null);
    setActionInProgress('cutover');
    cutoverDatabase(direction)
      .then((accepted) => {
        const own = { id: accepted.id, source: accepted.source, target: accepted.target, acceptedAt: Date.now() };
        ownOperationRef.current = own;
        safeWriteJsonSession(OWN_OPERATION_KEY, own);
        wentDownAtRef.current = null;
        setDowntimeMs(null);
        setJustVerified(false);
        // Accepted only — never a success toast. PortOS is about to restart.
        toast.loading(`Cutover accepted (${accepted.source} → ${accepted.target}) — PortOS will restart`, {
          id: CUTOVER_TOAST_ID, duration: Infinity,
        });
        setMaintenance({ id: accepted.id, stage: accepted.stage, source: accepted.source, target: accepted.target, coordinator: 'unclaimed', fenced: true });
      })
      .catch(() => { /* request() already surfaces API errors as a toast */ })
      .finally(() => setActionInProgress(null));
  }, []);

  const handleRecover = useCallback((operation) => {
    setRecovering(true);
    recoverDatabaseCutover(operation.id)
      .then(() => {
        // Claim the same operation id — even a tab that only resumed it
        // (rather than starting it) should see the eventual verified result.
        const own = { id: operation.id, source: operation.source, target: operation.target, acceptedAt: Date.now() };
        ownOperationRef.current = own;
        safeWriteJsonSession(OWN_OPERATION_KEY, own);
        wentDownAtRef.current = null;
        setDowntimeMs(null);
        setJustVerified(false);
        toast.loading('Resuming interrupted cutover — PortOS will restart', { id: CUTOVER_TOAST_ID, duration: Infinity });
        reconcileMaintenance();
      })
      .catch(() => { /* request() already surfaces API errors as a toast */ })
      .finally(() => setRecovering(false));
  }, [reconcileMaintenance]);

  const busy = actionInProgress != null || Boolean(maintenance?.fenced) || recovering;
  // The Recover button lives INSIDE the fenced/interrupted state, so it must
  // not be gated by `maintenance.fenced` — that would make it permanently
  // disabled the one time it needs to be clickable.
  const recoverDisabled = actionInProgress != null || recovering;

  return (
    <div className="space-y-4">
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-5">
        {/* Connection summary */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={`w-2 h-2 rounded-full ${dbStatus?.connected ? 'bg-port-success' : 'bg-port-error'}`} />
            <span className="text-sm text-gray-300">
              {dbStatus?.connected ? 'Connected' : dbStatus ? 'Disconnected' : ''}
              {dbStatus?.memoryCount != null && ` — ${formatCount(dbStatus.memoryCount)} memories`}
              {dbStatus?.dbBytes != null && ` — ${formatBytes(dbStatus.dbBytes)}`}
              {dbStatus?.tableCount != null && ` (${dbStatus.tableCount} tables)`}
            </span>
          </div>
          <button
            onClick={() => { loadStatus(); reconcileMaintenance(); }}
            disabled={dbLoading}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white transition-colors"
            title="Refresh status" aria-label="Refresh status"
          >
            <RefreshCw size={14} className={dbLoading ? 'animate-spin' : ''} />
          </button>
        </div>

        {dbLoading && !dbStatus ? (
          <BrailleSpinner text="Loading database status" />
        ) : dbStatus ? (
          <>
            {/* Backend cards with inline actions */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <BackendCard
                label="Docker" icon={Container} backend="docker"
                isActive={dbStatus.mode === 'docker'} dbStatus={dbStatus}
                runAction={runAction} setConfirmAction={setConfirmAction}
                actionInProgress={actionInProgress} busy={busy}
                exportDatabase={exportDatabase}
              />
              <BackendCard
                label="Native" icon={HardDrive} backend="native"
                isActive={dbStatus.mode === 'native'} dbStatus={dbStatus}
                runAction={runAction} setConfirmAction={setConfirmAction}
                actionInProgress={actionInProgress} busy={busy}
                exportDatabase={exportDatabase}
              />
            </div>

            <MigrationPanel
              dbStatus={dbStatus}
              maintenance={maintenance}
              maintenanceLoading={maintenanceLoading}
              downtimeMs={downtimeMs}
              justVerified={justVerified}
              onMigrate={(direction) => setConfirmAction({
                type: 'migrate',
                label: `Migrate from ${direction.source} to ${direction.target}?`,
                detail: 'PortOS stops itself, transfers the data, and restarts on the new backend. This causes brief downtime and cannot be cancelled once the transfer starts.',
                action: () => handleMigrate(direction),
              })}
              onRecover={handleRecover}
              recovering={recovering}
              busy={busy}
              recoverDisabled={recoverDisabled}
            />

            {/* Progress indicator */}
            {progressMsg && (
              <div className="flex items-center gap-2 text-sm text-port-accent bg-port-accent/10 border border-port-accent/20 rounded-lg px-3 py-2">
                <BrailleSpinner />
                {progressMsg}
              </div>
            )}

            {/* Confirmation dialog */}
            {confirmAction && (
              <div className={`bg-port-bg border rounded-lg p-4 space-y-3 ${
                confirmAction.type === 'destroy' ? 'border-port-error/30' : 'border-port-warning/30'
              }`}>
                <p className="text-sm text-white">{confirmAction.label}</p>
                {confirmAction.detail && (
                  <p className="text-xs text-gray-400">{confirmAction.detail}</p>
                )}
                <div className="flex items-center gap-2">
                  <button
                    onClick={confirmAction.action}
                    disabled={busy}
                    className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${
                      confirmAction.type === 'destroy'
                        ? 'bg-port-error/20 hover:bg-port-error/30 text-port-error'
                        : 'bg-port-warning/20 hover:bg-port-warning/30 text-port-warning'
                    }`}
                  >
                    {busy ? <BrailleSpinner /> : <ArrowRightLeft size={14} />}
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirmAction(null)}
                    className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Global actions */}
            {!dbStatus.connected && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => runAction('fix', fixDatabase, 'Database fixed')}
                  disabled={busy}
                  className="flex items-center gap-2 px-3 py-1.5 bg-port-error/20 hover:bg-port-error/30 text-port-error text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                  title="Fix stale PID files and other issues"
                >
                  {actionInProgress === 'fix' ? <BrailleSpinner /> : <Wrench size={14} />}
                  Fix
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-500">Unable to load database status</p>
        )}
      </div>
    </div>
  );
}

export default DatabaseTab;
