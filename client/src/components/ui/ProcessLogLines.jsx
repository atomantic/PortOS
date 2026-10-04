import { formatTimeOfDaySeconds } from '../../utils/formatters';

// Status strings mirror `useProcessLogs`' LOG_STREAM_STATUS; kept as literals so
// this presentational file doesn't import the socket-bound hook module.
const CONNECTING = 'connecting';
const LIVE = 'live';
const isUnavailable = (status) => status != null && status !== CONNECTING && status !== LIVE;

/** Short header label for a log stream's state: streaming when live, an "unavailable" tag when it ended. */
export function LogStreamBadge({ status, className = 'text-xs' }) {
  if (status === LIVE) return <span className={`${className} text-port-success`}>● streaming</span>;
  if (isUnavailable(status)) return <span className={`${className} text-port-warning`}>● unavailable</span>;
  return null;
}

function UnavailableNotice({ detail, onRetry }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 text-port-warning">
      <span>Log stream unavailable{detail ? ` — ${detail}` : ''}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="px-2 py-0.5 text-xs bg-port-card border border-port-border rounded text-white hover:bg-port-border transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * Renders a PM2 process's log lines (the body of a log pane).
 *
 * Shared by every surface that tails a process via `useProcessLogs` — the
 * Processes tab's inline and fullscreen panes, and the desktop launch-progress
 * panel — so the empty-state copy and the stdout/stderr coloring stay identical.
 * The caller owns the scroll container and its ref; this only renders content.
 *
 * @param {object} props
 * @param {Array<{line: string, type: string, timestamp: number}>} props.logs
 * @param {'connecting'|'live'|'closed'|'error'|'disconnected'} props.status Stream state from
 *   `useProcessLogs` — distinguishes "not connected yet" from "connected but the process hasn't
 *   written anything" from "the stream ended" (closed/error/disconnected show an unavailable
 *   notice, keep any captured lines, and offer `onRetry`).
 * @param {string|null} [props.statusDetail] Why a terminal stream ended.
 * @param {() => void} [props.onRetry] Manual resubscribe for an unavailable stream.
 * @param {boolean} [props.showTimestamps=false] Prefix each line with its local time.
 * @param {string} [props.timestampGap='mr-2'] Spacing after the timestamp.
 */
export default function ProcessLogLines({ logs, status, statusDetail, onRetry, showTimestamps = false, timestampGap = 'mr-2' }) {
  const unavailable = isUnavailable(status);
  if (logs.length === 0) {
    if (unavailable) return <UnavailableNotice detail={statusDetail} onRetry={onRetry} />;
    return (
      <div className="text-gray-500">
        {status === LIVE ? 'Waiting for output…' : 'Connecting to log stream…'}
      </div>
    );
  }

  const rows = logs.map((log, i) => (
    <div
      key={`${log.timestamp}-${i}`}
      className={`py-0.5 whitespace-pre-wrap break-all ${log.type === 'stderr' ? 'text-port-error' : 'text-gray-300'}`}
    >
      {showTimestamps && (
        <span className={`text-gray-600 ${timestampGap}`}>
          {formatTimeOfDaySeconds(log.timestamp)}
        </span>
      )}
      {log.line}
    </div>
  ));
  return unavailable
    ? <>{rows}<UnavailableNotice detail={statusDetail} onRetry={onRetry} /></>
    : rows;
}
