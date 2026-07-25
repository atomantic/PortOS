import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import ProcessLogLines from '../ui/ProcessLogLines';
import { useProcessLogs } from '../../hooks/useProcessLogs';

/**
 * Live build/launch output for a desktop (portless GUI) app.
 *
 * A web server binds its port in milliseconds; a desktop app's start command
 * compiles the project and imports assets first, so the window can be tens of
 * seconds away while PM2 already reports `online`. Without this the Start button
 * settles instantly and the app reads as hung. Streaming the process log is the
 * honest progress signal — there is no percentage to report, but visible output
 * proves work is happening.
 *
 * Dismissible: the panel is informational, so closing it must not stop the
 * launch. Unmounting only tears down the log subscription.
 *
 * @param {object} props
 * @param {string} props.appId App whose PM2_HOME holds the process.
 * @param {string} props.processName PM2 process to tail.
 * @param {boolean} props.online Whether the process is up — flips the header
 *   copy from "Launching" to "Running" so a finished launch reads as done.
 * @param {() => void} props.onDismiss Close the panel (does not stop the app).
 */
export default function DesktopLaunchProgress({ appId, processName, online, onDismiss }) {
  const { logs, subscribed } = useProcessLogs(processName, { lines: 200, appId });
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logs]);

  return (
    <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-port-border">
        <div className="flex items-center gap-2 min-w-0">
          {!online && <BrailleSpinner />}
          <span className="text-sm text-white truncate">
            {online ? 'Running' : 'Launching'} — {processName}
          </span>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Hide launch output"
          className="text-gray-400 hover:text-white transition-colors shrink-0"
        >
          <X size={16} />
        </button>
      </div>

      <p className="px-4 pt-2 text-xs text-gray-500">
        {online
          ? 'The app is running. Closing its window stops it — that is a normal exit, not a crash.'
          : 'Building and importing assets. The window opens when this finishes — this can take a while on a cold build.'}
      </p>

      <div
        ref={scrollRef}
        className="m-4 mt-2 p-3 bg-port-bg border border-port-border rounded-lg font-mono text-xs h-48 overflow-y-auto"
      >
        <ProcessLogLines logs={logs} subscribed={subscribed} />
      </div>
    </div>
  );
}
