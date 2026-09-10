/**
 * "Queue agent to investigate" action for an installer failure (#5981).
 *
 * An install error used to be a dead end — Close was the only affordance — even
 * though PortOS already owns an autonomous-agent queue. This button builds a
 * reproducible task from the installer name, the failing stage, the error and
 * the streamed log tail, and hands it to the generic `QueueInvestigationButton`
 * (which owns queueing, dedup, and the button states — shared with other
 * failure surfaces like the DOM-selector test).
 *
 * Rendered by `InstallErrorFooter` (both install modals) and directly by
 * `LocalSetupPanel`, which draws its own error region.
 */

import { buildInstallFailureTask } from '../../lib/installFailureTask';
import QueueInvestigationButton from '../ui/QueueInvestigationButton';

export default function QueueInstallInvestigationButton({
  label,
  stage,
  error,
  logs,
  surface,
  className = '',
}) {
  const task = buildInstallFailureTask({ label, stage, error, logs, surface });
  return <QueueInvestigationButton task={task} className={className} />;
}
