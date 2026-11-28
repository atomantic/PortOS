/** Render the runtime installer failure message and its investigation and close actions. */

import QueueInstallInvestigationButton from './QueueInstallInvestigationButton';

export default function InstallErrorFooter({
  message,
  label,
  stage,
  error,
  logs,
  surface,
  onClose,
}) {
  return (
    <>
      <span className="text-xs text-gray-400">{message}</span>
      <div className="flex items-center gap-2">
        <QueueInstallInvestigationButton
          label={label}
          stage={stage}
          error={error}
          logs={logs}
          surface={surface}
        />
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors bg-port-border text-white hover:bg-port-border/70"
        >
          Close
        </button>
      </div>
    </>
  );
}
