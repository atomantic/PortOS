import { ListPlus, MonitorOff, Sparkles, X } from 'lucide-react';

/**
 * Generate / Cancel and "Add to queue", sticky on phones, with the enqueue
 * caption, unrestorable-reference warning, display-sleep warning and the live
 * progress line. `run` is `useVideoGenRun()`; `gates` is `useVideoGenSubmitGates()`.
 */
export default function VideoGenPrimaryActions({ run, gates, onEnqueue, unavailableReferenceImageNames, rendersSleepDisplay }) {
  const { generating, handleCancel, progressPct, error, statusMsg } = run;
  const { canEnqueue, generateTitle, queueTitle, optionsHint, effectiveBatchSize } = gates;
  return (
    <div
      className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-y border-port-border bg-port-card/95 px-4 py-2 backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
      data-testid="video-primary-actions"
    >
      {generating ? (
        <button
          type="button"
          onClick={handleCancel}
          className="flex min-h-[44px] items-center gap-2 rounded-lg bg-port-error px-4 py-2 text-sm font-medium text-white hover:bg-port-error/80"
        >
          <X className="w-4 h-4" /> Cancel
        </button>
      ) : (
        <button
          type="submit"
          disabled={!canEnqueue}
          className="flex min-h-[44px] items-center gap-2 rounded-lg bg-port-accent px-4 py-2 text-sm font-medium text-white hover:bg-port-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
          title={generateTitle}
        >
          <Sparkles className="w-4 h-4" /> {effectiveBatchSize > 1 ? `Generate ${effectiveBatchSize} videos` : 'Generate'}
        </button>
      )}
      <button
        type="button"
        onClick={onEnqueue}
        disabled={!canEnqueue}
        className="flex min-h-[44px] items-center gap-2 rounded-lg border border-port-border px-4 py-2 text-sm font-medium text-gray-200 hover:bg-port-border/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        title={queueTitle}
      >
        <ListPlus className="w-4 h-4" /> {effectiveBatchSize > 1 ? `Add ${effectiveBatchSize} videos to queue` : 'Add to queue'}
      </button>
      {optionsHint && (
        <span className="basis-full text-xs text-port-warning" role="status">{optionsHint}</span>
      )}
      {unavailableReferenceImageNames.length > 0 && (
        <p role="status" className="basis-full text-xs text-port-warning">
          The restored render used references that cannot be restored here: {unavailableReferenceImageNames.join(', ')}. Choose replacements or use the Music Video project.
        </p>
      )}
      {/* Said BEFORE the button is pressed, not after the screen is already
          dark. A user who first learns about the sleep by watching their
          display go black reads it as a crash and wakes it — which puts
          WindowServer back in contention with Metal and risks the GPU
          watchdog panic the sleep exists to avoid. */}
      {rendersSleepDisplay && !generating && (
        <p className="flex items-start gap-1.5 text-[11px] text-port-warning">
          <MonitorOff className="w-3.5 h-3.5 mt-px shrink-0" />
          <span>
            This render will put your display to sleep. The screen will go dark shortly
            after you start — that is expected, and waking it can crash the render. Uncheck
            “Sleep display during this render” in Options to keep the screen on.
          </span>
        </p>
      )}
      {progressPct != null && <span className="text-xs text-port-accent">{progressPct}%</span>}
      {(generating || error) && (
        <span role="status" className={`text-xs truncate ${error ? 'text-port-error' : 'text-gray-400'}`}>
          {error || statusMsg || 'Working...'}
        </span>
      )}
    </div>
  );
}
