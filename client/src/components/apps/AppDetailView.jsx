import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Square, RotateCcw, ExternalLink, Hammer } from 'lucide-react';
import DeployPanel from './DeployPanel';
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
import UpdateTab from './tabs/UpdateTab';

export default function AppDetailView() {
  const { appId, tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'overview';

  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [buildLoading, setBuildLoading] = useState(false);

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
    const result = await api.buildApp(appId).catch(err => {
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

  const visibleTabs = useMemo(() =>
    APP_DETAIL_TABS.filter(t => t.id !== 'update' || app?.id === api.PORTOS_APP_ID),
    [app?.id]
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

  const renderTab = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab app={app} onRefresh={fetchApp} />;
      case 'tasks':
        return <TasksTab appId={appId} />;
      case 'automation':
        return <AutomationTab appId={appId} appName={app.name} />;
      case 'documents':
        return <DocumentsTab appId={appId} repoPath={app.repoPath} />;
      case 'git':
        return <GitTab appId={appId} appName={app.name} repoPath={app.repoPath} />;
      case 'gsd':
        return <GsdTab appId={appId} repoPath={app.repoPath} />;
      case 'processes':
        return <ProcessesTab pm2ProcessNames={app.pm2ProcessNames} />;
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
          </div>
        </div>

        {/* Tab Bar */}
        <div className="flex gap-1 mt-4 -mb-4 overflow-x-auto">
          {visibleTabs.map(t => (
            <button
              key={t.id}
              onClick={() => navigate(`/apps/${appId}/${t.id}`)}
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === t.id
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
    </div>
  );
}
