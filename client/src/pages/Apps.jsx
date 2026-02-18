import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Play, Square, RotateCcw, FolderOpen, Terminal, Code, RefreshCw, Wrench, Archive, ArchiveRestore, ChevronDown, ChevronUp, Ticket } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../components/BrailleSpinner';
import StatusBadge from '../components/StatusBadge';
import IconPicker from '../components/IconPicker';
import * as api from '../services/api';
import socket from '../services/socket';

export default function Apps() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingApp, setEditingApp] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [actionLoading, setActionLoading] = useState({});
  const [refreshingConfig, setRefreshingConfig] = useState({});
  const [standardizing, setStandardizing] = useState({});
  const [archiving, setArchiving] = useState({});
  const [showArchived, setShowArchived] = useState(false);
  const [jiraTickets, setJiraTickets] = useState({});
  const [loadingTickets, setLoadingTickets] = useState({});

  const fetchApps = useCallback(async () => {
    const data = await api.getApps().catch(() => []);
    setApps(data);
    setLoading(false);
  }, []);

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
    await api.deleteApp(app.id);
    setConfirmingDelete(null);
    fetchApps();
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
    await api.restartApp(app.id).catch(() => null);
    setActionLoading(prev => ({ ...prev, [app.id]: null }));
  };

  const handleRefreshConfig = async (app) => {
    setRefreshingConfig(prev => ({ ...prev, [app.id]: true }));
    await api.refreshAppConfig(app.id).catch(() => null);
    setRefreshingConfig(prev => ({ ...prev, [app.id]: false }));
    fetchApps();
  };

  const handleStandardize = async (app) => {
    setStandardizing(prev => ({ ...prev, [app.id]: true }));

    // Step 1: Analyze
    const analysis = await api.analyzeStandardizationByApp(app.id).catch(err => {
      toast.error(`Analysis failed: ${err.message}`);
      return null;
    });

    if (!analysis?.success) {
      setStandardizing(prev => ({ ...prev, [app.id]: false }));
      return;
    }

    // Step 2: Apply
    const result = await api.applyStandardizationByApp(app.id, analysis).catch(err => {
      toast.error(`Apply failed: ${err.message}`);
      return null;
    });

    setStandardizing(prev => ({ ...prev, [app.id]: false }));

    if (result?.success) {
      const msg = result.backupBranch
        ? `Standardized! Backup: ${result.backupBranch}`
        : `Standardized ${result.filesModified?.length || 0} files`;
      toast.success(msg);
      fetchApps();
    }
  };

  const toggleExpand = async (id) => {
    const newExpandedId = expandedId === id ? null : id;
    setExpandedId(newExpandedId);

    // Fetch JIRA tickets when expanding an app with JIRA enabled
    if (newExpandedId) {
      const app = apps.find(a => a.id === newExpandedId);
      if (app?.jira?.enabled && app.jira.instanceId && app.jira.projectKey) {
        if (!jiraTickets[id]) {
          setLoadingTickets(prev => ({ ...prev, [id]: true }));
          const tickets = await api.getMySprintTickets(app.jira.instanceId, app.jira.projectKey).catch(() => []);
          setJiraTickets(prev => ({ ...prev, [id]: tickets }));
          setLoadingTickets(prev => ({ ...prev, [id]: false }));
        }
      }
    }
  };

  const handleArchive = async (app) => {
    setArchiving(prev => ({ ...prev, [app.id]: true }));
    await api.archiveApp(app.id).catch(() => null);
    setArchiving(prev => ({ ...prev, [app.id]: false }));
    toast.success(`${app.name} archived - excluded from COS tasks`);
  };

  const handleUnarchive = async (app) => {
    setArchiving(prev => ({ ...prev, [app.id]: true }));
    await api.unarchiveApp(app.id).catch(() => null);
    setArchiving(prev => ({ ...prev, [app.id]: false }));
    toast.success(`${app.name} unarchived - included in COS tasks`);
  };

  // Filter apps based on archive status
  const activeApps = apps.filter(app => !app.archived);
  const archivedApps = apps.filter(app => app.archived);
  const displayedApps = showArchived ? archivedApps : activeApps;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading apps" />
      </div>
    );
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
          {/* Archive Toggle */}
          {archivedApps.length > 0 && (
            <button
              onClick={() => setShowArchived(prev => !prev)}
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
            + Add App
          </Link>
        </div>
      </div>

      {/* App List */}
      {displayedApps.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-xl p-12 text-center">
          <div className="text-4xl mb-4">{showArchived ? '📦' : '🗂️'}</div>
          <h3 className="text-xl font-semibold text-white mb-2">
            {showArchived ? 'No archived apps' : 'No apps registered'}
          </h3>
          <p className="text-gray-500 mb-6">
            {showArchived ? 'Archived apps will appear here' : 'Add your first app to get started'}
          </p>
          {!showArchived && (
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
          {displayedApps.map(app => (
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
                      className="text-gray-400 hover:text-white transition-transform flex-shrink-0"
                      aria-expanded={expandedId === app.id}
                      aria-label={`${expandedId === app.id ? 'Collapse' : 'Expand'} ${app.name} details`}
                    >
                      <span aria-hidden="true" className={`inline-block transition-transform ${expandedId === app.id ? 'rotate-90' : ''}`}>▶</span>
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`font-medium ${app.archived ? 'text-gray-400' : 'text-white'}`}>{app.name}</span>
                        {app.archived && (
                          <span className="px-1.5 py-0.5 bg-port-warning/20 text-port-warning text-xs rounded">
                            Archived
                          </span>
                        )}
                        <StatusBadge status={app.overallStatus} size="sm" />
                      </div>
                      <div className="text-xs text-gray-500 flex flex-wrap gap-x-2 mt-1">
                        {(app.pm2ProcessNames || []).map((procName, i) => {
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
                              {procName}<span className="text-cyan-500">{portDisplay}</span>
                              {i < (app.pm2ProcessNames?.length || 0) - 1 ? ',' : ''}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Controls */}
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Start/Stop/Restart Button Group */}
                    <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
                      {app.overallStatus === 'online' ? (
                        <>
                          <button
                            onClick={() => handleStop(app)}
                            disabled={actionLoading[app.id]}
                            className="px-3 py-1.5 bg-port-error/20 text-port-error hover:bg-port-error/30 transition-colors disabled:opacity-50 flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-port-error"
                            aria-label={`Stop ${app.name}`}
                            aria-busy={actionLoading[app.id] === 'stop'}
                          >
                            <Square size={14} aria-hidden="true" />
                            <span className="text-xs">Stop</span>
                          </button>
                          <button
                            onClick={() => handleRestart(app)}
                            disabled={actionLoading[app.id]}
                            className="px-3 py-1.5 bg-port-warning/20 text-port-warning hover:bg-port-warning/30 transition-colors disabled:opacity-50 border-l border-port-border flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-port-warning"
                            aria-label={`Restart ${app.name}`}
                            aria-busy={actionLoading[app.id] === 'restart'}
                          >
                            <RotateCcw size={14} aria-hidden="true" className={actionLoading[app.id] === 'restart' ? 'animate-spin' : ''} />
                            <span className="text-xs">Restart</span>
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleStart(app)}
                          disabled={actionLoading[app.id]}
                          className="px-3 py-1.5 bg-port-success/20 text-port-success hover:bg-port-success/30 transition-colors disabled:opacity-50 flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-port-success"
                          aria-label={`Start ${app.name}`}
                          aria-busy={actionLoading[app.id] === 'start'}
                        >
                          <Play size={14} aria-hidden="true" />
                          <span className="text-xs">{actionLoading[app.id] === 'start' ? 'Starting...' : 'Start'}</span>
                        </button>
                      )}
                    </div>

                    {/* Launch button */}
                    {app.uiPort && app.overallStatus === 'online' && (
                      <button
                        onClick={() => window.open(`${window.location.protocol}//${window.location.hostname}:${app.uiPort}`, '_blank')}
                        className="px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors rounded-lg border border-port-border flex items-center gap-1"
                        aria-label={`Launch ${app.name} UI`}
                      >
                        <ExternalLink size={14} aria-hidden="true" />
                        <span className="text-xs">Launch</span>
                      </button>
                    )}

                    {/* Edit/Delete Actions */}
                    {confirmingDelete === app.id ? (
                      <div className="flex items-center gap-2" role="alertdialog" aria-label={`Confirm deletion of ${app.name}`}>
                        <span className="text-xs text-gray-400">Remove?</span>
                        <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
                          <button
                            onClick={() => handleDelete(app)}
                            className="px-2 py-1 bg-port-error/20 text-port-error hover:bg-port-error/30 text-xs focus:outline-none focus:ring-2 focus:ring-port-error"
                            aria-label={`Confirm delete ${app.name}`}
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setConfirmingDelete(null)}
                            className="px-2 py-1 bg-port-border/50 text-gray-400 hover:text-white text-xs border-l border-port-border focus:outline-none focus:ring-2 focus:ring-port-accent"
                            aria-label="Cancel deletion"
                          >
                            No
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        {/* Archive/Unarchive button */}
                        <button
                          onClick={() => app.archived ? handleUnarchive(app) : handleArchive(app)}
                          disabled={archiving[app.id]}
                          className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 transition-colors disabled:opacity-50 border ${
                            app.archived
                              ? 'bg-port-success/20 text-port-success border-port-success/30 hover:bg-port-success/30'
                              : 'bg-port-border text-gray-400 border-port-border hover:text-white hover:bg-port-border/80'
                          }`}
                          aria-label={app.archived ? `Unarchive ${app.name}` : `Archive ${app.name}`}
                        >
                          {app.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                          {archiving[app.id] ? '...' : app.archived ? 'Unarchive' : 'Archive'}
                        </button>
                        <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
                          <button
                            onClick={() => setEditingApp(app)}
                            className="px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors text-xs focus:outline-none focus:ring-2 focus:ring-port-accent"
                            aria-label={`Edit ${app.name}`}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setConfirmingDelete(app.id)}
                            className="px-3 py-1.5 bg-port-error/10 text-port-error hover:bg-port-error/20 transition-colors text-xs border-l border-port-border focus:outline-none focus:ring-2 focus:ring-port-error"
                            aria-label={`Delete ${app.name}`}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
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
                          <FolderOpen size={16} aria-hidden="true" className="text-yellow-400 flex-shrink-0 mt-0.5" />
                          <code className="text-sm text-gray-300 font-mono break-all">{app.repoPath}</code>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Editor Command</div>
                        <div className="flex items-center gap-2">
                          <Code size={16} aria-hidden="true" className="text-blue-400 flex-shrink-0" />
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
                              <Terminal size={14} aria-hidden="true" className="text-green-400 flex-shrink-0 mt-0.5" />
                              <code className="text-sm text-cyan-300 font-mono break-all">{cmd}</code>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* PM2 Processes Status */}
                    {app.pm2Status && Object.keys(app.pm2Status).length > 0 && (
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
                                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                  proc.status === 'online' ? 'bg-port-success' :
                                  proc.status === 'stopped' ? 'bg-gray-500' : 'bg-port-error'
                                }`} />
                                <span className="text-sm text-white font-mono">{proc.name}</span>
                                {processConfig?.ports && Object.keys(processConfig.ports).length > 0 && (
                                  <span className="text-xs text-cyan-400 font-mono">
                                    {Object.entries(processConfig.ports).length > 1
                                      ? ` (${Object.entries(processConfig.ports).map(([label, port]) => `${label}:${port}`).join(', ')})`
                                      : `:${Object.values(processConfig.ports)[0]}`}
                                  </span>
                                )}
                                <span className="text-xs text-gray-500">{proc.status}</span>
                                {proc.cpu !== undefined && (
                                  <span className="text-xs text-green-400">{proc.cpu}%</span>
                                )}
                                {proc.memory !== undefined && (
                                  <span className="text-xs text-blue-400">{(proc.memory / 1024 / 1024).toFixed(0)}MB</span>
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
                          <Ticket size={16} aria-hidden="true" className="text-blue-400 flex-shrink-0" />
                          <span className="text-sm text-white font-mono">{app.jira.projectKey || '—'}</span>
                          {app.jira.issueType && (
                            <span className="text-xs text-gray-400">{app.jira.issueType}</span>
                          )}
                          {app.jira.createPR !== false && (
                            <span className="text-xs text-green-400">+ PR</span>
                          )}
                          {app.jira.labels?.length > 0 && (
                            <span className="text-xs text-cyan-400">{app.jira.labels.join(', ')}</span>
                          )}
                        </div>

                        {/* My Sprint Tickets */}
                        {app.jira.instanceId && app.jira.projectKey && (
                          <div className="mt-3">
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">My Sprint Tickets</div>
                            {loadingTickets[app.id] ? (
                              <div className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400">
                                <BrailleSpinner text="" />
                                <span>Loading tickets...</span>
                              </div>
                            ) : jiraTickets[app.id]?.length > 0 ? (
                              <div className="space-y-2">
                                {jiraTickets[app.id].map(ticket => (
                                  <a
                                    key={ticket.key}
                                    href={ticket.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block px-3 py-2 bg-port-card border border-port-border rounded-lg hover:border-port-accent/50 transition-colors"
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                          <span className="text-sm font-mono text-port-accent">{ticket.key}</span>
                                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                                            ticket.statusCategory === 'Done' ? 'bg-port-success/20 text-port-success' :
                                            ticket.statusCategory === 'In Progress' ? 'bg-port-accent/20 text-port-accent' :
                                            'bg-gray-500/20 text-gray-400'
                                          }`}>
                                            {ticket.status}
                                          </span>
                                          {ticket.priority && (
                                            <span className={`text-xs ${
                                              ticket.priority === 'Highest' || ticket.priority === 'High' ? 'text-port-error' :
                                              ticket.priority === 'Medium' ? 'text-port-warning' :
                                              'text-gray-500'
                                            }`}>
                                              {ticket.priority}
                                            </span>
                                          )}
                                          {ticket.storyPoints && (
                                            <span className="text-xs text-cyan-400">{ticket.storyPoints} pts</span>
                                          )}
                                        </div>
                                        <div className="text-sm text-white line-clamp-2">{ticket.summary}</div>
                                        <div className="text-xs text-gray-500 mt-1">
                                          {ticket.issueType} • Updated {new Date(ticket.updated).toLocaleDateString()}
                                        </div>
                                      </div>
                                      <ExternalLink size={14} className="text-gray-500 flex-shrink-0 mt-1" />
                                    </div>
                                  </a>
                                ))}
                              </div>
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
                        className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
                      >
                        <Code size={14} aria-hidden="true" /> Open in Editor
                      </button>
                      <button
                        onClick={() => api.openAppFolder(app.id).catch(() => null)}
                        className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
                      >
                        <FolderOpen size={14} aria-hidden="true" /> Open Folder
                      </button>
                      <button
                        onClick={() => handleRefreshConfig(app)}
                        disabled={refreshingConfig[app.id]}
                        className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
                        aria-label="Re-scan ecosystem config for PM2 processes and ports"
                      >
                        <RefreshCw size={14} aria-hidden="true" className={refreshingConfig[app.id] ? 'animate-spin' : ''} />
                        Refresh Config
                      </button>
                      <button
                        onClick={() => handleStandardize(app)}
                        disabled={standardizing[app.id]}
                        className="px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
                        aria-label="Standardize PM2 config: move all ports to ecosystem.config.cjs"
                      >
                        <Wrench size={14} aria-hidden="true" className={standardizing[app.id] ? 'animate-spin' : ''} />
                        {standardizing[app.id] ? 'Standardizing...' : 'Standardize PM2'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Edit Modal */}
      {editingApp && (
        <EditAppModal
          app={editingApp}
          onClose={() => setEditingApp(null)}
          onSave={() => { setEditingApp(null); fetchApps(); }}
        />
      )}
    </div>
  );
}

function EditAppModal({ app, onClose, onSave }) {
  const [formData, setFormData] = useState({
    name: app.name,
    icon: app.icon || 'package',
    repoPath: app.repoPath,
    uiPort: app.uiPort || '',
    apiPort: app.apiPort || '',
    startCommands: (app.startCommands || []).join('\n'),
    pm2ProcessNames: (app.pm2ProcessNames || []).join(', '),
    editorCommand: app.editorCommand || 'code .',
    jiraEnabled: app.jira?.enabled || false,
    jiraInstanceId: app.jira?.instanceId || '',
    jiraProjectKey: app.jira?.projectKey || '',
    jiraBoardId: app.jira?.boardId || '',
    jiraIssueType: app.jira?.issueType || 'Task',
    jiraLabels: (app.jira?.labels || []).join(', '),
    jiraAssignee: app.jira?.assignee || '',
    jiraEpicKey: app.jira?.epicKey || '',
    jiraCreatePR: app.jira?.createPR !== false
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [jiraExpanded, setJiraExpanded] = useState(app.jira?.enabled || false);
  const [jiraInstances, setJiraInstances] = useState([]);
  const [jiraProjects, setJiraProjects] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);

  // Fetch JIRA instances on mount
  useEffect(() => {
    api.getJiraInstances().then(data => {
      const instances = data?.instances ? Object.values(data.instances) : [];
      setJiraInstances(instances);
    }).catch(() => setJiraInstances([]));
  }, []);

  // Fetch JIRA projects when instance changes + default assignee to instance user
  useEffect(() => {
    if (!formData.jiraInstanceId) {
      setJiraProjects([]);
      return;
    }
    setLoadingProjects(true);
    api.getJiraProjects(formData.jiraInstanceId).then(projects => {
      setJiraProjects(projects || []);
    }).catch(() => setJiraProjects([])).finally(() => setLoadingProjects(false));

    // Default assignee to the configured JIRA user if not already set
    if (!formData.jiraAssignee) {
      const inst = jiraInstances.find(i => i.id === formData.jiraInstanceId);
      if (inst?.email) {
        setFormData(prev => ({ ...prev, jiraAssignee: inst.email }));
      }
    }
  }, [formData.jiraInstanceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const data = {
      name: formData.name,
      icon: formData.icon,
      repoPath: formData.repoPath,
      uiPort: formData.uiPort ? parseInt(formData.uiPort) : null,
      apiPort: formData.apiPort ? parseInt(formData.apiPort) : null,
      startCommands: formData.startCommands.split('\n').filter(Boolean),
      pm2ProcessNames: formData.pm2ProcessNames
        ? formData.pm2ProcessNames.split(',').map(s => s.trim()).filter(Boolean)
        : undefined,
      editorCommand: formData.editorCommand || undefined,
      jira: formData.jiraEnabled ? {
        enabled: true,
        instanceId: formData.jiraInstanceId || undefined,
        projectKey: formData.jiraProjectKey || undefined,
        boardId: formData.jiraBoardId || undefined,
        issueType: formData.jiraIssueType || 'Task',
        labels: formData.jiraLabels ? formData.jiraLabels.split(',').map(s => s.trim()).filter(Boolean) : [],
        assignee: formData.jiraAssignee || undefined,
        epicKey: formData.jiraEpicKey || undefined,
        createPR: formData.jiraCreatePR
      } : { enabled: false }
    };

    await api.updateApp(app.id, data).catch(err => {
      setError(err.message);
      setSaving(false);
      throw err;
    });

    setSaving(false);
    onSave();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-app-title"
    >
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 w-full max-w-lg max-h-[90vh] overflow-auto">
        <h2 id="edit-app-title" className="text-xl font-bold text-white mb-4">Edit App</h2>

        {error && (
          <div className="mb-4 p-3 bg-port-error/20 border border-port-error rounded-lg text-port-error text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={e => setFormData({ ...formData, name: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                required
              />
            </div>
            <div className="w-full sm:w-32">
              <IconPicker value={formData.icon} onChange={icon => setFormData({ ...formData, icon })} />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Repository Path</label>
            <input
              type="text"
              value={formData.repoPath}
              onChange={e => setFormData({ ...formData, repoPath: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">UI Port</label>
              <input
                type="number"
                value={formData.uiPort}
                onChange={e => setFormData({ ...formData, uiPort: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                placeholder="3000"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">API Port</label>
              <input
                type="number"
                value={formData.apiPort}
                onChange={e => setFormData({ ...formData, apiPort: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                placeholder="3001"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Start Commands (one per line)</label>
            <textarea
              value={formData.startCommands}
              onChange={e => setFormData({ ...formData, startCommands: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none font-mono text-sm"
              rows={2}
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">PM2 Process Names (comma-separated)</label>
            <input
              type="text"
              value={formData.pm2ProcessNames}
              onChange={e => setFormData({ ...formData, pm2ProcessNames: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Editor Command</label>
            <input
              type="text"
              value={formData.editorCommand}
              onChange={e => setFormData({ ...formData, editorCommand: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
            />
          </div>

          {/* JIRA Integration Section */}
          <div className="border border-port-border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setJiraExpanded(prev => !prev)}
              className="w-full flex items-center justify-between px-4 py-3 bg-port-bg hover:bg-port-border/50 transition-colors"
            >
              <span className="text-sm font-medium text-gray-300">JIRA Integration</span>
              <div className="flex items-center gap-2">
                {formData.jiraEnabled && (
                  <span className="text-xs px-2 py-0.5 bg-port-accent/20 text-port-accent rounded">Enabled</span>
                )}
                {jiraExpanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
              </div>
            </button>

            {jiraExpanded && (
              <div className="p-4 space-y-3 border-t border-port-border">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.jiraEnabled}
                    onChange={e => setFormData({ ...formData, jiraEnabled: e.target.checked })}
                    className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                  />
                  <span className="text-sm text-white">Enable JIRA Integration</span>
                </label>

                {formData.jiraEnabled && (
                  <>
                    {jiraInstances.length === 0 ? (
                      <div className="p-3 bg-port-warning/10 border border-port-warning/30 rounded-lg text-sm text-port-warning">
                        No JIRA instances configured. <Link to="/jira" className="underline hover:text-white">Configure JIRA</Link> first.
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="block text-sm text-gray-400 mb-1">JIRA Instance</label>
                          <select
                            value={formData.jiraInstanceId}
                            onChange={e => setFormData({ ...formData, jiraInstanceId: e.target.value, jiraProjectKey: '' })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                          >
                            <option value="">Select instance...</option>
                            {jiraInstances.map(inst => (
                              <option key={inst.id} value={inst.id}>{inst.name} ({inst.baseUrl})</option>
                            ))}
                          </select>
                        </div>

                        <div className="relative">
                          <label className="block text-sm text-gray-400 mb-1">Project Key</label>
                          {loadingProjects ? (
                            <div className="text-xs text-gray-500">Loading projects...</div>
                          ) : jiraProjects.length > 0 ? (
                            <div>
                              <input
                                type="text"
                                value={projectDropdownOpen ? projectSearch : (
                                  formData.jiraProjectKey
                                    ? `${formData.jiraProjectKey} - ${jiraProjects.find(p => p.key === formData.jiraProjectKey)?.name || ''}`
                                    : ''
                                )}
                                onChange={e => {
                                  setProjectSearch(e.target.value);
                                  if (!projectDropdownOpen) setProjectDropdownOpen(true);
                                }}
                                onFocus={() => {
                                  setProjectDropdownOpen(true);
                                  setProjectSearch('');
                                }}
                                onBlur={() => setTimeout(() => setProjectDropdownOpen(false), 150)}
                                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                                placeholder="Search projects..."
                              />
                              {formData.jiraProjectKey && !projectDropdownOpen && (
                                <button
                                  type="button"
                                  onClick={() => setFormData({ ...formData, jiraProjectKey: '' })}
                                  className="absolute right-2 top-8 text-gray-500 hover:text-white text-sm"
                                >
                                  ✕
                                </button>
                              )}
                              {projectDropdownOpen && (
                                <div className="absolute z-50 w-full mt-1 bg-port-bg border border-port-border rounded-lg max-h-48 overflow-auto shadow-lg">
                                  {jiraProjects
                                    .filter(proj => {
                                      if (!projectSearch) return true;
                                      const q = projectSearch.toLowerCase();
                                      return proj.key.toLowerCase().includes(q) || proj.name.toLowerCase().includes(q);
                                    })
                                    .sort((a, b) => a.key.localeCompare(b.key))
                                    .slice(0, 100)
                                    .map(proj => (
                                      <button
                                        key={proj.key}
                                        type="button"
                                        onMouseDown={e => {
                                          e.preventDefault();
                                          setFormData({ ...formData, jiraProjectKey: proj.key });
                                          setProjectDropdownOpen(false);
                                          setProjectSearch('');
                                        }}
                                        className={`w-full text-left px-3 py-2 text-sm hover:bg-port-accent/20 ${
                                          formData.jiraProjectKey === proj.key ? 'bg-port-accent/10 text-port-accent' : 'text-white'
                                        }`}
                                      >
                                        <span className="font-mono">{proj.key}</span>
                                        <span className="text-gray-400 ml-2">{proj.name}</span>
                                      </button>
                                    ))
                                  }
                                  {jiraProjects.filter(proj => {
                                    if (!projectSearch) return true;
                                    const q = projectSearch.toLowerCase();
                                    return proj.key.toLowerCase().includes(q) || proj.name.toLowerCase().includes(q);
                                  }).length === 0 && (
                                    <div className="px-3 py-2 text-sm text-gray-500">No matching projects</div>
                                  )}
                                </div>
                              )}
                            </div>
                          ) : (
                            <input
                              type="text"
                              value={formData.jiraProjectKey}
                              onChange={e => setFormData({ ...formData, jiraProjectKey: e.target.value })}
                              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                              placeholder="e.g. CONTECH"
                            />
                          )}
                        </div>

                        <div>
                          <label className="block text-sm text-gray-400 mb-1">Board ID</label>
                          <input
                            type="text"
                            value={formData.jiraBoardId}
                            onChange={e => setFormData({ ...formData, jiraBoardId: e.target.value })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                            placeholder="e.g. 11810 (from JIRA board URL rapidView param)"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-sm text-gray-400 mb-1">Issue Type</label>
                            <input
                              type="text"
                              value={formData.jiraIssueType}
                              onChange={e => setFormData({ ...formData, jiraIssueType: e.target.value })}
                              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                              placeholder="Task"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-400 mb-1">Assignee</label>
                            <input
                              type="text"
                              value={formData.jiraAssignee}
                              onChange={e => setFormData({ ...formData, jiraAssignee: e.target.value })}
                              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                              placeholder="Optional"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-sm text-gray-400 mb-1">Labels (comma-separated)</label>
                          <input
                            type="text"
                            value={formData.jiraLabels}
                            onChange={e => setFormData({ ...formData, jiraLabels: e.target.value })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                            placeholder="e.g. cos-auto, feature"
                          />
                        </div>

                        <div>
                          <label className="block text-sm text-gray-400 mb-1">Epic Key</label>
                          <input
                            type="text"
                            value={formData.jiraEpicKey}
                            onChange={e => setFormData({ ...formData, jiraEpicKey: e.target.value })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                            placeholder="e.g. CONTECH-100"
                          />
                        </div>

                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formData.jiraCreatePR}
                            onChange={e => setFormData({ ...formData, jiraCreatePR: e.target.checked })}
                            className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                          />
                          <span className="text-sm text-white">Create Pull Request on completion</span>
                        </label>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
