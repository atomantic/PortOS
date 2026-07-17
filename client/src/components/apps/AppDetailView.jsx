import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Play, Square, RotateCcw, ExternalLink, Hammer, RefreshCw, Pencil, AlertTriangle, Sparkles } from 'lucide-react';
import DeployPanel from './DeployPanel';
import EditAppDrawer from './EditAppDrawer';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import StatusBadge from '../StatusBadge';
import * as api from '../../services/api';
import { getLaunchUrls } from '../../services/appUrls';
import socket from '../../services/socket';
import { APP_DETAIL_TABS, NON_PM2_TYPES, getAppTypeLabel } from './constants';
import OverviewTab from './tabs/OverviewTab';
import TasksTab from './tabs/TasksTab';
import AutomationTab from './tabs/AutomationTab';
import DocumentsTab from './tabs/DocumentsTab';
import GitTab from './tabs/GitTab';
import GsdTab from './tabs/GsdTab';
import ProcessesTab from './tabs/ProcessesTab';
import ReferencesTab from './tabs/ReferencesTab';
import DatadogTab from './tabs/DatadogTab';
import UpdateTab from './tabs/UpdateTab';

export default function AppDetailView() {
  const { appId, tab } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = tab || 'overview';

  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [buildLoading, setBuildLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  // Vite Dev-UI host guard: when an online app exposes a Vite dev server, check
  // whether its config allows the Tailscale/IP host PortOS is served under
  // (Vite ≥5 blocks unknown hosts). `null` = not yet checked.
  const [viteHostStatus, setViteHostStatus] = useState(null);
  const [viteFixing, setViteFixing] = useState(null); // 'allow-all' | 'ai' while a fix is in flight

  const fetchApp = useCallback(async () => {
    const data = await api.getApp(appId).catch(() => null);
    if (!data) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setApp(data);
    setLoading(false);
  }, [appId]);

  useEffect(() => {
    fetchApp();
  }, [fetchApp]);

  // Close the edit drawer when navigating to a different app so its stale
  // form state (initialized from the previous app) can't be saved against the
  // newly loaded app id. Keyed on appId only — a same-app socket refresh must
  // not interrupt an in-progress edit.
  useEffect(() => {
    setEditing(false);
  }, [appId]);

  // Deep-link into the Edit App drawer (e.g. the Layered Intelligence overview
  // links here with `?edit=1&appTab=intelligence` to open the Intelligence tab).
  // The `edit` trigger is consumed immediately so closing the drawer doesn't
  // re-open it; `appTab` is preserved for the drawer's own useDrawerTab to read.
  // Declared AFTER the appId-close effect so it wins on the same-commit mount.
  useEffect(() => {
    if (searchParams.get('edit') == null) return;
    setEditing(true);
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // Real-time updates
  useEffect(() => {
    const handleAppsChanged = () => fetchApp();
    socket.on('apps:changed', handleAppsChanged);
    return () => socket.off('apps:changed', handleAppsChanged);
  }, [fetchApp]);

  const handleStart = async () => {
    setActionLoading('start');
    await api.startApp(appId).catch(() => null);
    setActionLoading(null);
  };

  const handleStop = async () => {
    setActionLoading('stop');
    await api.stopApp(appId).catch(() => null);
    setActionLoading(null);
  };

  const handleRestart = async () => {
    setActionLoading('restart');
    const result = await api.restartApp(appId).catch(() => null);
    if (result?.selfRestart) {
      api.handleSelfRestart();
      return;
    }
    setActionLoading(null);
  };

  const handleBuild = async () => {
    setBuildLoading(true);
    const isSelfBuild = appId === api.PORTOS_APP_ID;
    const result = await api.buildApp(appId, { silent: true }).catch(err => {
      // Self-build may cause a socket hangup as the server restarts — that's expected
      if (isSelfBuild) return { selfBuildTriggered: true };
      toast.error(`Build failed: ${err.message}`);
      return null;
    });
    setBuildLoading(false);
    if (result?.success) {
      toast.success(`${app.name} production build complete`);
    } else if (result?.selfBuildTriggered) {
      toast.success(`${app.name} build triggered — server may restart`);
    }
  };

  // Re-check the Vite host guard whenever the app, its dev port, or its online
  // status changes. Skip the self-app (PortOS already allow-lists `.ts.net`).
  const devUiPort = app?.devUiPort;
  const isOnline = app?.overallStatus === 'online';
  useEffect(() => {
    if (!devUiPort || !isOnline || appId === api.PORTOS_APP_ID) {
      setViteHostStatus(null);
      return;
    }
    let cancelled = false;
    api.getAppViteHostStatus(appId, window.location.hostname)
      .then((status) => { if (!cancelled) setViteHostStatus(status); })
      .catch(() => { if (!cancelled) setViteHostStatus(null); });
    return () => { cancelled = true; };
  }, [appId, devUiPort, isOnline]);

  const handleFixViteHosts = async (mode) => {
    setViteFixing(mode);
    const result = await api.fixAppViteHosts(appId, { mode, host: window.location.hostname })
      .catch((err) => { toast.error(`Host fix failed: ${err.message}`); return null; });
    setViteFixing(null);
    if (!result) return;
    if (mode === 'ai') {
      toast.success(`AI remediation task queued for ${app.name} — review it in the CoS plan`);
      return;
    }
    toast.success(`${app.name}: ${result.filename} now allows this host — restart the dev server`);
    // Optimistically clear the warning; a restart picks up the change.
    setViteHostStatus((prev) => prev ? { ...prev, hostAllowed: true } : prev);
  };

  const visibleTabs = useMemo(() =>
    APP_DETAIL_TABS.filter(t => {
      if (t.id === 'update') return app?.id === api.PORTOS_APP_ID;
      if (t.id === 'datadog') return app?.datadog?.enabled;
      return true;
    }),
    [app?.id, app?.datadog?.enabled]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading app" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="p-6 text-center">
        <p className="text-lg text-gray-400 mb-4">App not found</p>
        <Link to="/apps" className="text-port-accent hover:underline">Back to Apps</Link>
      </div>
    );
  }

  const effectiveTab = visibleTabs.some(t => t.id === activeTab) ? activeTab : 'overview';

  const renderTab = () => {
    switch (effectiveTab) {
      case 'overview':
        return <OverviewTab app={app} onRefresh={fetchApp} />;
      case 'tasks':
        return <TasksTab appId={appId} />;
      case 'automation':
        return <AutomationTab appId={appId} appName={app.name} />;
      case 'datadog':
        return <DatadogTab app={app} />;
      case 'documents':
        return <DocumentsTab appId={appId} repoPath={app.repoPath} />;
      case 'git':
        return <GitTab appId={appId} appName={app.name} repoPath={app.repoPath} />;
      case 'gsd':
        return <GsdTab appId={appId} repoPath={app.repoPath} />;
      case 'processes':
        return <ProcessesTab pm2ProcessNames={app.pm2ProcessNames} />;
      case 'references':
        return <ReferencesTab appId={appId} appName={app.name} />;
      case 'update':
        if (app.id !== api.PORTOS_APP_ID) {
          return (
            <div className="p-6 text-center">
              <p className="text-lg text-gray-400 mb-4">Update is not available for this app</p>
              <Link to={`/apps/${appId}/overview`} className="text-port-accent hover:underline">Back to Overview</Link>
            </div>
          );
        }
        return <UpdateTab />;
      default:
        return <OverviewTab app={app} onRefresh={fetchApp} />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 sm:px-6 py-4 border-b border-port-border bg-port-card">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <Link to="/apps" className="text-gray-400 hover:text-white transition-colors self-start">
            <ArrowLeft size={20} />
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold text-white truncate">{app.name}</h1>
              {NON_PM2_TYPES.has(app.type) ? (
                <span className="px-1.5 py-0.5 bg-port-accent/20 text-port-accent text-xs rounded">
                  {getAppTypeLabel(app.type)}
                </span>
              ) : (
                <StatusBadge status={app.overallStatus || 'unknown'} size="sm" />
              )}
            </div>
            {app.pm2ProcessNames?.length > 0 && (
              <div className="text-xs text-gray-500 mt-1">
                {app.pm2ProcessNames.join(', ')}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Start/Stop/Restart - only for PM2 apps */}
            {!NON_PM2_TYPES.has(app.type) && (
            <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
              {app.overallStatus === 'online' ? (
                <>
                  <button
                    onClick={handleStop}
                    disabled={actionLoading}
                    className="px-2 py-1 bg-port-error/20 text-port-error enabled:hover:bg-port-error/30 transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    <Square size={14} />
                    <span className="text-xs">Stop</span>
                  </button>
                  <button
                    onClick={handleRestart}
                    disabled={actionLoading}
                    className="px-2 py-1 bg-port-warning/20 text-port-warning enabled:hover:bg-port-warning/30 transition-colors disabled:opacity-50 border-l border-port-border flex items-center gap-1"
                  >
                    <RotateCcw size={14} className={actionLoading === 'restart' ? 'animate-spin' : ''} />
                    <span className="text-xs">{actionLoading === 'restart' ? 'Restarting...' : 'Restart'}</span>
                  </button>
                </>
              ) : (app.degraded || app.overallStatus === 'unknown') ? (
                // PM2 read failed — don't offer a misleading Start; surface the
                // gap and let the user re-check. Mirrors the Apps list page.
                <button
                  onClick={fetchApp}
                  disabled={actionLoading}
                  className="px-2 py-1 bg-port-warning/20 text-port-warning enabled:hover:bg-port-warning/30 transition-colors disabled:opacity-50 flex items-center gap-1"
                  title="PM2 status could not be read — refresh to retry"
                >
                  <RefreshCw size={14} />
                  <span className="text-xs">Status unavailable</span>
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  disabled={actionLoading}
                  className="px-2 py-1 bg-port-success/20 text-port-success enabled:hover:bg-port-success/30 transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  <Play size={14} />
                  <span className="text-xs">{actionLoading === 'start' ? 'Starting...' : 'Start'}</span>
                </button>
              )}
            </div>
            )}
            {/* Launch buttons grouped together. When https is present, it's primary and http
                becomes a muted sibling. Self-app uses current origin to avoid scheme mismatch. */}
            {(() => {
              if (app.overallStatus !== 'online') return null;
              const { https, http, dev } = getLaunchUrls(app);
              const httpIsSecondary = Boolean(https);
              const launchButtons = [];
              if (https) {
                launchButtons.push(
                  <button
                    key="https"
                    onClick={() => window.open(https, '_blank')}
                    className="px-2 py-1 bg-port-accent/20 text-port-accent enabled:hover:bg-port-accent/30 transition-colors flex items-center gap-1"
                  >
                    <ExternalLink size={14} />
                    <span className="text-xs">Launch (HTTPS)</span>
                  </button>
                );
              }
              if (http) {
                launchButtons.push(
                  <button
                    key="http"
                    onClick={() => window.open(http, '_blank')}
                    className={`px-2 py-1 transition-colors flex items-center gap-1 ${
                      httpIsSecondary
                        ? 'bg-port-border/30 text-gray-300 enabled:hover:bg-port-border/50'
                        : 'bg-port-accent/20 text-port-accent enabled:hover:bg-port-accent/30'
                    }`}
                  >
                    <ExternalLink size={14} />
                    <span className="text-xs">{httpIsSecondary ? 'HTTP' : 'Launch'}</span>
                  </button>
                );
              }
              if (dev) {
                launchButtons.push(
                  <button
                    key="dev"
                    onClick={() => window.open(dev, '_blank')}
                    className="px-2 py-1 bg-port-warning/20 text-port-warning enabled:hover:bg-port-warning/30 transition-colors flex items-center gap-1"
                  >
                    <ExternalLink size={14} />
                    <span className="text-xs">Dev UI</span>
                  </button>
                );
              }
              if (launchButtons.length === 0) return null;
              return (
                <div className="inline-flex rounded-lg overflow-hidden border border-port-border divide-x divide-port-border">
                  {launchButtons}
                </div>
              );
            })()}
            {app.buildCommand && (
              <button
                onClick={handleBuild}
                disabled={buildLoading}
                className="px-2 py-1 bg-port-warning/20 text-port-warning enabled:hover:bg-port-warning/30 transition-colors rounded-lg border border-port-border flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={`Build production UI: ${app.buildCommand}`}
              >
                <Hammer size={14} className={buildLoading ? 'animate-bounce' : ''} />
                <span className="text-xs">{buildLoading ? 'Building...' : 'Build'}</span>
              </button>
            )}
            {app.hasDeployScript && (
              <DeployPanel appId={appId} appName={app.name} />
            )}
            <button
              onClick={() => setEditing(true)}
              className="px-2 py-1 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors rounded-lg border border-port-border flex items-center gap-1"
            >
              <Pencil size={14} />
              <span className="text-xs">Edit</span>
            </button>
          </div>
        </div>

        {/* Vite Dev-UI host guard — the app's dev server would block this host. */}
        {viteHostStatus && !viteHostStatus.hostAllowed && (
          <div className="mt-3 rounded-lg border border-port-warning/40 bg-port-warning/10 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="text-port-warning mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-port-warning font-medium">
                  Dev UI will be blocked on <span className="font-mono">{window.location.hostname}</span>
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {viteHostStatus.hasViteConfig
                    ? <>This app's Vite dev server ({viteHostStatus.filename}) doesn't allow this host, so opening the Dev UI shows a "Blocked request… not allowed" error.</>
                    : <>This app exposes a Vite dev server but no <span className="font-mono">vite.config</span> was found to allow this host, so the Dev UI will be blocked.</>}
                  {' '}It runs on a private Tailscale network — allowing all hosts is safe.
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {viteHostStatus.canAutoFix && (
                    <button
                      onClick={() => handleFixViteHosts('allow-all')}
                      disabled={Boolean(viteFixing)}
                      className="px-2 py-1 bg-port-accent/20 text-port-accent enabled:hover:bg-port-accent/30 transition-colors rounded flex items-center gap-1 disabled:opacity-50 text-xs"
                    >
                      {viteFixing === 'allow-all' ? 'Allowing…' : 'Allow all hosts (auto)'}
                    </button>
                  )}
                  <button
                    onClick={() => handleFixViteHosts('ai')}
                    disabled={Boolean(viteFixing)}
                    className="px-2 py-1 bg-port-border/40 text-gray-200 enabled:hover:bg-port-border/60 transition-colors rounded flex items-center gap-1 disabled:opacity-50 text-xs"
                  >
                    <Sparkles size={12} />
                    {viteFixing === 'ai' ? 'Queuing…' : 'Fix with AI'}
                  </button>
                </div>
                {!viteHostStatus.canAutoFix && viteHostStatus.hasViteConfig && (
                  <p className="text-[11px] text-gray-500 mt-1.5">
                    Auto-fix can't safely edit this config shape — use AI remediation.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab Bar */}
        <div className="flex gap-1 mt-4 -mb-4 overflow-x-auto">
          {visibleTabs.map(t => (
            <button
              key={t.id}
              onClick={() => navigate(`/apps/${appId}/${t.id}`)}
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                effectiveTab === t.id
                  ? 'border-port-accent text-port-accent'
                  : 'border-transparent text-gray-400 hover:text-white hover:border-gray-600'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        {renderTab()}
      </div>

      {editing && (
        <EditAppDrawer
          app={app}
          onClose={() => setEditing(false)}
          onSave={() => { setEditing(false); fetchApp(); }}
        />
      )}
    </div>
  );
}
