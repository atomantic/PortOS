import { useState, useEffect, useMemo } from 'react';
import * as api from '../../../services/api';
import { RefreshCw, Clock } from 'lucide-react';
import { timeAgo } from '../../../utils/formatters';

export default function LogTab({ vaultId, allNotes }) {
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(true);

  const logExists = allNotes?.some(n => n.path === 'wiki/log.md');

  useEffect(() => {
    if (logExists) loadLog();
    else { setLog(null); setLoading(false); }
  }, [vaultId, logExists]);

  const loadLog = async () => {
    setLoading(true);
    const data = await api.getNote(vaultId, 'wiki/log.md').catch(() => null);
    setLog(data?.error ? null : data);
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  if (!log) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-500">
        <Clock size={32} className="mb-2 opacity-30" />
        <p className="text-sm">No activity log found</p>
        <p className="text-xs mt-1">The log is created automatically during wiki operations</p>
      </div>
    );
  }

  const entries = useMemo(() => {
    const result = [];
    const lines = (log.body || log.content || '').split('\n');
    let currentEntry = null;

    for (const line of lines) {
      const match = line.match(/^## \[(\d{4}-\d{2}-\d{2})\] (\w+) \| (.+)$/);
      if (match) {
        if (currentEntry) result.push(currentEntry);
        currentEntry = {
          date: match[1],
          type: match[2],
          title: match[3],
          details: []
        };
      } else if (currentEntry && line.trim() && !line.startsWith('# ') && !line.startsWith('---')) {
        currentEntry.details.push(line);
      }
    }
    if (currentEntry) result.push(currentEntry);
    result.reverse();
    return result;
  }, [log]);

  const typeColors = {
    init: 'text-port-accent',
    ingest: 'text-port-success',
    query: 'text-port-warning',
    lint: 'text-purple-400',
    update: 'text-cyan-400'
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-white">Activity Log</h3>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>{entries.length} entries</span>
          {log.modifiedAt && <span>Updated {timeAgo(log.modifiedAt)}</span>}
          <button onClick={loadLog} className="p-1 rounded hover:bg-port-card text-gray-500 hover:text-white">
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {entries.length === 0 ? (
          <div className="text-center py-8 text-gray-500 text-sm">No log entries yet</div>
        ) : entries.map((entry, i) => (
          <div key={i} className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-xs text-gray-500 font-mono">{entry.date}</span>
              <span className={`px-1.5 py-0.5 rounded text-xs font-medium uppercase ${typeColors[entry.type] || 'text-gray-400'} bg-port-bg`}>
                {entry.type}
              </span>
              <span className="text-sm text-white font-medium">{entry.title}</span>
            </div>
            {entry.details.length > 0 && (
              <div className="text-xs text-gray-400 space-y-0.5 ml-1">
                {entry.details.map((line, j) => (
                  <div key={j}>{line}</div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
