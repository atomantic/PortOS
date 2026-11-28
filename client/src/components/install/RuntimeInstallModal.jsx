/**
 * Runtime installer modal for BYO local generation runtimes. Streams progress
 * from a setup endpoint (SSE) and shows raw bash output line-by-line so the
 * user sees git/uv/pip progress while scripts/setup-image-video.sh runs.
 *
 * Closing the modal mid-install terminates its EventSource or fetch stream,
 * which the server interprets as a cancel and SIGTERMs the underlying child.
 */

import { useEffect, useId, useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle, Download, X } from 'lucide-react';
import { useInstallStream } from '../../hooks/useInstallStream';
import Modal from '../ui/Modal';
import InstallErrorFooter from './InstallErrorFooter';

const MAX_LOG_LINES = 1000;

function InstallStages({ stages, currentStage, done, error }) {
  const stageIdx = stages.findIndex(({ id }) => id === currentStage);
  return (
    <div className="px-5 py-4 border-b border-port-border bg-port-bg/40">
      <div className="flex items-center justify-between gap-2">
        {stages.map(({ id, label }, i) => {
          const isDone = done || stageIdx > i;
          const isCurrent = !done && stageIdx === i && !error;
          const isFailed = error && stageIdx === i;
          return (
            <div key={id} aria-current={isCurrent ? 'step' : undefined} className="flex-1 flex flex-col items-center">
              <div className="flex items-center w-full">
                <div
                  className={`flex items-center justify-center w-8 h-8 rounded-full border-2 transition-colors ${
                    isFailed
                      ? 'border-port-error bg-port-error/20 text-port-error'
                      : isDone
                        ? 'border-port-success bg-port-success/20 text-port-success'
                        : isCurrent
                          ? 'border-port-accent bg-port-accent/20 text-port-accent'
                          : 'border-port-border bg-port-bg text-gray-500'
                  }`}
                >
                  {isFailed ? (
                    <AlertCircle size={16} />
                  ) : isDone ? (
                    <CheckCircle2 size={16} />
                  ) : isCurrent ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <span className="text-[10px] font-bold">{i + 1}</span>
                  )}
                </div>
                {i < stages.length - 1 && (
                  <div
                    className={`flex-1 h-0.5 mx-1 transition-colors ${
                      isDone ? 'bg-port-success' : 'bg-port-border'
                    }`}
                  />
                )}
              </div>
              <span
                className={`mt-2 text-[10px] text-center leading-tight ${
                  isCurrent ? 'text-port-accent font-medium' : 'text-gray-400'
                }`}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function RuntimeInstallModal({
  open,
  runtime,
  label,
  // Heading + completion prose. Defaults read as an install because that is
  // what every original caller does; a caller whose action is "start this
  // daemon" passes its own so the modal doesn't claim an install that isn't
  // happening.
  title,
  onClose,
  onComplete,
  installUrl,
  installUrlBase = '/api/video-gen/setup/runtime-install',
  description = 'Cloning repo and installing python packages (large download on first run)...',
  // Extra query params for installers that support modes beyond a first-time run
  // (e.g. TRELLIS.2's `repair=1`, which re-runs setup.sh over an existing install
  // to rebuild backends that failed to compile the first time — #2952).
  params,
  // Runtime actions mutate host state, so the shared default uses POST via the
  // hook's fetch-stream mode. GET installer URLs remain read-only status aliases.
  streamMethod = 'POST',
  // Chatty installers keep the rendered log stable by batching lines.
  flushMs = 100,
  // The footer line once the stream completes. Defaults to "is ready", which is
  // true of an install — and false of a REMOVAL, where it would sit directly
  // under a log line saying the runtime was just deleted. A caller whose action
  // is not an install passes its own.
  doneText,
  stages,
  errorMessage,
  surface = 'client/src/components/install/RuntimeInstallModal.jsx',
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const titleId = useId();
  const query = new URLSearchParams({ runtime: runtime ?? '', ...params });
  const url = open ? installUrl || (runtime ? `${installUrlBase}?${query}` : null) : null;
  const { logs, currentStage, done, error, streamStarted, logsEndRef, close } = useInstallStream(
    url,
    { enabled: !!url, onComplete, maxLogLines: MAX_LOG_LINES, flushMs, method: streamMethod },
  );

  useEffect(() => { setConfirmingCancel(false); }, [url]);

  const hasStages = stages?.length > 0;
  const installRunning = streamStarted && !done && !error;

  const performClose = () => {
    close();
    setConfirmingCancel(false);
    onClose();
  };

  const handleClose = () => {
    if (installRunning) { setConfirmingCancel(true); return; }
    performClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="lg"
      align="top"
      zIndexClassName="z-[9999]"
      closeOnEsc={false}
      backdropClassName="bg-black/70 backdrop-blur-sm"
      ariaLabelledBy={titleId}
      panelClassName="bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden flex flex-col"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-port-border">
          <div className="flex items-center gap-2.5">
            {done ? <CheckCircle2 size={18} className="text-port-success" />
              : error ? <AlertCircle size={18} className="text-port-error" />
              : <Download size={18} className="text-port-accent" />}
            <h2 id={titleId} className="text-sm font-semibold text-white">
              {title || `Installing ${label || runtime}`}
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-white p-1 min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Close installer"
          >
            <X size={18} />
          </button>
        </div>

        {hasStages && (
          <InstallStages stages={stages} currentStage={currentStage} done={done} error={error} />
        )}

        <div className="flex-1 overflow-auto bg-port-bg px-4 py-3 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 ? (
            <div className="text-gray-500 italic flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" />
              Connecting to installer...
            </div>
          ) : (
            logs.map((entry, i) => (
              <div
                key={i}
                className={
                  hasStages && entry.kind === 'stage' ? 'text-port-accent font-semibold mt-1'
                  : entry.kind === 'success' ? 'text-port-success font-semibold'
                  : entry.kind === 'error' ? 'text-port-error'
                  : 'text-gray-400'
                }
              >
                {hasStages && entry.kind === 'stage' && '▸ '}
                {entry.text}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>

        <div className="px-5 py-3 border-t border-port-border flex items-center justify-between gap-3">
          {confirmingCancel && installRunning ? (
            <>
              <span className="text-xs text-port-warning">
                Cancel the install? In-progress downloads will stop.
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmingCancel(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-port-border text-gray-300 hover:bg-port-border/70"
                >
                  Keep installing
                </button>
                <button
                  onClick={performClose}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-port-error text-white hover:bg-port-error/80"
                >
                  Yes, cancel
                </button>
              </div>
            </>
          ) : error ? (
            <InstallErrorFooter
              message={errorMessage || error}
              label={label || runtime}
              stage={currentStage}
              error={error}
              logs={logs}
              surface={surface}
              onClose={handleClose}
            />
          ) : (
            <>
              <span className="text-xs text-gray-400">
                {done
                  ? (doneText || `${label || runtime} is ready.`) + ' You can close this window.'
                  : description}
              </span>
              <button
                onClick={handleClose}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  done
                    ? 'bg-port-success text-white hover:bg-port-success/80'
                    : 'bg-port-border text-gray-300 hover:bg-port-border/70'
                }`}
              >
                {done ? 'Done' : 'Cancel'}
              </button>
            </>
          )}
        </div>
    </Modal>
  );
}
