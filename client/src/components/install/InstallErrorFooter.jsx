/**
 * Shared modal footer for a failed install (#5981).
 *
 * `Flux2InstallModal` and `RuntimeInstallModal` each hand-rolled the same
 * "message + Close" error footer, so adding the agent-investigation action to
 * both would have made a third copy of the same row. Both render this instead
 * whenever `useInstallStream` reports an `error`.
 *
 * Returns the footer row's CONTENT (message on the left, actions on the right)
 * so each modal keeps its own footer container and spacing.
 */

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
