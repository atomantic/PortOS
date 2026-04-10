import { useState, useEffect, useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import * as api from '../services/api';
import { formatTime, formatRuntime } from '../utils/formatters';
import BrailleSpinner from '../components/BrailleSpinner';

export function HistoryPage() {
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ action: '', success: '' });
  const [actions, setActions] = useState([]);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const loadData = useCallback(async () => {
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
  }, [filter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleClear = async () => {
    const result = await api.clearHistory().catch(() => null);
    if (result === null) return;
    setConfirmingClear(false);
    loadData();
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    const result = await api.deleteHistoryEntry(id).catch(() => null);
    if (result === null) return;
    setHistory(prev => prev.filter(entry => entry.id !== id));
    if (expandedId === id) setExpandedId(null);
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

  const toggleExpand = (id) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  if (loading) {
    return <div className="text-center py-8"><BrailleSpinner text="Loading history" /></div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Action History</h1>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
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
      <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 sm:items-center">
        <div className="flex flex-wrap gap-2 sm:gap-4">
          <select
            value={filter.action}
            onChange={(e) => setFilter(prev => ({ ...prev, action: e.target.value }))}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent"
            aria-label="Filter by action type"
          >
            <option value="">All Actions</option>
            {actions.map(action => (
              <option key={action} value={action}>{action}</option>
            ))}
          </select>

          <select
            value={filter.success}
            onChange={(e) => setFilter(prev => ({ ...prev, success: e.target.value }))}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent"
            aria-label="Filter by result status"
          >
            <option value="">All Results</option>
            <option value="true">Success</option>
            <option value="false">Failed</option>
          </select>
        </div>

        <div className="flex-1" />

        {confirmingClear ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">Clear all?</span>
            <button
              onClick={handleClear}
              className="px-3 py-1.5 bg-port-error/20 text-port-error hover:bg-port-error/30 rounded-lg transition-colors"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirmingClear(false)}
              className="px-3 py-1.5 text-gray-400 hover:text-white"
            >
              No
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingClear(true)}
            className="px-4 py-2 bg-port-error/20 text-port-error hover:bg-port-error/30 rounded-lg transition-colors"
          >
            Clear History
          </button>
        )}
      </div>

      {/* History List */}
      <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
        {history.length === 0 ? (
          <div className="text-center py-12 text-gray-500">No history entries</div>
        ) : (
          <div className="divide-y divide-port-border">
            {history.map(entry => (
              <div key={entry.id}>
                <div
                  className="p-3 sm:p-4 hover:bg-port-border/20 cursor-pointer group"
                  onClick={() => toggleExpand(entry.id)}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <button
                        type="button"
                        className="text-gray-400 hover:text-white shrink-0 focus:outline-hidden focus:ring-2 focus:ring-port-accent rounded"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpand(entry.id);
                        }}
                        aria-expanded={expandedId === entry.id}
                        aria-label={`${expandedId === entry.id ? 'Collapse' : 'Expand'} ${entry.action} details`}
                      >
                        <span className={`inline-block transition-transform ${expandedId === entry.id ? 'rotate-90' : ''}`} aria-hidden="true">▶</span>
                      </button>
                      <span className="text-xl shrink-0">{getActionIcon(entry.action)}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium text-white">{entry.action}</span>
                          {entry.targetName && (
                            <span className="text-gray-400 text-sm sm:text-base">→ {entry.targetName}</span>
                          )}
                          {entry.details?.runtime && (
                            <span className="text-xs text-cyan-400 font-mono">{formatRuntime(entry.details.runtime)}</span>
                          )}
                        </div>
                        {entry.details?.command && (
                          <code className="text-xs text-gray-500 font-mono truncate block mt-1">{entry.details.command}</code>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 pl-8 sm:pl-0">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${entry.success ? 'bg-port-success' : 'bg-port-error'}`}
                        role="img"
                        aria-label={entry.success ? 'Success' : 'Failed'}
                      />
                      <span className="text-sm text-gray-500 shrink-0">{formatTime(entry.timestamp)}</span>
                      <button
                        onClick={(e) => handleDelete(entry.id, e)}
                        className="p-1 text-gray-500 hover:text-port-error transition-colors sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-port-accent rounded"
                        title="Delete entry"
                        aria-label={`Delete ${entry.action} entry from ${formatTime(entry.timestamp)}`}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded Details */}
                {expandedId === entry.id && (
                  <div className="px-4 pb-4 bg-port-bg border-t border-port-border">
                    <div className="pt-4 space-y-4">
                      {/* Metadata Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Timestamp</div>
                          <div className="text-gray-300">{new Date(entry.timestamp).toLocaleString()}</div>
                        </div>
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Status</div>
                          <div className={entry.success ? 'text-port-success' : 'text-port-error'}>
                            {entry.success ? 'Success' : 'Failed'}
                          </div>
                        </div>
                        {entry.details?.runtime && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Runtime</div>
                            <div className="text-cyan-400 font-mono">{formatRuntime(entry.details.runtime)}</div>
                          </div>
                        )}
                        {entry.details?.exitCode !== undefined && (
                          <div>
                            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Exit Code</div>
                            <div className={`font-mono ${entry.details.exitCode === 0 ? 'text-port-success' : 'text-port-error'}`}>
                              {entry.details.exitCode}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Command */}
                      {entry.details?.command && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Command</div>
                          <div className="bg-port-card border border-port-border rounded-lg p-3">
                            <code className="text-sm text-cyan-300 font-mono whitespace-pre-wrap break-all">
                              {entry.details.command}
                            </code>
                          </div>
                        </div>
                      )}

                      {/* Output */}
                      {entry.details?.output && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Output</div>
                          <div className="bg-port-card border border-port-border rounded-lg p-3 max-h-64 overflow-auto">
                            <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-all">
                              {entry.details.output}
                            </pre>
                          </div>
                        </div>
                      )}

                      {/* Error */}
                      {entry.error && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Error</div>
                          <div className="bg-port-error/10 border border-port-error/30 rounded-lg p-3">
                            <pre className="text-sm text-port-error font-mono whitespace-pre-wrap">
                              {entry.error}
                            </pre>
                          </div>
                        </div>
                      )}

                      {/* Other Details */}
                      {entry.details && Object.keys(entry.details).filter(k => !['command', 'output', 'runtime', 'exitCode'].includes(k)).length > 0 && (
                        <div>
                          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Additional Details</div>
                          <div className="bg-port-card border border-port-border rounded-lg p-3">
                            <pre className="text-xs text-gray-400 font-mono whitespace-pre-wrap">
                              {JSON.stringify(
                                Object.fromEntries(
                                  Object.entries(entry.details).filter(([k]) => !['command', 'output', 'runtime', 'exitCode'].includes(k))
                                ),
                                null,
                                2
                              )}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default HistoryPage;
