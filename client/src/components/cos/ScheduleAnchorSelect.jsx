import { WEEKDAYS, scheduleAnchorKindForInterval } from '../../utils/cronHelpers';

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => index + 1);

/**
 * Picker for the calendar day a weekly/biweekly/monthly clock job stays on
 * (`scheduleAnchor`). Renders nothing for cadences that have no such day.
 * Auto sends null, which the server resolves from the job's last run.
 */
export default function ScheduleAnchorSelect({ interval, value, onChange, id }) {
  const kind = scheduleAnchorKindForInterval(interval);
  if (!kind) return null;
  const isWeekday = kind === 'weekday';

  return (
    <select
      id={id}
      aria-label={isWeekday ? 'Run on weekday' : 'Run on day of month'}
      value={value ?? ''}
      onChange={event => onChange(event.target.value === '' ? null : Number(event.target.value))}
      className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
      title={isWeekday
        ? 'The weekday this job stays on, however late an individual run lands'
        : 'The day of the month this job stays on (short months use their last day)'}
    >
      <option value="">{isWeekday ? 'Any weekday (from last run)' : 'Any day (from last run)'}</option>
      {isWeekday
        ? WEEKDAYS.map(day => <option key={day.value} value={day.value}>{day.label}</option>)
        : DAYS_OF_MONTH.map(day => <option key={day} value={day}>Day {day}</option>)}
    </select>
  );
}
