import { Loader2, WifiOff } from 'lucide-react';

/**
 * Shown while a series run's progress stream is detached (`recovery` from
 * `useSeriesRunLifecycle`). Cancel stays in the page header; this banner owns
 * the observation-recovery actions: Reattach (run still active on the server)
 * or Retry status (the status read failed). Renders nothing when attached.
 */
export default function RunRecoveryBanner({ recovery, cancelPending, noun, onReattach, onRetryStatus }) {
  if (!recovery) return null;
  const checking = recovery === 'checking';
  let message;
  if (checking) message = `Progress disconnected — checking whether the ${noun} run is still going…`;
  else if (recovery === 'disconnected') {
    message = cancelPending
      ? `Cancel requested — the ${noun} run is still settling on the server, but progress is disconnected.`
      : `Progress disconnected — the ${noun} run is still going on the server.`;
  } else message = `Progress disconnected and the ${noun} run status could not be read.`;

  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg border border-port-warning/40 bg-port-warning/10 text-port-warning text-sm"
    >
      {checking ? <Loader2 size={14} className="animate-spin shrink-0" /> : <WifiOff size={14} className="shrink-0" />}
      <span className="min-w-0 flex-1">{message}</span>
      {recovery === 'disconnected' ? (
        <button
          type="button"
          onClick={onReattach}
          className="px-2.5 py-1 rounded border border-port-warning/50 text-xs font-medium hover:bg-port-warning/20"
        >
          Reattach
        </button>
      ) : null}
      {recovery === 'unknown' ? (
        <button
          type="button"
          onClick={onRetryStatus}
          className="px-2.5 py-1 rounded border border-port-warning/50 text-xs font-medium hover:bg-port-warning/20"
        >
          Retry status
        </button>
      ) : null}
    </div>
  );
}
