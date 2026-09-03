import { describeCron } from '../../../../utils/cronHelpers';
import { badge, INTERVAL_LABELS, INTERVAL_BADGE_VARIANT, PERPETUAL_BADGE_VARIANT, PERPETUAL_LABEL, PERPETUAL_DESCRIPTION } from './scheduleConstants';

/**
 * The cadence chip, plus a separate Perpetual chip when the task carries the
 * drain flag — the two are orthogonal, so a Scheduled + Perpetual task shows both.
 */
export default function IntervalBadge({ type, cronExpression, perpetual }) {
  const label = INTERVAL_LABELS[type] || type;
  const cronDesc = type === 'cron' && cronExpression ? describeCron(cronExpression) : null;
  const title = type === 'cron' && cronExpression
    ? (cronDesc ? `${cronDesc} (${cronExpression})` : cronExpression)
    : undefined;

  return (
    <>
      <span
        className={`${badge(INTERVAL_BADGE_VARIANT[type] || 'gray')} whitespace-nowrap shrink-0`}
        title={title}
      >
        {label}
      </span>
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
