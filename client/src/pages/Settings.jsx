import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, Plus, X, Eye, EyeOff, Trash2, Send, Container, HardDrive, Download, ArrowRightLeft, Wrench, RefreshCw, Square, RotateCw, Play } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../components/BrailleSpinner';
import { formatBytes } from '../utils/formatters';
import {
  getSettings, updateSettings, getTelegramStatus, updateTelegramConfig,
  deleteTelegramConfig, testTelegram, updateTelegramForwardTypes,
  getDatabaseStatus, switchDatabase, setupNativeDatabase, exportDatabase, fixDatabase,
  syncDatabase, startDatabase, stopDatabase, destroyDatabase
} from '../services/api';
import socket from '../services/socket';

const NOTIFICATION_TYPES = [
  { key: 'memory_approval', label: 'Memory Approvals' },
  { key: 'task_approval', label: 'Task Approvals' },
  { key: 'code_review', label: 'Code Reviews' },
  { key: 'health_issue', label: 'Health Issues' },
  { key: 'briefing_ready', label: 'Briefings' },
  { key: 'autobiography_prompt', label: 'Autobiography Prompts' },
  { key: 'plan_question', label: 'Plan Questions' }
];

function BackupTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [destPath, setDestPath] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [cronExpression, setCronExpression] = useState('0 2 * * *');
  const [excludePaths, setExcludePaths] = useState([]);
  const [newExclude, setNewExclude] = useState('');

  useEffect(() => {
    getSettings()
      .then(settings => {
        const backup = settings?.backup || {};
        setDestPath(backup.destPath || '');
        setEnabled(backup.enabled ?? false);
        setCronExpression(backup.cronExpression || '0 2 * * *');
        setExcludePaths(backup.excludePaths || []);
      })
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    await updateSettings({ backup: { destPath, enabled, cronExpression, excludePaths } })
      .then(() => toast.success('Settings saved'))
      .catch(() => toast.error('Failed to save settings'))
      .finally(() => setSaving(false));
  };

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

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-5">
      <div className="space-y-1">
        <label className="block text-sm text-gray-400">Destination Path</label>
        <input
          type="text"
          value={destPath}
          onChange={e => setDestPath(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
          placeholder="/path/to/backups"
        />
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-400">Enabled</label>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? 'bg-port-accent' : 'bg-port-border'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      <div className="space-y-1">
        <label className="block text-sm text-gray-400">Schedule (cron)</label>
        <input
          type="text"
          value={cronExpression}
          onChange={e => setCronExpression(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
          placeholder="0 2 * * *"
        />
        <p className="text-xs text-gray-500">Default: 2:00 AM daily</p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm text-gray-400">Exclude Paths</label>
        <p className="text-xs text-gray-500">Directories/patterns to skip during backup (relative to data/)</p>
        <div className="flex gap-2">
          <input
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
            className="px-3 py-2 bg-port-border hover:bg-port-border/70 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <Plus size={16} />
          </button>
        </div>
        {excludePaths.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {excludePaths.map((path, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-port-bg border border-port-border rounded-lg text-sm text-gray-300">
                <code className="text-xs">{path}</code>
                <button onClick={() => removeExclude(i)} className="text-gray-500 hover:text-port-error transition-colors">
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
      >
        {saving ? <BrailleSpinner /> : <Save size={16} />}
        Save
      </button>
    </div>
  );
}

function BackendCard({ label, icon: Icon, backend, isActive, dbStatus, runAction, setConfirmAction, actionInProgress, busy, exportDatabase }) {
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
            onClick={() => runAction(`export-${backend}`, () => exportDatabase(backend), (r) => `Backed up to ${r.dumpFile}`)}
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

function DatabaseTab() {
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
      .catch(() => {})
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

function TelegramTab() {
  const [loading, setLoading] = useState(true);
  const [tgToken, setTgToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [tgShowToken, setTgShowToken] = useState(false);
  const [tgStatus, setTgStatus] = useState(null);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgTesting, setTgTesting] = useState(false);
  const [tgDisconnecting, setTgDisconnecting] = useState(false);
  const [tgForwardTypes, setTgForwardTypes] = useState([]);

  useEffect(() => {
    Promise.all([
      getSettings(),
      getTelegramStatus().catch(() => null)
    ]).then(([settings, status]) => {
      if (status) {
        setTgStatus(status);
        setTgChatId(settings?.telegram?.chatId || '');
        setTgForwardTypes(status.forwardTypes || []);
      }
    }).catch(() => toast.error('Failed to load Telegram settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleTelegramSave = () => {
    if (!tgToken && !tgStatus?.hasToken) {
      toast.error('Bot token is required');
      return;
    }
    setTgSaving(true);
    updateTelegramConfig({ token: tgToken, chatId: tgChatId })
      .then(status => {
        setTgStatus(status);
        toast.success(tgChatId
          ? 'Telegram connected — check your chat for a test message'
          : 'Bot connected — now message your bot /start to get your Chat ID');
      })
      .catch(() => toast.error('Failed to configure Telegram'))
      .finally(() => setTgSaving(false));
  };

  const handleTelegramTest = () => {
    setTgTesting(true);
    testTelegram()
      .then(() => toast.success('Test message sent'))
      .catch(() => toast.error('Failed to send test message'))
      .finally(() => setTgTesting(false));
  };

  const handleTelegramDisconnect = () => {
    setTgDisconnecting(true);
    deleteTelegramConfig()
      .then(() => {
        setTgStatus(null);
        setTgToken('');
        setTgChatId('');
        setTgForwardTypes([]);
        toast.success('Telegram disconnected');
      })
      .catch(() => toast.error('Failed to disconnect'))
      .finally(() => setTgDisconnecting(false));
  };

  const toggleForwardType = (type) => {
    const updated = tgForwardTypes.includes(type)
      ? tgForwardTypes.filter(t => t !== type)
      : [...tgForwardTypes, type];
    setTgForwardTypes(updated);
    updateTelegramForwardTypes(updated).catch(() => toast.error('Failed to update forward types'));
  };

  if (loading) {
    return <BrailleSpinner text="Loading Telegram settings" />;
  }

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          {tgStatus?.connected && (
            <span className="flex items-center gap-2 text-port-success">
              <span className="w-2 h-2 rounded-full bg-port-success" />
              @{tgStatus.botUsername}
            </span>
          )}
          {tgStatus && !tgStatus.connected && tgStatus.hasToken && (
            <span className="flex items-center gap-2 text-port-error">
              <span className="w-2 h-2 rounded-full bg-port-error" />
              Disconnected
            </span>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <label className="block text-sm text-gray-400">Bot Token</label>
        <div className="flex gap-2">
          <input
            type={tgShowToken ? 'text' : 'password'}
            value={tgToken}
            onChange={e => setTgToken(e.target.value)}
            className="flex-1 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
            placeholder={tgStatus?.hasToken ? '••••••••••• (configured)' : 'Paste bot token from @BotFather'}
          />
          <button
            onClick={() => setTgShowToken(!tgShowToken)}
            className="px-3 py-2 bg-port-border hover:bg-port-border/70 text-white rounded-lg transition-colors"
          >
            {tgShowToken ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </div>

      <div className="space-y-1">
        <label className="block text-sm text-gray-400">Chat ID</label>
        <input
          type="text"
          value={tgChatId}
          onChange={e => setTgChatId(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
          placeholder="Message your bot /start to get your chat ID"
        />
      </div>

      <p className="text-xs text-gray-500">
        1. Message <code>@BotFather</code> on Telegram, send <code>/newbot</code>, copy the token, paste above, click Save.
        2. Message your bot <code>/start</code> — it will reply with your Chat ID.
        3. Paste the Chat ID above and click Save & Test.
      </p>

      <div className="flex items-center gap-3">
        <button
          onClick={handleTelegramSave}
          disabled={tgSaving || (!tgToken && !tgStatus?.hasToken)}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
        >
          {tgSaving ? <BrailleSpinner /> : <Save size={16} />}
          {tgStatus?.connected && tgChatId ? 'Save & Test' : 'Save'}
        </button>
        {tgStatus?.connected && (
          <button
            onClick={handleTelegramTest}
            disabled={tgTesting}
            className="flex items-center gap-2 px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {tgTesting ? <BrailleSpinner /> : <Send size={16} />}
            Send Test
          </button>
        )}
        {(tgStatus?.hasToken || tgStatus?.hasChatId) && (
          <button
            onClick={handleTelegramDisconnect}
            disabled={tgDisconnecting}
            className="flex items-center gap-2 px-4 py-2 bg-port-error/20 hover:bg-port-error/30 text-port-error text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {tgDisconnecting ? <BrailleSpinner /> : <Trash2 size={16} />}
            Disconnect
          </button>
        )}
      </div>

      {tgStatus?.connected && (
        <div className="space-y-2 pt-2 border-t border-port-border">
          <label className="block text-sm text-gray-400">Forward Notification Types</label>
          <p className="text-xs text-gray-500">When all are unchecked, all types are forwarded</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {NOTIFICATION_TYPES.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tgForwardTypes.includes(key)}
                  onChange={() => toggleForwardType(key)}
                  className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const TABS = [
  { id: 'backup', label: 'Backup' },
  { id: 'database', label: 'Database' },
  { id: 'telegram', label: 'Telegram' }
];

export default function Settings() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'backup';

  const handleTabChange = (tabId) => {
    navigate(`/settings/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'backup': return <BackupTab />;
      case 'database': return <DatabaseTab />;
      case 'telegram': return <TelegramTab />;
      default: return <BackupTab />;
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Settings</h1>

      <div className="flex gap-1 border-b border-port-border">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => handleTabChange(id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === id
                ? 'text-port-accent border-port-accent'
                : 'text-gray-400 border-transparent hover:text-white hover:border-port-border'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {renderTabContent()}
    </div>
  );
}
