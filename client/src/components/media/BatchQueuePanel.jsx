import { Trash2, CheckCircle2, AlertCircle, Loader2, Clock } from 'lucide-react';

// Shared batch-queue panel used by both Video Gen and Image Gen. The owner
// page tracks queue state and the worker effect; this component is
// presentation-only — it renders the list, status icons, and the
// remove/clear-completed affordances.
//
// Each item is { id, status: 'pending'|'running'|'complete'|'error',
// params: { prompt, mode, ... }, error?, ... }. `summarize` lets the host
// page format the per-item subtitle line however it wants (e.g. video
// shows resolution+frames, image shows resolution+steps).

const STATUS_ICON = {
  pending: { Icon: Clock, color: 'text-gray-400' },
  running: { Icon: Loader2, color: 'text-port-accent animate-spin' },
  complete: { Icon: CheckCircle2, color: 'text-port-success' },
  error: { Icon: AlertCircle, color: 'text-port-error' },
};

export default function BatchQueuePanel({ queue, inFlightCount, onRemove, onClear, summarize }) {
  if (!queue.length) return null;
  const completedCount = queue.filter((q) => q.status === 'complete' || q.status === 'error').length;
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">
          Batch queue
          <span className="ml-2 text-xs text-gray-500">
            {inFlightCount > 0 ? `${inFlightCount} in flight` : 'idle'}
          </span>
        </h2>
        {completedCount > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-gray-400 hover:text-white"
          >
            Clear completed ({completedCount})
          </button>
        )}
      </div>
      <ul className="space-y-2 max-h-72 overflow-y-auto">
        {queue.map((item) => {
          const { Icon, color } = STATUS_ICON[item.status] || STATUS_ICON.pending;
          return (
            <li
              key={item.id}
              className="flex items-center gap-3 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-xs"
            >
              <Icon className={`w-4 h-4 flex-shrink-0 ${color}`} />
              <div className="flex-1 min-w-0">
                <div className="text-gray-200 truncate">{item.params.prompt}</div>
                <div className="text-gray-500 text-[11px] truncate">
                  {summarize(item)}
                  {item.error && <span className="text-port-error ml-2">— {item.error}</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                disabled={item.status === 'running'}
                className="p-1 text-gray-500 hover:text-port-error disabled:opacity-30 disabled:cursor-not-allowed"
                title={item.status === 'running' ? 'Cancel via the form button' : 'Remove from queue'}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
