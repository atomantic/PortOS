import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Gamepad2, Play, Square, RotateCcw, FolderOpen, Terminal, Code, RefreshCw, Wrench, Archive, ArchiveRestore, Ticket, Download, Hammer, Smartphone, Trash2, AlertTriangle } from 'lucide-react';
import toast from '../components/ui/Toast';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import OverflowMenu from '../components/ui/OverflowMenu';
import AppIcon from '../components/AppIcon';
import PageSkeleton from '../components/ui/PageSkeleton';
import { SkeletonBlock, SkeletonRegion, skeletonRepeat } from '../components/ui/Skeleton';
import KanbanBoard from '../components/KanbanBoard';
import StatusBadge from '../components/StatusBadge';
import AppOperationBanner from '../components/apps/AppOperationBanner';
import { useAppOperation } from '../hooks/useAppOperation';
import useUrlParams from '../hooks/useUrlParams';
import * as api from '../services/api';
import socket from '../services/socket';
import { getLaunchUrls } from '../services/appUrls';
import { NON_PM2_TYPES, isStandardizable, getAppTypeLabel } from '../components/apps/constants';
import { formatBytes } from '../utils/formatters';

export default function Apps() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [actionLoading, setActionLoading] = useState({});
  const [nativeLaunchLoading, setNativeLaunchLoading] = useState({});
  const [refreshingConfig, setRefreshingConfig] = useState({});
  const [building, setBuilding] = useState({});
  const [archiving, setArchiving] = useState({});
  // The archived filter lives in the URL (`/apps?view=archived`) so the archived
  // list is linkable/bookmarkable and — critically — survivable: unarchiving the
  // last archived app used to strand the user on an empty card with no control
  // to get back (#3434).
  const [searchParams, updateParams] = useUrlParams();
  const showArchived = searchParams.get('view') === 'archived';
  const setShowArchived = (next) => updateParams({ view: next ? 'archived' : null });
  const [jiraTickets, setJiraTickets] = useState({});
  const [loadingTickets, setLoadingTickets] = useState({});
  // Parallel to jiraTickets: `undefined` tickets + a message here means "the
  // fetch failed", which is a different thing from a fetched empty sprint.
  const [ticketErrors, setTicketErrors] = useState({});
  // Per-row "…" trigger refs, so dismissing a row's delete confirmation hands
  // focus back to the control that opened it instead of dropping it on <body>.
  const menuTriggerRefs = useRef({});
  const menuTriggerRef = (id) => (menuTriggerRefs.current[id] ||= { current: null });
  // Per-app sprint-ticket request tracking: `{ generation, active }`.
  const ticketRequestsRef = useRef({});

  const fetchApps = useCallback(async () => {
    const data = await api.getApps().catch(() => []);
    setApps(data);
    setLoading(false);
  }, []);

  const { operations, isOperating, startUpdate, startStandardize, dismiss } = useAppOperation({ onComplete: fetchApps });

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

  const handleUpdate = (app) => startUpdate(app.id, app.name);

  const handleBuild = async (app) => {
    setBuilding(prev => ({ ...prev, [app.id]: true }));
    const result = await api.buildApp(app.id).catch(() => null);
    setBuilding(prev => ({ ...prev, [app.id]: false }));
    if (result?.success) {
      toast.success(`${app.name} production build complete`);
    }
  };

  const handleRefreshConfig = async (app) => {
    setRefreshingConfig(prev => ({ ...prev, [app.id]: true }));
    await api.refreshAppConfig(app.id).catch(() => null);
    setRefreshingConfig(prev => ({ ...prev, [app.id]: false }));
    fetchApps();
  };

  const handleStandardize = (app) => startStandardize(app.id, app.name);

  // Ticket state is keyed by app + JIRA target, not app id alone: editing an
  // app's instance or project key must not serve the previous project's cached
  // board (and must not be blocked from fetching by it).
  const sprintKey = (app) => `${app.id}:${app.jira?.instanceId}:${app.jira?.projectKey}`;

  // A failed fetch must NOT be cached as `[]` — that read as "you have no
  // sprint tickets" and, because the `!jiraTickets[id]` guard was satisfied by
  // the cached empty array, never retried for the life of the page (#3437).
  // Failure records a message and leaves `jiraTickets[id]` undefined, so both
  // Retry and a re-expand re-issue the request; a genuine `[]` is still cached.
  // Per-app request generation, so a slow earlier fetch can't land after a newer
  // one and overwrite a good board with its stale error (the pending-request
  // convention in client/src/AGENTS.md).
  const loadSprintTickets = useCallback(async (app) => {
    const key = sprintKey(app);
    const generation = (ticketRequestsRef.current[key]?.generation || 0) + 1;
    ticketRequestsRef.current[key] = { generation, active: true };
    const isCurrent = () => ticketRequestsRef.current[key]?.generation === generation;

    setLoadingTickets(prev => ({ ...prev, [key]: true }));
    setTicketErrors(prev => ({ ...prev, [key]: null }));
    const tickets = await api
      .getMySprintTickets(app.jira.instanceId, app.jira.projectKey, { silent: true })
      .catch(err => {
        if (isCurrent()) setTicketErrors(prev => ({ ...prev, [key]: err?.message || 'Request failed' }));
        return null;
      });
    if (!isCurrent()) return;   // superseded — the newer request owns the state
    ticketRequestsRef.current[key].active = false;
    if (Array.isArray(tickets)) setJiraTickets(prev => ({ ...prev, [key]: tickets }));
    setLoadingTickets(prev => ({ ...prev, [key]: false }));
  }, []);

  const toggleExpand = (id) => {
    const newExpandedId = expandedId === id ? null : id;
    setExpandedId(newExpandedId);

    // Fetch JIRA tickets when expanding an app with JIRA enabled
    if (!newExpandedId) return;
    const app = apps.find(a => a.id === newExpandedId);
    if (!app?.jira?.enabled || !app.jira.instanceId || !app.jira.projectKey) return;
    const key = sprintKey(app);
    if (!jiraTickets[key] && !ticketRequestsRef.current[key]?.active) loadSprintTickets(app);
  };

  // Archive/unarchive gate their success toast on a response, the way
  // handleBuild does: `request()` already toasted the failure, and a green
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
  const liveOperation = operations.find(op => !op.completed && !op.error);

  // Filter apps based on archive status
  const activeApps = apps.filter(app => !app.archived);
  const archivedApps = apps.filter(app => app.archived);
  const displayedApps = (showArchived ? archivedApps : activeApps)
    .slice().sort((a, b) => a.name.localeCompare(b.name));

  if (loading) {
    return <PageSkeleton label="Loading apps" titleWidthClass="w-24" showSubtitle cards={4} sidebar={false} />;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Apps</h2>
          <p className="text-gray-500 text-sm sm:text-base">Manage registered applications</p>
        </div>
        <div className="flex items-center gap-3">
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
        </div>
      </div>

      {/* In-flight update/standardize — page-level so it survives collapsing
          the row and remounting the page. */}
      {operations.length > 0 && (
      <div className="sticky top-0 z-20 mb-4 space-y-2">
      {operations.map(op => (
        <AppOperationBanner
          key={op.appId}
          appName={operationName(op)}
          type={op.type}
          steps={op.steps}
          error={op.error}
          completed={op.completed}
          onDismiss={op.error || op.completed ? () => dismiss(op.appId) : null}
        />
      ))}
      </div>
      )}

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
            // One update/standardize at a time. Rows that aren't the one
            // operating say so in the button label — a bare greyed control with
            // a tooltip explains nothing on touch.
            const rowOperation = operations.find(op => op.appId === app.id);
            const rowOperating = !!rowOperation && !rowOperation.completed && !rowOperation.error;
            const busyElsewhere = isOperating && !rowOperating;
            const busyReason = `${(liveOperation && operationName(liveOperation)) || 'Another app'} is ${liveOperation?.type === 'standardize' ? 'being standardized' : 'updating'}`;
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
                  {/* Expand + Name + Status */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <button
                      onClick={() => toggleExpand(app.id)}
                      className="text-gray-400 hover:text-white transition-transform shrink-0"
                      aria-expanded={expandedId === app.id}
                      aria-label={`${expandedId === app.id ? 'Collapse' : 'Expand'} ${app.name} details`}
                    >
                      <span aria-hidden="true" className={`inline-block transition-transform ${expandedId === app.id ? 'rotate-90' : ''}`}>▶</span>
                    </button>
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
                      <div className="text-xs text-gray-500 flex flex-wrap gap-x-2 mt-1">
                        {isNonPm2 ? (
                          <span className="text-gray-500">{app.repoPath}</span>
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

              {/* Expanded Details */}
              {expandedId === app.id && (
                <div className="bg-port-bg border-t border-port-border">
                  <div className="p-4 sm:px-6 sm:py-4 space-y-4">
                    {/* Details Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                      <div>
                        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Repository Path</div>
                        <div className="flex items-start gap-2">
                          <FolderOpen size={16} aria-hidden="true" className="text-yellow-400 shrink-0 mt-0.5" />
                          <code className="text-sm text-gray-300 font-mono break-all">{app.repoPath}</code>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Editor Command</div>
                        <div className="flex items-center gap-2">
                          <Code size={16} aria-hidden="true" className="text-port-accent shrink-0" />
                          <code className="text-sm text-gray-300 font-mono">{app.editorCommand || 'code .'}</code>
                        </div>
                      </div>
                    </div>

                    {/* Start Commands */}
                    {app.startCommands?.length > 0 && (
                      <div>
                        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Start Commands</div>
                        <div className="bg-port-card border border-port-border rounded-lg p-3">
                          {app.startCommands.map((cmd, i) => (
                            <div key={i} className="flex items-start gap-2 py-1">
                              <Terminal size={14} aria-hidden="true" className="text-port-success shrink-0 mt-0.5" />
                              <code className="text-sm text-port-accent/90 font-mono break-all">{cmd}</code>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* PM2 Processes Status - only for PM2 apps */}
                    {!isNonPm2 && app.pm2Status && Object.keys(app.pm2Status).length > 0 && (
                      <div>
                        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">PM2 Processes</div>
                        <div className="flex flex-wrap gap-2">
                          {Object.values(app.pm2Status).map((proc, i) => {
                            const processConfig = app.processes?.find(p => p.name === proc.name);
                            return (
                              <div
                                key={i}
                                className="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border rounded-lg"
                              >
                                <span className={`w-2 h-2 rounded-full shrink-0 ${
                                  proc.status === 'online' ? 'bg-port-success' :
                                  proc.status === 'stopped' ? 'bg-gray-500' :
                                  proc.status === 'unknown' ? 'bg-port-warning' : 'bg-port-error'
                                }`} />
                                <span className="text-sm text-white font-mono">{proc.name}</span>
                                {processConfig?.ports && Object.keys(processConfig.ports).length > 0 && (
                                  <span className="text-xs text-port-accent font-mono">
                                    {Object.entries(processConfig.ports).length > 1
                                      ? ` (${Object.entries(processConfig.ports).map(([label, port]) => `${label}:${port}`).join(', ')})`
                                      : `:${Object.values(processConfig.ports)[0]}`}
                                  </span>
                                )}
                                <span className="text-xs text-gray-500">{proc.status}</span>
                                {proc.cpu !== undefined && (
                                  <span className="text-xs text-port-success">{proc.cpu}%</span>
                                )}
                                {proc.memory !== undefined && (
                                  <span className="text-xs text-port-accent">{formatBytes(proc.memory)}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* JIRA Integration */}
                    {app.jira?.enabled && (
                      <div>
                        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">JIRA Integration</div>
                        <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-port-card border border-port-border rounded-lg">
                          <Ticket size={16} aria-hidden="true" className="text-port-accent shrink-0" />
                          <span className="text-sm text-white font-mono">{app.jira.projectKey || '—'}</span>
                          {app.jira.issueType && (
                            <span className="text-xs text-gray-400">{app.jira.issueType}</span>
                          )}
                          {app.jira.createPR !== false && (
                            <span className="text-xs text-port-success">+ PR</span>
                          )}
                          {app.jira.labels?.length > 0 && (
                            <span className="text-xs text-port-accent">{app.jira.labels.join(', ')}</span>
                          )}
                        </div>

                        {/* My Sprint Tickets - Kanban Board */}
                        {app.jira.instanceId && app.jira.projectKey && (
                          <div className="mt-3">
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">My Sprint Tickets</div>
                            {loadingTickets[sprintKey(app)] ? (
                              // Reserve the board's three columns instead of a
                              // one-line spinner (#4147) — the board is ~120px
                              // tall, so the spinner row let everything below
                              // the expansion jump when the tickets landed.
                              <SkeletonRegion
                                label={`Loading sprint tickets for ${app.name}`}
                                className="flex gap-3 overflow-x-auto pb-2"
                              >
                                {skeletonRepeat(3).map((_, col) => (
                                  <div
                                    key={col}
                                    className="flex-1 min-w-[220px] min-h-[120px] rounded-lg border border-port-border p-3"
                                  >
                                    <SkeletonBlock className="h-4 w-24 mb-3" />
                                    <div className="space-y-2">
                                      <SkeletonBlock className="h-10 w-full" />
                                      <SkeletonBlock className="h-10 w-full" />
                                    </div>
                                  </div>
                                ))}
                              </SkeletonRegion>
                            ) : ticketErrors[sprintKey(app)] ? (
                              <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-port-card border border-port-error/30 rounded-lg">
                                <AlertTriangle size={16} aria-hidden="true" className="text-port-error shrink-0" />
                                <span className="text-sm text-gray-300 min-w-0">
                                  Couldn&apos;t load sprint tickets — {ticketErrors[sprintKey(app)]}
                                </span>
                                <button
                                  onClick={() => loadSprintTickets(app)}
                                  className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1 focus:outline-hidden focus:ring-2 focus:ring-port-accent"
                                  aria-label={`Retry loading sprint tickets for ${app.name}`}
                                >
                                  <RefreshCw size={14} aria-hidden="true" /> Retry
                                </button>
                              </div>
                            ) : jiraTickets[sprintKey(app)]?.length > 0 ? (
                              <KanbanBoard
                                tickets={jiraTickets[sprintKey(app)]}
                                instanceId={app.jira.instanceId}
                                onTicketsChange={(updated) => setJiraTickets(prev => ({ ...prev, [sprintKey(app)]: updated }))}
                                appId={app.id}
                                projectKey={app.jira.projectKey}
                                boardId={app.jira.boardId}
                              />
                            ) : (
                              <div className="px-3 py-2 text-sm text-gray-500 bg-port-card border border-port-border rounded-lg">
                                No tickets assigned to you in the current sprint
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Quick Actions */}
                    <div className="flex flex-wrap gap-2 pt-2">
                      <button
                        onClick={() => api.openAppInEditor(app.id).catch(() => null)}
                        className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
                      >
                        <Code size={14} aria-hidden="true" /> Open in Editor
                      </button>
                      <button
                        onClick={() => api.openAppFolder(app.id).catch(() => null)}
                        className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
                      >
                        <FolderOpen size={14} aria-hidden="true" /> Open Folder
                      </button>
                      <button
                        onClick={() => handleUpdate(app)}
                        disabled={isOperating}
                        className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-success/20 text-port-success enabled:hover:bg-port-success/30 rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
                        aria-label={busyElsewhere ? `Update unavailable — ${busyReason}` : 'Pull latest code, install dependencies, run setup, and restart'}
                        title={busyElsewhere ? busyReason : undefined}
                      >
                        <Download size={14} aria-hidden="true" className={rowOperating && rowOperation.type === 'update' ? 'animate-bounce' : ''} />
                        {rowOperating && rowOperation.type === 'update'
                          ? 'Updating...'
                          : busyElsewhere ? 'Update (busy)' : 'Update'}
                      </button>
                      {app.buildCommand && (
                        <button
                          onClick={() => handleBuild(app)}
                          disabled={building[app.id]}
                          aria-busy={building[app.id]}
                          className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-warning/20 text-port-warning enabled:hover:bg-port-warning/30 transition-colors rounded-lg text-xs flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                          aria-label={`${building[app.id] ? 'Building' : 'Build'} production UI: ${app.buildCommand}`}
                        >
                          <Hammer size={14} aria-hidden="true" className={building[app.id] ? 'animate-bounce' : ''} />
                          {building[app.id] ? 'Building…' : 'Build'}
                        </button>
                      )}
                      {/* PM2-specific actions */}
                      {!isNonPm2 && (
                        <>
                          <button
                            onClick={() => handleRefreshConfig(app)}
                            disabled={refreshingConfig[app.id]}
                            className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
                            aria-label="Re-scan ecosystem config for PM2 processes and ports"
                          >
                            <RefreshCw size={14} aria-hidden="true" className={refreshingConfig[app.id] ? 'animate-spin' : ''} />
                            Refresh Config
                          </button>
                          {/* The standardizer writes a NODE ecosystem config —
                              never offer it for a Python/Go/Docker/static repo
                              (the server refuses too). */}
                          {isStandardizable(app.type) && (!app.processes?.length || app.processes.some(p => !p.ports || Object.keys(p.ports).length === 0)) && (
                            <button
                              onClick={() => handleStandardize(app)}
                              disabled={isOperating}
                              className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-accent/20 text-port-accent enabled:hover:bg-port-accent/30 rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
                              aria-label={busyElsewhere ? `Standardize PM2 unavailable — ${busyReason}` : 'Standardize PM2 config: move all ports to ecosystem.config.cjs'}
                              title={busyElsewhere ? busyReason : undefined}
                            >
                              <Wrench size={14} aria-hidden="true" className={rowOperating && rowOperation.type === 'standardize' ? 'animate-spin' : ''} />
                              {rowOperating && rowOperation.type === 'standardize'
                                ? 'Standardizing...'
                                : busyElsewhere ? 'Standardize PM2 (busy)' : 'Standardize PM2'}
                            </button>
                          )}
                        </>
                      )}
                      {/* Xcode-specific actions */}
                      {isNonPm2 && (
                        <button
                          onClick={() => api.openAppInXcode(app.id)
                            .then(result => { if (result?.success) toast.success(`Opening ${app.name} in Xcode`); })
                            .catch(() => null)}
                          className="px-3 py-1.5 min-h-[40px] sm:min-h-0 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded-lg text-xs flex items-center gap-1"
                          aria-label={`Open ${app.name} in Xcode`}
                        >
                          <Smartphone size={14} aria-hidden="true" /> Open in Xcode
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
          })}
        </div>
      )}

    </div>
  );
}
