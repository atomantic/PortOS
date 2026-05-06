import { Loader2, Square, Check, AlertTriangle } from 'lucide-react';

// WritersRoomDock — fixed-bottom run queue strip. Renders only when there are
// active or recently-finished jobs in `queue`; auto-hides otherwise.
// `queue` shape: [{ jobId, sceneId, sceneLabel, status, progress, eta }].
//
// Mounted at WritersRoom layer (per page) — NOT in the global Layout footer.
// Kept narrow so it doesn't dominate the page when one or two scenes are
// rendering, expands inline as more queue up.
export default function WritersRoomDock({ queue = [], runningCount = 0, onStopAll, onStopOne }) {
  if (!queue.length) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-0 left-0 right-0 z-30 border-t border-port-border bg-port-card/95 backdrop-blur-sm shadow-[0_-4px_18px_-8px_rgba(0,0,0,0.6)]"
    >
      <div className="flex items-center gap-3 px-3 py-2 max-w-7xl mx-auto">
        <div className="flex items-center gap-2 shrink-0">
          {runningCount > 0
            ? <Loader2 size={12} className="animate-spin text-port-accent" />
            : <Check size={12} className="text-port-success" />
          }
          <span className="text-[11px] font-semibold text-white">
            {runningCount > 0
              ? `Rendering ${runningCount} scene${runningCount === 1 ? '' : 's'}`
              : 'Renders complete'
            }
          </span>
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto">
          {queue.map((q) => <DockItem key={q.jobId} item={q} onStop={onStopOne} />)}
        </div>
        {runningCount > 0 && (
          <button
            type="button"
            onClick={onStopAll}
            className="shrink-0 flex items-center gap-1 px-2.5 py-1 bg-port-error/15 border border-port-error/40 text-port-error rounded text-[11px] hover:bg-port-error/25"
            title="Cancel every queued and in-flight render"
          >
            <Square size={11} /> Stop all
          </button>
        )}
      </div>
    </div>
  );
}

function DockItem({ item, onStop }) {
  const { sceneLabel, status, progress, eta } = item;
  const pct = typeof progress === 'number' ? Math.round(progress * 100) : 0;
  const tone =
    status === 'error' ? 'border-port-error/60 text-port-error'
    : status === 'done' ? 'border-port-success/60 text-port-success'
    : status === 'running' ? 'border-port-accent/60 text-gray-200'
    : 'border-port-border text-gray-300';
  return (
    <div className={`relative shrink-0 flex items-center gap-2 px-2.5 py-1 rounded-md border ${tone} bg-port-bg/40 text-[11px] min-w-[180px] max-w-[280px]`}>
      <span className="truncate flex-1" title={sceneLabel}>{sceneLabel}</span>
      {status === 'queued' && <span className="text-[9px] uppercase tracking-wider text-gray-500">Queued</span>}
      {status === 'running' && (
        <>
          <span className="text-[10px] tabular-nums text-gray-400">{pct}%</span>
          {eta != null && <span className="text-[10px] text-gray-500">~{Math.max(0, Math.round(eta))}s</span>}
        </>
      )}
      {status === 'done' && <Check size={10} />}
      {status === 'error' && <AlertTriangle size={10} />}
      {(status === 'queued' || status === 'running') && (
        <button
          type="button"
          onClick={() => onStop?.(item.jobId)}
          className="ml-1 text-gray-500 hover:text-port-error"
          title="Cancel this render"
          aria-label={`Cancel ${sceneLabel}`}
        >
          <Square size={10} />
        </button>
      )}
      {status === 'running' && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-port-accent/20 rounded-b-md overflow-hidden">
          <div className="h-full bg-port-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
