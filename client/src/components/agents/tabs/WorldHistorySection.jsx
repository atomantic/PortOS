import BrailleSpinner from '../../BrailleSpinner';
import ListLoadError from '../../ui/ListLoadError';
import { timeAgo } from '../../../utils/formatters';
import { WORLD_ACTION_ICONS, summarizeWorldAction } from './worldActionDisplay';

const HISTORY_FILTERS = [
  { value: '', label: 'All' },
  { value: 'mw_explore', label: 'Explore' },
  { value: 'mw_think', label: 'Think' },
  { value: 'mw_say', label: 'Say' },
  { value: 'mw_build', label: 'Build' },
  { value: 'mw_heartbeat', label: 'Heartbeat' }
];

export default function WorldHistorySection({
  history, historyLoading, historyHasMore, historyFilter, historyLoadFailed,
  setHistoryFilter, fetchHistory, handleLoadMoreHistory
}) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-semibold text-white min-w-0">Activity History</h3>
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <select
            aria-label="Filter history"
            value={historyFilter}
            onChange={e => setHistoryFilter(e.target.value)}
            className="min-w-0 pointer-coarse:min-h-11 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
          >
            {HISTORY_FILTERS.map(f => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <button
            onClick={() => fetchHistory()}
            disabled={historyLoading}
            className="pointer-coarse:min-h-11 px-2 py-1 text-xs bg-port-border text-gray-300 rounded hover:bg-port-border/80 disabled:opacity-50"
          >
            {historyLoading ? '...' : 'Refresh'}
          </button>
        </div>
      </div>
      {historyLoadFailed && !historyLoading && (
        <ListLoadError what="activity history" onRetry={() => fetchHistory()} className="mb-2" />
      )}
      {history.length === 0 ? (
        !(historyLoadFailed && !historyLoading) && (
          <p className="text-sm text-gray-500 text-center py-4">
            {historyLoading ? <BrailleSpinner text="Loading" /> : 'No activity history yet'}
          </p>
        )
      ) : (
        <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
          {history.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2 p-2 bg-port-bg rounded text-xs">
              <span className="shrink-0 text-sm">{WORLD_ACTION_ICONS[entry.action] || '📋'}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="px-1.5 py-0.5 bg-port-border rounded text-gray-300 font-medium">
                    {entry.action?.replace('mw_', '')}
                  </span>
                  <span className={`px-1 py-0.5 rounded text-[10px] ${entry.status === 'completed' ? 'bg-port-success/20 text-port-success' : 'bg-port-error/20 text-port-error'}`}>
                    {entry.status}
                  </span>
                  {entry.params?.via === 'ws' && (
                    <span className="text-[10px] text-port-accent">WS</span>
                  )}
                </div>
                <p className="text-gray-400 truncate mt-0.5">
                  {summarizeWorldAction(entry.action, entry.params)}
                </p>
              </div>
              <span className="text-gray-600 shrink-0 text-[10px]" title={entry.timestamp}>
                {timeAgo(entry.timestamp)}
              </span>
            </div>
          ))}
          {historyHasMore && (
            <button
              onClick={handleLoadMoreHistory}
              disabled={historyLoading}
              className="w-full py-2 text-xs text-gray-400 hover:text-white bg-port-bg rounded disabled:opacity-50"
            >
              {historyLoading ? <BrailleSpinner text="Loading" /> : 'Load More'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
