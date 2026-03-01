import { useState, useEffect, useMemo } from 'react';
import { FolderOpen, Terminal, Code, RefreshCw, Wrench, Archive, ArchiveRestore, Ticket, ExternalLink, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../../BrailleSpinner';
import EditAppModal from '../EditAppModal';
import ActivityLog from '../ActivityLog';
import { useAppOperation } from '../../../hooks/useAppOperation';
import * as api from '../../../services/api';

function KanbanBoard({ tickets }) {
  const columns = {
    'To Do': tickets.filter(t => t.statusCategory === 'To Do'),
    'In Progress': tickets.filter(t => t.statusCategory === 'In Progress'),
    'Done': tickets.filter(t => t.statusCategory === 'Done')
  };

  const columnConfig = {
    'To Do': { bg: 'bg-gray-500/10', border: 'border-gray-500/30', dot: 'bg-gray-500' },
    'In Progress': { bg: 'bg-port-accent/10', border: 'border-port-accent/30', dot: 'bg-port-accent' },
    'Done': { bg: 'bg-port-success/10', border: 'border-port-success/30', dot: 'bg-port-success' }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {Object.entries(columns).map(([category, categoryTickets]) => {
        const config = columnConfig[category];
        return (
          <div key={category} className={`${config.bg} border ${config.border} rounded-lg p-3 min-h-[120px]`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-2 h-2 rounded-full ${config.dot}`} />
              <span className="text-sm font-medium text-white">{category}</span>
              <span className="text-xs text-gray-500">({categoryTickets.length})</span>
            </div>
            <div className="space-y-2">
              {categoryTickets.map(ticket => (
                <a
                  key={ticket.key}
                  href={ticket.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block p-2 bg-port-card border border-port-border rounded-lg hover:border-port-accent/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-1">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono text-port-accent">{ticket.key}</span>
                        {ticket.priority && (
                          <span className={`text-xs ${
                            ticket.priority === 'Highest' || ticket.priority === 'High' ? 'text-port-error' :
                            ticket.priority === 'Medium' ? 'text-port-warning' : 'text-gray-500'
                          }`}>{ticket.priority}</span>
                        )}
                        {ticket.storyPoints && (
                          <span className="text-xs text-cyan-400">{ticket.storyPoints}pt</span>
                        )}
                      </div>
                      <div className="text-xs text-white line-clamp-2">{ticket.summary}</div>
                      <div className="text-xs text-gray-500 mt-1">{ticket.issueType}</div>
                    </div>
                    <ExternalLink size={12} className="text-gray-500 flex-shrink-0" />
                  </div>
                </a>
              ))}
              {categoryTickets.length === 0 && (
                <div className="text-xs text-gray-500 text-center py-4">No tickets</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function OverviewTab({ app, onRefresh }) {
  const [editingApp, setEditingApp] = useState(null);
  const [refreshingConfig, setRefreshingConfig] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [jiraTickets, setJiraTickets] = useState(null);
  const [loadingTickets, setLoadingTickets] = useState(false);

  const onComplete = useMemo(() => () => onRefresh(), [onRefresh]);
  const { steps, isOperating, operationType, error, completed, startUpdate, startStandardize } = useAppOperation({ onComplete });
  const updating = isOperating && operationType === 'update';
  const standardizing = isOperating && operationType === 'standardize';

  useEffect(() => {
    if (app?.jira?.enabled && app.jira.instanceId && app.jira.projectKey) {
      setLoadingTickets(true);
      api.getMySprintTickets(app.jira.instanceId, app.jira.projectKey)
        .then(setJiraTickets)
        .catch(() => setJiraTickets([]))
        .finally(() => setLoadingTickets(false));
    }
  }, [app?.jira?.enabled, app?.jira?.instanceId, app?.jira?.projectKey]);

  const handleUpdate = () => startUpdate(app.id);

  const handleRefreshConfig = async () => {
    setRefreshingConfig(true);
    await api.refreshAppConfig(app.id).catch(() => null);
    setRefreshingConfig(false);
    onRefresh();
  };

  const handleStandardize = () => startStandardize(app.id);

  const handleArchive = async () => {
    setArchiving(true);
    await api.archiveApp(app.id).catch(() => null);
    setArchiving(false);
    toast.success(`${app.name} archived - excluded from COS tasks`);
    onRefresh();
  };

  const handleUnarchive = async () => {
    setArchiving(true);
    await api.unarchiveApp(app.id).catch(() => null);
    setArchiving(false);
    toast.success(`${app.name} unarchived - included in COS tasks`);
    onRefresh();
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Details Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Repository Path</div>
          <div className="flex items-start gap-2">
            <FolderOpen size={16} className="text-yellow-400 flex-shrink-0 mt-0.5" />
            <code className="text-sm text-gray-300 font-mono break-all">{app.repoPath}</code>
          </div>
        </div>
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Editor Command</div>
          <div className="flex items-center gap-2">
            <Code size={16} className="text-blue-400 flex-shrink-0" />
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
                <Terminal size={14} className="text-green-400 flex-shrink-0 mt-0.5" />
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
            <Ticket size={16} className="text-blue-400 flex-shrink-0" />
            <span className="text-sm text-white font-mono">{app.jira.projectKey || '-'}</span>
            {app.jira.issueType && <span className="text-xs text-gray-400">{app.jira.issueType}</span>}
            {app.jira.createPR !== false && <span className="text-xs text-green-400">+ PR</span>}
            {app.jira.labels?.length > 0 && (
              <span className="text-xs text-cyan-400">{app.jira.labels.join(', ')}</span>
            )}
          </div>

          {app.jira.instanceId && app.jira.projectKey && (
            <div className="mt-3">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">My Sprint Tickets</div>
              {loadingTickets ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400">
                  <BrailleSpinner text="" />
                  <span>Loading tickets...</span>
                </div>
              ) : jiraTickets?.length > 0 ? (
                <KanbanBoard tickets={jiraTickets} />
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
          <Code size={14} /> Open in Editor
        </button>
        <button
          onClick={() => api.openAppFolder(app.id).catch(() => null)}
          className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
        >
          <FolderOpen size={14} /> Open Folder
        </button>
        <button
          onClick={handleUpdate}
          disabled={isOperating}
          className="px-3 py-1.5 bg-port-success/20 text-port-success hover:bg-port-success/30 rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
        >
          <Download size={14} className={updating ? 'animate-bounce' : ''} />
          {updating ? 'Updating...' : 'Update'}
        </button>
        <button
          onClick={handleRefreshConfig}
          disabled={refreshingConfig}
          className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshingConfig ? 'animate-spin' : ''} />
          Refresh Config
        </button>
        <button
          onClick={handleStandardize}
          disabled={isOperating}
          className="px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
        >
          <Wrench size={14} className={standardizing ? 'animate-spin' : ''} />
          {standardizing ? 'Standardizing...' : 'Standardize PM2'}
        </button>
        <button
          onClick={() => setEditingApp(app)}
          className="px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded-lg text-xs flex items-center gap-1"
        >
          Edit
        </button>
        {app.id !== api.PORTOS_APP_ID && (
          <button
            onClick={app.archived ? handleUnarchive : handleArchive}
            disabled={archiving}
            className={`px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 transition-colors disabled:opacity-50 border ${
              app.archived
                ? 'bg-port-success/20 text-port-success border-port-success/30 hover:bg-port-success/30'
                : 'bg-port-border text-gray-400 border-port-border hover:text-white hover:bg-port-border/80'
            }`}
          >
            {app.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {archiving ? '...' : app.archived ? 'Unarchive' : 'Archive'}
          </button>
        )}
      </div>

      {/* Activity Log */}
      <ActivityLog steps={steps} error={error} completed={completed} />

      {/* Edit Modal */}
      {editingApp && (
        <EditAppModal
          app={editingApp}
          onClose={() => setEditingApp(null)}
          onSave={() => { setEditingApp(null); onRefresh(); }}
        />
      )}
    </div>
  );
}
