import { Loader2, Square, Check, AlertTriangle } from 'lucide-react';

// WritersRoomDock — fixed-bottom run queue strip. Renders only when there are
// active or recently-finished jobs in `queue`; auto-hides otherwise.
// `queue` shape: [{ jobId, sceneId, sceneLabel, status, progress, eta }].
//
// Mounted at WritersRoom layer (per page) — NOT in the global Layout footer.
// Kept narrow so it doesn't dominate the page when one or two scenes are
// rendering, expands inline as more queue up.
export default function WritersRoomDock({
  queue = [],
  renderingCount = 0,
  cancelingCount = 0,
  activeCount = renderingCount + cancelingCount,
  onStopAll,
  onStopOne,
}) {
  if (!queue.length) return null;
  // Three distinct user-facing states, in priority order: actively rendering
  // → canceling → done. Showing "Rendering N" while N jobs are canceling
  // would be misleading.
  const statusLabel = renderingCount > 0
    ? `Rendering ${renderingCount} scene${renderingCount === 1 ? '' : 's'}`
    : cancelingCount > 0
      ? `Canceling ${cancelingCount} scene${cancelingCount === 1 ? '' : 's'}…`
      : 'Renders complete';
  return (
    <section
      aria-label="Image render queue"
      className="fixed bottom-0 left-0 right-0 z-30 border-t border-port-border bg-port-card/95 backdrop-blur-sm shadow-[0_-4px_18px_-8px_rgba(0,0,0,0.6)] pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex items-center gap-3 px-3 py-2 max-w-7xl mx-auto">
        <div className="flex items-center gap-2 shrink-0">
          {activeCount > 0
            ? <Loader2 size={12} className="animate-spin text-port-accent" />
            : <Check size={12} className="text-port-success" />
          }
          {/* aria-live lives on this small non-interactive label only — putting
              it on the dock container made screen readers re-announce the
              cancel buttons every progress tick. */}
          <span
            role="status"
            aria-live="polite"
            className="text-[11px] font-semibold text-white"
          >
            {statusLabel}
          </span>
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto">
          {queue.map((q) => <DockItem key={q.jobId} item={q} onStop={onStopOne} />)}
        </div>
        {/* Only offer Stop-all while rows are still actively rendering — once
            everything is canceling there's nothing left to stop. */}
        {renderingCount > 0 && (
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
    </section>
  );
}

function DockItem({ item, onStop }) {
  const { sceneLabel, status, progress, eta } = item;
  const pct = typeof progress === 'number' ? Math.round(progress * 100) : 0;
  const tone =
    status === 'error' ? 'border-port-error/60 text-port-error'
    : status === 'done' ? 'border-port-success/60 text-port-success'
    : status === 'canceling' ? 'border-port-warning/60 text-port-warning'
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
      {status === 'canceling' && (
        <span className="text-[9px] uppercase tracking-wider text-port-warning">Canceling…</span>
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
