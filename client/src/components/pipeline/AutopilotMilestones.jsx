import { useMemo } from 'react';
import { CheckCircle2, Loader2, Circle, MinusCircle, AlertCircle } from 'lucide-react';
import {
  buildAutopilotMilestones,
  summarizeAutopilotMilestones,
  describeAutopilotVerification,
  autopilotStepLabel,
  isStoppedTerminal,
  MILESTONE_STATUS,
} from '../../lib/autopilotMilestones';
import ProgressBar from '../ui/ProgressBar';

// Per-status chrome in ONE table — icon and tones together, so a new status
// can't get a row color and no icon (or the reverse). `blocked` reuses the
// warning tone the pause banner uses, so the step a run stopped on reads the
// same in both places.
const STATUS_CHROME = {
  [MILESTONE_STATUS.DONE]: { Icon: CheckCircle2, row: 'text-gray-400', icon: 'text-port-success' },
  [MILESTONE_STATUS.ACTIVE]: { Icon: Loader2, row: 'text-white', icon: 'text-port-accent animate-spin' },
  [MILESTONE_STATUS.BLOCKED]: { Icon: AlertCircle, row: 'text-port-warning', icon: 'text-port-warning' },
  [MILESTONE_STATUS.SKIPPED]: { Icon: MinusCircle, row: 'text-gray-600', icon: 'text-gray-600' },
  [MILESTONE_STATUS.PENDING]: { Icon: Circle, row: 'text-gray-500', icon: 'text-gray-600' },
};

/**
 * The Autonomous-mode milestone map: every step the run projected at start, what
 * it has finished, what each gate validated, where it is now, and what is left.
 *
 * Renders for a live run AND for the plan a dry-run produced (which has no
 * progress yet — every row is pending, i.e. the old "dry-run plan" list). The
 * fold itself is pure and lives in `lib/autopilotMilestones.js`.
 */
export default function AutopilotMilestones({ plan, planTotals, progress, terminal, dryRun = false }) {
  const { rows, summary } = useMemo(() => {
    const built = buildAutopilotMilestones(plan, progress, { terminal });
    return { rows: built, summary: summarizeAutopilotMilestones(built) };
  }, [plan, progress, terminal]);
  if (!rows.length) return null;

  return (
    <div className="px-3 pb-3 border-t border-port-border pt-2 text-[11px] text-gray-400">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="uppercase tracking-wider text-gray-500">
          {dryRun ? 'Dry-run plan' : 'Story progress'}
        </span>
        {/* A dry-run has nothing to measure — it never ran a step. */}
        {!dryRun ? (
          <span className="text-gray-400">
            {summary.stepsDone} of {summary.steps} milestone(s) · {summary.percent}%
          </span>
        ) : null}
      </div>

      {/* Overall meter. A plan snapshot can under-count a step the run repeats,
          so this is honest about milestones settled — not a time estimate. */}
      {!dryRun ? (
        <ProgressBar
          percent={summary.percent}
          tone={isStoppedTerminal(terminal) ? 'warning' : 'accent'}
          label="Autopilot story progress"
          duration={500}
          className="mt-1.5"
        />
      ) : null}

      {/* Capped so a long plan (a comic series can project 16 milestones) can't
          push the readiness + schedule sections below the fold. */}
      <ul className="mt-2 space-y-1 max-h-72 overflow-y-auto">
        {rows.map((row) => {
          const verification = describeAutopilotVerification(row.kind, row.verification);
          const active = row.status === MILESTONE_STATUS.ACTIVE || row.status === MILESTONE_STATUS.BLOCKED;
          const { Icon, row: rowTone, icon: iconTone } = STATUS_CHROME[row.status];
          return (
            <li key={row.kind} className={rowTone}>
              <div className="flex items-start gap-1.5">
                <span className="mt-0.5"><Icon size={12} className={`${iconTone} shrink-0`} /></span>
                <span className={active ? 'font-medium' : ''}>{autopilotStepLabel(row.kind)}</span>
                {row.count > 1 ? (
                  <span className="text-gray-500 whitespace-nowrap">{row.done}/{row.count}</span>
                ) : null}
                {row.skipped > 0 ? (
                  <span className="text-gray-600 whitespace-nowrap">· {row.skipped} skipped</span>
                ) : null}
                {row.estActions > 0 && row.status === MILESTONE_STATUS.PENDING ? (
                  <span className="text-gray-600 ml-auto whitespace-nowrap">≈{row.estActions} act</span>
                ) : null}
              </div>
              {/* What the gate actually validated — the half of "progress" a
                  step counter can't show (a gate can complete with residual
                  findings the user still has to look at). */}
              {verification ? (
                <div className="ml-[18px] text-gray-500">{verification}</div>
              ) : null}
              {!verification && row.note && row.status === MILESTONE_STATUS.PENDING ? (
                <div className="ml-[18px] text-gray-600">{row.note}</div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* #1576 — estimated budget cost so a large series on a small daily cap can
          see, before starting, whether it will exhaust the cos action budget on
          text/verify and never reach editorial. */}
      {planTotals && (Number.isFinite(planTotals.estActions) || Number.isFinite(planTotals.estLlmCalls)) ? (
        <div className="mt-1.5 pt-1.5 border-t border-port-border/60 text-gray-400 flex items-center gap-1.5">
          <span className="uppercase tracking-wider text-gray-500">Est. budget</span>
          <span className="ml-auto whitespace-nowrap">
            ≈{planTotals.estActions || 0} cos action(s)
            {planTotals.estLlmCalls ? ` · ~${planTotals.estLlmCalls} editorial-check LLM call(s)` : ''}
          </span>
        </div>
      ) : null}
    </div>
  );
}
