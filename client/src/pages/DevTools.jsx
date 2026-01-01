import { useState, useEffect, useRef } from 'react';
import * as api from '../services/api';
import socket from '../services/socket';

const TABS = [
  { id: 'history', label: 'History' },
  { id: 'runner', label: 'Command Runner' },
  { id: 'processes', label: 'Processes' }
];

export default function DevTools() {
  const [activeTab, setActiveTab] = useState('history');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Dev Tools</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-port-card border border-port-border rounded-lg p-1">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-port-accent text-white'
                : 'text-gray-400 hover:text-white hover:bg-port-border/50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'history' && <HistoryTab />}
      {activeTab === 'runner' && <RunnerTab />}
      {activeTab === 'processes' && <ProcessesTab />}
    </div>
  );
}

function HistoryTab() {
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ action: '', success: '' });
  const [actions, setActions] = useState([]);

  useEffect(() => {
    loadData();
  }, [filter]);

  const loadData = async () => {
    setLoading(true);
    const [historyData, statsData, actionsData] = await Promise.all([
      api.getHistory({
        limit: 100,
        action: filter.action || undefined,
        success: filter.success !== '' ? filter.success === 'true' : undefined
      }).catch(() => ({ entries: [] })),
      api.getHistoryStats().catch(() => null),
      api.getHistoryActions().catch(() => [])
    ]);
    setHistory(historyData.entries || []);
    setStats(statsData);
    setActions(actionsData);
    setLoading(false);
  };

  const handleClear = async () => {
    if (confirm('Clear all history?')) {
      await api.clearHistory();
      loadData();
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  };

  const getActionIcon = (action) => {
    const icons = {
      start: '▶️',
      stop: '⏹️',
      restart: '🔄',
      command: '💻',
      scaffold: '🏗️',
      'ai-run': '🤖'
    };
    return icons[action] || '📋';
  };

  if (loading) {
    return <div className="text-center py-8 text-gray-400">Loading history...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-white">{stats.total}</div>
            <div className="text-sm text-gray-400">Total Actions</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-port-success">{stats.successRate}%</div>
            <div className="text-sm text-gray-400">Success Rate</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-white">{stats.last24h}</div>
            <div className="text-sm text-gray-400">Last 24h</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-white">{Object.keys(stats.byAction).length}</div>
            <div className="text-sm text-gray-400">Action Types</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-4 items-center">
        <select
          value={filter.action}
          onChange={(e) => setFilter(prev => ({ ...prev, action: e.target.value }))}
          className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
        >
          <option value="">All Actions</option>
          {actions.map(action => (
            <option key={action} value={action}>{action}</option>
          ))}
        </select>

        <select
          value={filter.success}
          onChange={(e) => setFilter(prev => ({ ...prev, success: e.target.value }))}
          className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
        >
          <option value="">All Results</option>
          <option value="true">Success</option>
          <option value="false">Failed</option>
        </select>

        <div className="flex-1" />

        <button
          onClick={handleClear}
          className="px-4 py-2 bg-port-error/20 text-port-error hover:bg-port-error/30 rounded-lg transition-colors"
        >
          Clear History
        </button>
      </div>

      {/* History List */}
      <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
        {history.length === 0 ? (
          <div className="text-center py-12 text-gray-500">No history entries</div>
        ) : (
          <div className="divide-y divide-port-border">
            {history.map(entry => (
              <div key={entry.id} className="p-4 hover:bg-port-border/20">
                <div className="flex items-center gap-4">
                  <span className="text-xl">{getActionIcon(entry.action)}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">{entry.action}</span>
                      {entry.targetName && (
                        <span className="text-gray-400">→ {entry.targetName}</span>
                      )}
                    </div>
                    {entry.details?.command && (
                      <code className="text-xs text-gray-500 font-mono">{entry.details.command}</code>
                    )}
                  </div>
                  <span className={`w-2 h-2 rounded-full ${entry.success ? 'bg-port-success' : 'bg-port-error'}`} />
                  <span className="text-sm text-gray-500">{formatTime(entry.timestamp)}</span>
                </div>
                {entry.error && (
                  <div className="mt-2 text-sm text-port-error ml-10">{entry.error}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RunnerTab() {
  const [command, setCommand] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [commandId, setCommandId] = useState(null);
  const [apps, setApps] = useState([]);
  const [allowedCommands, setAllowedCommands] = useState([]);
  const outputRef = useRef(null);

  useEffect(() => {
    api.getApps().then(setApps).catch(() => []);
    api.getAllowedCommands().then(setAllowedCommands).catch(() => []);
  }, []);

  useEffect(() => {
    if (!commandId) return;

    const handleData = ({ data }) => {
      setOutput(prev => prev + data);
      if (outputRef.current) {
        outputRef.current.scrollTop = outputRef.current.scrollHeight;
      }
    };

    const handleComplete = (result) => {
      setRunning(false);
      setCommandId(null);
      setOutput(prev => prev + `\n--- Command finished (exit code: ${result.exitCode}) ---\n`);
    };

    socket.on(`command:${commandId}:data`, handleData);
    socket.on(`command:${commandId}:complete`, handleComplete);

    return () => {
      socket.off(`command:${commandId}:data`, handleData);
      socket.off(`command:${commandId}:complete`, handleComplete);
    };
  }, [commandId]);

  const handleRun = async () => {
    if (!command.trim()) return;

    setOutput('');
    setRunning(true);

    const result = await api.executeCommand(command, workspacePath || undefined)
      .catch(err => ({ error: err.message }));

    if (result.error) {
      setOutput(`Error: ${result.error}`);
      setRunning(false);
      return;
    }

    setCommandId(result.commandId);
  };

  const handleStop = async () => {
    if (commandId) {
      await api.stopCommand(commandId);
      setRunning(false);
      setCommandId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Workspace Selector */}
      <div className="flex gap-4">
        <select
          value={workspacePath}
          onChange={(e) => setWorkspacePath(e.target.value)}
          className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
        >
          <option value="">Current directory</option>
          {apps.map(app => (
            <option key={app.id} value={app.repoPath}>{app.name} ({app.repoPath})</option>
          ))}
        </select>
      </div>

      {/* Command Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !running && handleRun()}
          placeholder="Enter command (e.g., npm run build)"
          className="flex-1 px-4 py-3 bg-port-bg border border-port-border rounded-lg text-white font-mono focus:border-port-accent focus:outline-none"
        />
        {running ? (
          <button
            onClick={handleStop}
            className="px-6 py-3 bg-port-error hover:bg-port-error/80 text-white rounded-lg transition-colors"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={handleRun}
            disabled={!command.trim()}
            className="px-6 py-3 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            Run
          </button>
        )}
      </div>

      {/* Allowed Commands Info */}
      <div className="text-xs text-gray-500">
        Allowed: {allowedCommands.slice(0, 10).join(', ')}{allowedCommands.length > 10 ? `, +${allowedCommands.length - 10} more` : ''}
      </div>

      {/* Output */}
      <div
        ref={outputRef}
        className="bg-port-bg border border-port-border rounded-lg p-4 h-96 overflow-auto font-mono text-sm"
      >
        {output ? (
          <pre className="text-gray-300 whitespace-pre-wrap">{output}</pre>
        ) : (
          <div className="text-gray-500">Output will appear here...</div>
        )}
      </div>
    </div>
  );
}

function ProcessesTab() {
  const [processes, setProcesses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProcesses();
    const interval = setInterval(loadProcesses, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadProcesses = async () => {
    const data = await api.getProcessesList().catch(() => []);
    setProcesses(data);
    setLoading(false);
  };

  const formatMemory = (bytes) => {
    if (!bytes) return '0 MB';
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatUptime = (ms) => {
    if (!ms) return '-';
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (hours > 24) {
      return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    }
    return `${hours}h ${mins}m`;
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'online': return 'bg-port-success';
      case 'stopped': return 'bg-gray-500';
      case 'errored': return 'bg-port-error';
      default: return 'bg-port-warning';
    }
  };

  if (loading) {
    return <div className="text-center py-8 text-gray-400">Loading processes...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-gray-400">{processes.length} PM2 processes</p>
        <button
          onClick={loadProcesses}
          className="px-4 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-port-border/50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Name</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Status</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">PID</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">CPU</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Memory</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Uptime</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-400">Restarts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-port-border">
            {processes.map(proc => (
              <tr key={proc.pm_id} className="hover:bg-port-border/20">
                <td className="px-4 py-3">
                  <span className="font-medium text-white">{proc.name}</span>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center gap-2 px-2 py-1 rounded text-xs ${getStatusColor(proc.status)} bg-opacity-20`}>
                    <span className={`w-2 h-2 rounded-full ${getStatusColor(proc.status)}`} />
                    {proc.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-400 font-mono text-sm">{proc.pid || '-'}</td>
                <td className="px-4 py-3 text-gray-400">{proc.cpu ? `${proc.cpu}%` : '-'}</td>
                <td className="px-4 py-3 text-gray-400">{formatMemory(proc.memory)}</td>
                <td className="px-4 py-3 text-gray-400">{formatUptime(proc.uptime)}</td>
                <td className="px-4 py-3 text-gray-400">{proc.restarts}</td>
              </tr>
            ))}
            {processes.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-500">
                  No PM2 processes running
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
