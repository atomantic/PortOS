import { useState, useEffect, useRef, useCallback } from 'react';
import { Container, HardDrive, Download, ArrowRightLeft, Wrench, RefreshCw, Square, RotateCw, Play, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { formatBytes } from '../../utils/formatters';
import {
  getDatabaseStatus, switchDatabase, setupNativeDatabase, exportDatabase, fixDatabase,
  syncDatabase, startDatabase, stopDatabase, destroyDatabase
} from '../../services/api';
import socket from '../../services/socket';

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
            {/* Migrate & switch to this backend */}
            <button
              onClick={() => setConfirmAction({
                type: 'migrate',
                label: `Migrate to ${displayLabel} and switch?`,
                detail: `Exports data from ${activeLabel}, imports into ${displayLabel}, and makes ${displayLabel} the active backend.`,
                action: () => runAction(`migrate-${backend}`, () => switchDatabase(backend, true), `Migrated to ${displayLabel}`)
              })}
              disabled={busy}
              className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
            >
              <ArrowRightLeft size={12} />
              Migrate to {displayLabel}
            </button>

            {/* Switch without migration */}
            <button
              onClick={() => setConfirmAction({
                type: 'switch',
                label: `Switch to ${displayLabel} without migrating data?`,
                action: () => runAction(`switch-${backend}`, () => switchDatabase(backend, false), `Switched to ${displayLabel}`)
              })}
              disabled={busy}
              className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white`}
            >
              <ArrowRightLeft size={12} />
              Switch
            </button>

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

export function DatabaseTab() {
  const [dbStatus, setDbStatus] = useState(null);
  const [dbLoading, setDbLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState(null);
  const [progressMsg, setProgressMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState(null);
  const progressTimer = useRef(null);

  const loadStatus = useCallback(() => {
    setDbLoading(true);
    getDatabaseStatus()
      .then(setDbStatus)
      .catch(() => toast.error('Failed to load database status'))
      .finally(() => setDbLoading(false));
  }, []);

  useEffect(() => {
    loadStatus();

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

    socket.on('database:progress', handleProgress);
    return () => {
      socket.off('database:progress', handleProgress);
      clearTimeout(progressTimer.current);
    };
  }, [loadStatus]);

  const runAction = useCallback((key, fn, successMsg) => {
    setConfirmAction(null);
    setActionInProgress(key);
    fn()
      .then((result) => {
        if (successMsg) toast.success(typeof successMsg === 'function' ? successMsg(result) : successMsg);
        loadStatus();
      })
      .catch(err => toast.error(err.message || 'Action failed'))
      .finally(() => setActionInProgress(null));
  }, [loadStatus]);

  const busy = actionInProgress != null;

  return (
    <div className="space-y-4">
      <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-5">
        {/* Connection summary */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={`w-2 h-2 rounded-full ${dbStatus?.connected ? 'bg-port-success' : 'bg-port-error'}`} />
            <span className="text-sm text-gray-300">
              {dbStatus?.connected ? 'Connected' : dbStatus ? 'Disconnected' : ''}
              {dbStatus?.memoryCount != null && ` \u2014 ${dbStatus.memoryCount.toLocaleString()} memories`}
              {dbStatus?.dbBytes != null && ` \u2014 ${formatBytes(dbStatus.dbBytes)}`}
              {dbStatus?.tableCount != null && ` (${dbStatus.tableCount} tables)`}
            </span>
          </div>
          <button
            onClick={loadStatus}
            disabled={dbLoading}
            className="p-1.5 text-gray-400 hover:text-white transition-colors"
            title="Refresh status"
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
