import AppQuality from '../components/apps/AppQuality';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Gamepad2, Play, Square, RotateCcw, RefreshCw, Archive, ArchiveRestore, Trash2, AlertTriangle } from 'lucide-react';
import toast from '../components/ui/Toast';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import OverflowMenu from '../components/ui/OverflowMenu';
import AppIcon from '../components/AppIcon';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import StatusBadge from '../components/StatusBadge';
import AppOperationBanner from '../components/apps/AppOperationBanner';
import { useAppOperation } from '../hooks/useAppOperation';
import useUrlParams from '../hooks/useUrlParams';
import * as api from '../services/api';
import socket from '../services/socket';
import { getLaunchUrls } from '../services/appUrls';
import { NON_PM2_TYPES, getAppTypeLabel } from '../components/apps/constants';

export default function Apps() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [actionLoading, setActionLoading] = useState({});
  const [nativeLaunchLoading, setNativeLaunchLoading] = useState({});
  const [archiving, setArchiving] = useState({});
  // The archived filter lives in the URL (`/apps?view=archived`) so the archived
  // list is linkable/bookmarkable and — critically — survivable: unarchiving the
  // last archived app used to strand the user on an empty card with no control
  // to get back (#3434).
  const [searchParams, updateParams] = useUrlParams();
  const showArchived = searchParams.get('view') === 'archived';
  const setShowArchived = (next) => updateParams({ view: next ? 'archived' : null });
  // Per-row "…" trigger refs, so dismissing a row's delete confirmation hands
  // focus back to the control that opened it instead of dropping it on <body>.
  const menuTriggerRefs = useRef({});
  const menuTriggerRef = (id) => (menuTriggerRefs.current[id] ||= { current: null });
  const fetchSeqRef = useRef(0);

  const fetchApps = useCallback(async ({ retry = false } = {}) => {
    const seq = ++fetchSeqRef.current;
    if (retry) {
      setRetrying(true);
      setLoading(true);
    }
    const result = await api.getApps({ includeQuality: true, silent: true })
      .then(data => ({ data }))
      .catch(error => ({ error }));
    if (seq !== fetchSeqRef.current) return false;
    if (result.error) {
      setLoadError(result.error);
      setRetrying(false);
      setLoading(false);
      return false;
    }
    setApps(Array.isArray(result.data) ? result.data : []);
    setLoadError(null);
    setRetrying(false);
    setLoading(false);
    return true;
  }, []);

  const { operations, restarting, dismiss } = useAppOperation({ onComplete: fetchApps });

  useEffect(() => {
    fetchApps();

    // Listen for apps changes via WebSocket instead of polling
    const handleAppsChanged = () => {
      fetchApps();
    };
    socket.on('apps:changed', handleAppsChanged);

    return () => {
      socket.off('apps:changed', handleAppsChanged);
    };
  }, [fetchApps]);

  const handleDelete = async (app) => {
    const removed = await api.deleteApp(app.id).then(() => true, () => false);
    if (!removed) return;
    setConfirmingDelete(null);
    setApps(prev => prev.filter(candidate => candidate.id !== app.id));
    toast.success(`${app.name} removed from PortOS — files kept on disk`);
  };

  const handleStart = async (app) => {
    setActionLoading(prev => ({ ...prev, [app.id]: 'start' }));
    await api.startApp(app.id).catch(() => null);
    setActionLoading(prev => ({ ...prev, [app.id]: null }));
  };

  const handleStop = async (app) => {
    setActionLoading(prev => ({ ...prev, [app.id]: 'stop' }));
    await api.stopApp(app.id).catch(() => null);
    setActionLoading(prev => ({ ...prev, [app.id]: null }));
  };

  const handleRestart = async (app) => {
    setActionLoading(prev => ({ ...prev, [app.id]: 'restart' }));
    const result = await api.restartApp(app.id).catch(() => null);
    if (result?.selfRestart) {
      api.handleSelfRestart();
      return;
    }
    setActionLoading(prev => ({ ...prev, [app.id]: null }));
  };

  const handleNativeLaunch = async (app) => {
    setNativeLaunchLoading(prev => ({ ...prev, [app.id]: true }));
    const result = await api.launchNativeApp(app.id).catch(() => null);
    setNativeLaunchLoading(prev => ({ ...prev, [app.id]: false }));
    if (result?.success) toast.success(`${app.nativeLaunch.label} is running`);
  };

  const handleWebLaunch = (url) => {
    if (url) window.open(url, '_blank');
  };

  // Archive/unarchive gate their success toast on a response, the way
  // other action handlers do: `request()` already toasted the failure, and a green
  // "archived" on top of it told the user an app was excluded from CoS
  // scheduling when it was not (#3436).
  const setArchived = async (app, archived) => {
    setArchiving(prev => ({ ...prev, [app.id]: true }));
    const result = await (archived ? api.archiveApp(app.id) : api.unarchiveApp(app.id)).catch(() => null);
    setArchiving(prev => ({ ...prev, [app.id]: false }));
    if (!result) return;
    setApps(prev => prev.map(a => (a.id === app.id ? { ...a, archived } : a)));
    toast.success(archived
      ? `${app.name} archived — excluded from CoS tasks`
      : `${app.name} unarchived — included in CoS tasks`);
  };

  const handleArchive = (app) => setArchived(app, true);

  const handleUnarchive = (app) => setArchived(app, false);

  // The server names the app it is operating on (so a rehydrated operation is
  // labelled even before the list loads); fall back to the loaded list.
  const operationName = (op) => op.appName || apps.find(app => app.id === op.appId)?.name;
  // Filter apps based on archive status
  const activeApps = apps.filter(app => !app.archived);
  const archivedApps = apps.filter(app => app.archived);
  const displayedApps = (showArchived ? archivedApps : activeApps)
    .slice().sort((a, b) => a.name.localeCompare(b.name));
  const operationBanners = operations.length > 0 ? (
    <div className="sticky top-0 z-20 mb-4 space-y-2">
      {operations.map(op => (
        <AppOperationBanner
          key={op.appId}
          appName={operationName(op)}
          type={op.type}
          steps={op.steps}
          error={op.error}
          completed={op.completed}
          restarting={restarting && op.appId === api.PORTOS_APP_ID}
          onDismiss={op.error || op.completed ? () => dismiss(op.appId) : null}
        />
      ))}
    </div>
  ) : null;

  if (loading) {
    return <PageSkeleton label="Loading apps" titleWidthClass="w-24" showSubtitle cards={4} sidebar={false} />;
  }

  if (loadError && apps.length === 0) {
    return (
      <div className="p-4 md:p-6">
        {operationBanners}
        <div role="alert" className="mx-auto max-w-2xl rounded-xl border border-port-error/40 bg-port-card p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-port-error" />
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-white">Apps unavailable</h1>
              <p className="mt-2 text-sm text-gray-400">
                The registered app collection could not be loaded. {loadError.message || 'Check the connection and try again.'}
              </p>
              <button
                onClick={() => fetchApps({ retry: true })}
                disabled={retrying}
                aria-busy={retrying}
                className="mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm text-white hover:bg-port-accent/80 disabled:opacity-50"
              >
                <RefreshCw size={16} aria-hidden="true" className={retrying ? 'animate-spin' : ''} />
                {retrying ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Apps"
        subtitle="Manage registered applications"
        className="mb-6"
        actions={(
          <>
            {/* Archive Toggle — stays mounted while the archived view is open even
                once it empties, so the way back never disappears. */}
            {(showArchived || archivedApps.length > 0) && (
              <button
                onClick={() => setShowArchived(!showArchived)}
                className={`px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors ${
                  showArchived
                    ? 'bg-port-warning/20 text-port-warning border border-port-warning/30'
                    : 'bg-port-border text-gray-400 hover:text-white'
                }`}
              >
                <Archive size={16} />
                {showArchived ? `Active (${activeApps.length})` : `Archived (${archivedApps.length})`}
              </button>
            )}
            <Link
              to="/apps/create"
              className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors text-center"
            >
              + Add
            </Link>
          </>
        )}
      />

      {loadError && (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-port-warning/40 bg-port-warning/10 p-3 text-sm">
          <AlertTriangle size={16} aria-hidden="true" className="shrink-0 text-port-warning" />
          <span className="min-w-0 flex-1 text-gray-300">
            Apps are unavailable — showing the last loaded collection. {loadError.message || 'Retry when the connection recovers.'}
          </span>
          <button
            onClick={() => fetchApps({ retry: true })}
            disabled={retrying}
            aria-busy={retrying}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-port-border px-3 py-1.5 text-xs text-white hover:bg-port-border/80 disabled:opacity-50"
          >
            <RefreshCw size={14} aria-hidden="true" className={retrying ? 'animate-spin' : ''} />
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {/* In-flight update/standardize — page-level so it survives collapsing
          the row and remounting the page. */}
      {operationBanners}

      {/* App List */}
      {displayedApps.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-xl p-12 text-center">
          <div className="text-4xl mb-4">{showArchived ? '📦' : '🗂️'}</div>
          <h3 className="text-xl font-semibold text-white mb-2">
            {showArchived ? 'No archived apps' : 'No apps registered'}
          </h3>
          <p className="text-gray-500 mb-6">
            {showArchived ? 'Archived apps will appear here' : 'Register your first app to monitor its health, restart it, and surface it on your dashboard.'}
          </p>
          {showArchived ? (
            <button
              onClick={() => setShowArchived(false)}
              className="inline-block px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
            >
              Back to active apps
            </button>
          ) : (
            <Link
              to="/apps/create"
              className="inline-block px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
            >
              Add App
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {displayedApps.map(app => {
            const isNonPm2 = NON_PM2_TYPES.has(app.type);
            const launchUrls = getLaunchUrls(app);
            const primaryLaunchUrl = launchUrls.https || launchUrls.http;
            return (
            <div
              key={app.id}
              className="bg-port-card border border-port-border rounded-xl overflow-hidden"
            >
              {/* Main App Row */}
              <div className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  {/* Identity + Status */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className={`w-8 h-8 rounded-[22%] shrink-0 overflow-hidden ${
                      app.appIconPath ? '' : `flex items-center justify-center ${app.archived ? 'bg-port-border/50 text-gray-500' : 'bg-port-border text-port-accent'}`
                    }`}>
                      <AppIcon icon={app.icon || 'package'} appId={app.id} hasAppIcon={!!app.appIconPath} size={18} fillContainer />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to={`/apps/${app.id}`}
                          className={`font-medium underline decoration-dotted underline-offset-4 hover:decoration-solid transition-colors ${
                            app.archived
                              ? 'text-gray-400 decoration-gray-600 hover:text-gray-200'
                              : 'text-port-accent decoration-port-accent/50 hover:text-white'
                          }`}
                        >
                          {app.name}
                        </Link>
                        {app.archived && (
                          <span className="px-1.5 py-0.5 bg-port-warning/20 text-port-warning text-xs rounded">
                            Archived
                          </span>
                        )}
                        {isNonPm2 ? (
                          <span className="px-1.5 py-0.5 bg-port-accent/20 text-port-accent text-xs rounded">
                            {getAppTypeLabel(app.type)}
                          </span>
                        ) : (
                          <StatusBadge status={app.overallStatus} size="sm" />
                        )}
                      </div>
                      <AppQuality app={app} />
                      <div className="text-xs text-gray-500 flex flex-wrap gap-x-2 mt-1">
                        {isNonPm2 ? (
                          <span className="break-all">{app.repoPath}</span>
                        ) : (
                          (app.pm2ProcessNames || []).map((procName, i) => {
                            const procInfo = app.processes?.find(p => p.name === procName);
                            const ports = procInfo?.ports || {};
                            const portEntries = Object.entries(ports);
                            const portDisplay = portEntries.length > 1
                              ? ` (${portEntries.map(([label, port]) => `${label}:${port}`).join(', ')})`
                              : portEntries.length === 1
                                ? `:${portEntries[0][1]}`
                                : '';
                            return (
                              <span key={i}>
                                {procName}<span className="text-port-accent">{portDisplay}</span>
                                {i < (app.pm2ProcessNames?.length || 0) - 1 ? ',' : ''}
                              </span>
                            );
                          })
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Controls */}
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Start/Stop/Restart Button Group - only for PM2 apps */}
                    {!isNonPm2 && (
                    <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
                      {app.overallStatus === 'online' ? (
                        <>
                          <button
                            onClick={() => handleStop(app)}
                            disabled={actionLoading[app.id]}
                            className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-error/20 text-port-error enabled:hover:bg-port-error/30 transition-colors disabled:opacity-50 flex items-center gap-1 focus:outline-hidden focus:ring-2 focus:ring-port-error"
                            aria-label={`Stop ${app.name}`}
                            aria-busy={actionLoading[app.id] === 'stop'}
                          >
                            <Square size={14} aria-hidden="true" />
                            <span className="text-xs">{actionLoading[app.id] === 'stop' ? 'Stopping...' : 'Stop'}</span>
                          </button>
                          <button
                            onClick={() => handleRestart(app)}
                            disabled={actionLoading[app.id]}
                            className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-warning/20 text-port-warning enabled:hover:bg-port-warning/30 transition-colors disabled:opacity-50 border-l border-port-border flex items-center gap-1 focus:outline-hidden focus:ring-2 focus:ring-port-warning"
                            aria-label={`Restart ${app.name}`}
                            aria-busy={actionLoading[app.id] === 'restart'}
                          >
                            <RotateCcw size={14} aria-hidden="true" className={actionLoading[app.id] === 'restart' ? 'animate-spin' : ''} />
                            <span className="text-xs">{actionLoading[app.id] === 'restart' ? 'Restarting...' : 'Restart'}</span>
                          </button>
                        </>
                      ) : (app.degraded || app.overallStatus === 'unknown') ? (
                        // PM2 read failed — status is genuinely unknown, so don't
                        // offer a misleading Start. Surface "Status unavailable"
                        // and let the user re-check rather than act on bad info.
                        <button
                          onClick={() => fetchApps()}
                          disabled={actionLoading[app.id]}
                          className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-warning/20 text-port-warning enabled:hover:bg-port-warning/30 transition-colors disabled:opacity-50 flex items-center gap-1 focus:outline-hidden focus:ring-2 focus:ring-port-warning"
                          aria-label={`${app.name} status unavailable — refresh`}
                          title="PM2 status could not be read — refresh to retry"
                        >
                          <RefreshCw size={14} aria-hidden="true" />
                          <span className="text-xs">Status unavailable</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStart(app)}
                          disabled={actionLoading[app.id]}
                          className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-success/20 text-port-success enabled:hover:bg-port-success/30 transition-colors disabled:opacity-50 flex items-center gap-1 focus:outline-hidden focus:ring-2 focus:ring-port-success"
                          aria-label={`Start ${app.name}`}
                          aria-busy={actionLoading[app.id] === 'start'}
                        >
                          <Play size={14} aria-hidden="true" />
                          <span className="text-xs">{actionLoading[app.id] === 'start' ? 'Starting...' : 'Start'}</span>
                        </button>
                      )}
                    </div>
                    )}

                    {/* Launch buttons grouped together */}
                    {(app.nativeLaunch || (app.overallStatus === 'online' && (primaryLaunchUrl || launchUrls.dev))) && (
                      <div className="inline-flex rounded-lg overflow-hidden border border-port-border divide-x divide-port-border">
                        {app.overallStatus === 'online' && primaryLaunchUrl && (
                          <button
                            onClick={() => handleWebLaunch(primaryLaunchUrl)}
                            className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-accent/20 text-port-accent enabled:hover:bg-port-accent/30 transition-colors flex items-center gap-1"
                            aria-label={`Launch ${app.name} UI`}
                          >
                            <ExternalLink size={14} aria-hidden="true" />
                            <span className="text-xs">Launch</span>
                          </button>
                        )}
                        {app.overallStatus === 'online' && launchUrls.dev && (
                          <button
                            onClick={() => handleWebLaunch(launchUrls.dev)}
                            className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-warning/20 text-port-warning enabled:hover:bg-port-warning/30 transition-colors flex items-center gap-1"
                            aria-label={`Launch ${app.name} Dev UI`}
                          >
                            <ExternalLink size={14} aria-hidden="true" />
                            <span className="text-xs">Dev UI</span>
                          </button>
                        )}
                        {app.nativeLaunch && (
                          <button
                            onClick={() => handleNativeLaunch(app)}
                            disabled={nativeLaunchLoading[app.id]}
                            className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-success/20 text-port-success enabled:hover:bg-port-success/30 transition-colors flex items-center gap-1 disabled:opacity-50"
                            aria-label={`Launch ${app.nativeLaunch.label} for ${app.name}`}
                            aria-busy={nativeLaunchLoading[app.id]}
                          >
                            <Gamepad2 size={14} aria-hidden="true" />
                            <span className="text-xs">
                              {nativeLaunchLoading[app.id] ? 'Launching…' : app.nativeLaunch.label}
                            </span>
                          </button>
                        )}
                      </div>
                    )}

                    {/* Manage is the row's single primary action; the rare and
                        destructive ones (Archive/Remove) live behind the "…"
                        menu so removal isn't the loudest control on the card. */}
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/apps/${app.id}/overview`}
                        className="px-4 py-1.5 min-h-[40px] sm:min-h-0 inline-flex items-center rounded-lg bg-port-accent text-white hover:bg-port-accent/80 transition-colors text-xs font-medium focus:outline-hidden focus:ring-2 focus:ring-port-accent"
                        aria-label={`Manage ${app.name}`}
                      >
                        Manage
                      </Link>
                      {/* Archive + Remove are withheld for the PortOS baseline app */}
                      {app.id !== api.PORTOS_APP_ID && (
                        <OverflowMenu
                          label={`More actions for ${app.name}`}
                          triggerRef={menuTriggerRef(app.id)}
                          items={[
                            {
                              id: 'archive',
                              label: archiving[app.id] ? 'Working…' : app.archived ? 'Unarchive' : 'Archive',
                              icon: app.archived ? ArchiveRestore : Archive,
                              disabled: !!archiving[app.id],
                              onSelect: () => (app.archived ? handleUnarchive(app) : handleArchive(app)),
                            },
                            {
                              id: 'remove',
                              label: 'Remove from PortOS',
                              icon: Trash2,
                              tone: 'danger',
                              onSelect: () => setConfirmingDelete(app.id),
                            },
                          ]}
                        />
                      )}
                    </div>
                  </div>
                </div>

                {confirmingDelete === app.id && (
                  <InlineConfirmRow
                    className="mt-3"
                    autoFocus
                    question={`Remove ${app.name} from PortOS? Its repository will stay on disk.`}
                    confirmText="Remove"
                    cancelText="Keep"
                    aria-label={`Confirm removal of ${app.name} from PortOS`}
                    onConfirm={() => handleDelete(app)}
                    onCancel={() => {
                      setConfirmingDelete(null);
                      menuTriggerRef(app.id).current?.focus();
                    }}
                  />
                )}
              </div>

            </div>
          );
          })}
        </div>
      )}

    </div>
  );
}
