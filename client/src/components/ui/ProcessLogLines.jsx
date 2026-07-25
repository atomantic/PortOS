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
 * @param {boolean} props.subscribed Whether the stream is connected — distinguishes
 *   "not connected yet" from "connected but the process hasn't written anything".
 * @param {boolean} [props.showTimestamps=false] Prefix each line with its local time.
 * @param {string} [props.timestampGap='mr-2'] Spacing after the timestamp.
 */
export default function ProcessLogLines({ logs, subscribed, showTimestamps = false, timestampGap = 'mr-2' }) {
  if (logs.length === 0) {
    return (
      <div className="text-gray-500">
        {subscribed ? 'Waiting for output…' : 'Connecting to log stream…'}
      </div>
    );
  }

  return logs.map((log, i) => (
    <div
      key={`${log.timestamp}-${i}`}
      className={`py-0.5 whitespace-pre-wrap break-all ${log.type === 'stderr' ? 'text-port-error' : 'text-gray-300'}`}
    >
      {showTimestamps && (
        <span className={`text-gray-600 ${timestampGap}`}>
          {new Date(log.timestamp).toLocaleTimeString()}
        </span>
      )}
      {log.line}
    </div>
  ));
}
