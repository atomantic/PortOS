import { describeCron, summarizeAppSchedules } from '../../../../utils/cronHelpers';
import { badge, INTERVAL_LABELS, INTERVAL_BADGE_VARIANT, PERPETUAL_BADGE_VARIANT, PERPETUAL_LABEL, PERPETUAL_DESCRIPTION, ON_DEMAND_PERPETUAL_LABEL, ON_DEMAND_PERPETUAL_DESCRIPTION } from './scheduleConstants';

/**
 * The cadence chip, plus a separate Perpetual chip when the task carries the
 * drain flag — the two are orthogonal, so a Scheduled + Perpetual task shows both.
 */
export default function IntervalBadge({ type, cronExpression, perpetual, autoStart, appSchedules }) {
  // An app can pin a cron on a task whose own row says "On Demand". The cadence
  // chip describes the GLOBAL row and would read as a flat contradiction of
  // what the task actually does, so the per-app cadences get a chip of their own.
  const perApp = summarizeAppSchedules(appSchedules);
  const automaticDrain = type === 'on-demand' && perpetual && autoStart !== false;
  const label = automaticDrain ? ON_DEMAND_PERPETUAL_LABEL : INTERVAL_LABELS[type] || type;
  const cronDesc = type === 'cron' && cronExpression ? describeCron(cronExpression) : null;
  const title = type === 'cron' && cronExpression
    ? (cronDesc ? `${cronDesc} (${cronExpression})` : cronExpression)
    : automaticDrain ? ON_DEMAND_PERPETUAL_DESCRIPTION : undefined;

  return (
    <>
      <span
        className={`${badge(INTERVAL_BADGE_VARIANT[type] || 'gray')} whitespace-nowrap shrink-0`}
        title={title}
      >
        {label}
      </span>
      {perApp && (
        <span
          className={`${badge('cyan')} whitespace-nowrap shrink-0`}
          title={`These apps run this task on their own cron, whatever the cadence above says:\n${perApp.detail}`}
        >
          {perApp.count} app schedule{perApp.count === 1 ? '' : 's'}
        </span>
      )}
      {perpetual && (
        <span
          className={`${badge(PERPETUAL_BADGE_VARIANT)} whitespace-nowrap shrink-0`}
          title={PERPETUAL_DESCRIPTION}
        >
          {PERPETUAL_LABEL}
        </span>
      )}
    </>
  );
}
