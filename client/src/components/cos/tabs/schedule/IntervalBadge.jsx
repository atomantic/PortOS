import { describeCron } from '../../../../utils/cronHelpers';
import { badge, INTERVAL_LABELS, INTERVAL_BADGE_VARIANT } from './scheduleConstants';

export default function IntervalBadge({ type, cronExpression }) {
  const label = type === 'cron' && cronExpression
    ? describeCron(cronExpression) || cronExpression
    : INTERVAL_LABELS[type] || type;
  return (
    <span className={badge(INTERVAL_BADGE_VARIANT[type] || 'success')} title={type === 'cron' && cronExpression ? cronExpression : undefined}>
      {label}
    </span>
  );
}
