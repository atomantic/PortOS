import { formatDateTime } from '../../../../utils/formatters';
import { formatSkipCauses } from '../../../../lib/perpetualSkipCauses';
import { TASK_READINESS_REASON } from '../../../../../../server/lib/taskReadinessReasons.js';

// Drain/park line for a perpetual task that rechecks itself. Returns null when
// there is nothing to say (no per-app aggregate and a non-perpetual global status).
export default function PerpetualStatusSummary({ config, status }) {
  // claim-issue/claim-work park PER-APP, so prefer the per-app aggregate
  // (config.perpetualStatus) over the global status.reason — which always
  // reads 'perpetual-drain' for app-scoped tasks even when every app is parked.
  const p = config.perpetualStatus;
  // A stall (the forge CLI has failed several evaluations in a row) can
  // coexist with an apparently-healthy "Draining" line — the gate skips
  // WITHOUT parking on purpose, so nothing else here would ever surface
  // it. Render it ahead of the park/drain line rather than instead of it.
  const stall = p?.stall;
  const stallNote = stall ? (
    <p className="text-xs text-port-warning mt-1">
      Probe failing{stall.cli ? ` (${stall.cli})` : ''}: {stall.reason}{stall.detail ? ` — ${stall.detail}` : ''}
      {' '}({stall.consecutive} consecutive)
    </p>
  ) : null;
  if (p && (p.trackedAppCount > 0 || p.globalParked)) {
    const allParked = p.globalParked || (p.trackedAppCount > 0 && p.parkedAppCount === p.trackedAppCount);
    if (allParked) {
      const scope = p.trackedAppCount > 0 ? `${p.trackedAppCount} app(s) parked` : 'Parked';
      const skipSummary = formatSkipCauses(p.parkSkipCauses);
      return (
        <>
          {stallNote}
          <p className="text-xs text-port-warning mt-1">
            {scope}{p.parkReason ? ` (${p.parkReason})` : ''}{skipSummary ? ` — ${skipSummary}` : ''}{p.nextRecheckAt ? ` — next recheck ${formatDateTime(p.nextRecheckAt)}` : ''}
          </p>
        </>
      );
    }
    const partial = p.parkedAppCount > 0 ? ` — ${p.parkedAppCount}/${p.trackedAppCount} app(s) parked` : '';
    return (
      <>
        {stallNote}
        <p className="text-xs text-port-success mt-1">Draining — actionable work available{partial}</p>
      </>
    );
  }
  // Global (non-app) perpetual task: the global status.reason is accurate.
  if (status.reason === TASK_READINESS_REASON.PERPETUAL_PARKED) {
    const skipSummary = formatSkipCauses(status.parkSkipCauses);
    return (
      <>
        {stallNote}
        <p className="text-xs text-port-warning mt-1">
          Parked{status.parkReason ? ` (${status.parkReason})` : ''}{skipSummary ? ` — ${skipSummary}` : ''}{status.nextRunAt ? ` — rechecks ${formatDateTime(status.nextRunAt)}` : ''}
        </p>
      </>
    );
  }
  if (status.reason === TASK_READINESS_REASON.PERPETUAL_DRAIN || status.reason === TASK_READINESS_REASON.PERPETUAL_RECHECK) {
    return (
      <>
        {stallNote}
        <p className="text-xs text-port-success mt-1">Draining — actionable work available</p>
      </>
    );
  }
  return stallNote;
}
