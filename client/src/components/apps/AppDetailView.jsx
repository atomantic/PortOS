import { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Square, RotateCcw, ExternalLink, Hammer } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../BrailleSpinner';
import StatusBadge from '../StatusBadge';
import * as api from '../../services/api';
import socket from '../../services/socket';
import { APP_DETAIL_TABS } from './constants';
import OverviewTab from './tabs/OverviewTab';
import TasksTab from './tabs/TasksTab';
import AutomationTab from './tabs/AutomationTab';
import DocumentsTab from './tabs/DocumentsTab';
import GitTab from './tabs/GitTab';
import GsdTab from './tabs/GsdTab';

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
    const result = await api.buildApp(appId).catch(() => null);
    setBuildLoading(false);
    if (result?.success) {
      toast.success(`${app.name} production build complete`);
    }
  };

  const visibleTabs = APP_DETAIL_TABS;

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
              <StatusBadge status={app.overallStatus || 'unknown'} size="sm" />
            </div>
            {app.pm2ProcessNames?.length > 0 && (
              <div className="text-xs text-gray-500 mt-1">
                {app.pm2ProcessNames.join(', ')}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Start/Stop/Restart */}
            <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
              {app.overallStatus === 'online' ? (
                <>
                  <button
                    onClick={handleStop}
                    disabled={actionLoading}
                    className="px-3 py-1.5 bg-port-error/20 text-port-error hover:bg-port-error/30 transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    <Square size={14} />
                    <span className="text-xs">Stop</span>
                  </button>
                  <button
                    onClick={handleRestart}
                    disabled={actionLoading}
                    className="px-3 py-1.5 bg-port-warning/20 text-port-warning hover:bg-port-warning/30 transition-colors disabled:opacity-50 border-l border-port-border flex items-center gap-1"
                  >
                    <RotateCcw size={14} className={actionLoading === 'restart' ? 'animate-spin' : ''} />
                    <span className="text-xs">Restart</span>
                  </button>
                </>
              ) : (
                <button
                  onClick={handleStart}
                  disabled={actionLoading}
                  className="px-3 py-1.5 bg-port-success/20 text-port-success hover:bg-port-success/30 transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  <Play size={14} />
                  <span className="text-xs">{actionLoading === 'start' ? 'Starting...' : 'Start'}</span>
                </button>
              )}
            </div>
            {/* Launch UI */}
            {app.uiPort && app.overallStatus === 'online' && (
              <button
                onClick={() => window.open(`${window.location.protocol}//${window.location.hostname}:${app.uiPort}`, '_blank')}
                className="px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors rounded-lg border border-port-border flex items-center gap-1"
              >
                <ExternalLink size={14} />
                <span className="text-xs">Launch</span>
              </button>
            )}
            {app.devUiPort && app.overallStatus === 'online' && (
              <button
                onClick={() => window.open(`${window.location.protocol}//${window.location.hostname}:${app.devUiPort}`, '_blank')}
                className="px-3 py-1.5 bg-port-warning/20 text-port-warning hover:bg-port-warning/30 transition-colors rounded-lg border border-port-border flex items-center gap-1"
              >
                <ExternalLink size={14} />
                <span className="text-xs">Launch Dev</span>
              </button>
            )}
            {app.buildCommand && app.overallStatus === 'online' && (
              <button
                onClick={handleBuild}
                disabled={buildLoading}
                className="px-3 py-1.5 bg-port-warning/20 text-port-warning hover:bg-port-warning/30 transition-colors rounded-lg border border-port-border flex items-center gap-1 disabled:opacity-50"
                aria-label={`Build production UI: ${app.buildCommand}`}
              >
                <Hammer size={14} className={buildLoading ? 'animate-bounce' : ''} />
                <span className="text-xs">{buildLoading ? 'Building...' : 'Build'}</span>
              </button>
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
