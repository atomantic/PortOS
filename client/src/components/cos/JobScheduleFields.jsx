import CronSchedulePicker from '../CronSchedulePicker';
import ScheduleAnchorSelect from './ScheduleAnchorSelect';
import { DEFAULT_CRON, buildCronFromRecurrence, JOB_INTERVAL_OPTIONS as INTERVAL_OPTIONS, ON_DEMAND_INTERVAL, scheduleAnchorKindForInterval } from '../../utils/cronHelpers';

const SCHEDULE_MODE_OPTIONS = [
  { value: 'interval', label: 'Interval' },
  { value: 'cron', label: 'Cron' }
];

// The schedule half of a system job's save payload. `scheduleMode` selects which
// cadence fields survive; it is a form-only key and never reaches the server.
export function normalizeJobSchedule(formData) {
  const payload = { ...formData };
  if (payload.scheduleMode === 'cron') {
    const derivedCron = buildCronFromRecurrence(payload.cronSchedule);
    payload.cronExpression = derivedCron || payload.cronExpression?.trim() || null;
    payload.cronSchedule = payload.cronSchedule || null;
    payload.scheduledTime = null;
    payload.scheduleAnchor = null;
  } else {
    payload.cronExpression = null;
    payload.cronSchedule = null;
    // An empty time input is "any time"; a day anchor only means something
    // alongside a time of day.
    payload.scheduledTime = payload.scheduledTime || null;
    if (!payload.scheduledTime) payload.scheduleAnchor = null;
  }
  delete payload.scheduleMode;
  return payload;
}

export function ScheduleFields({ data, onChange, timezone }) {
  const onDemand = data.interval === ON_DEMAND_INTERVAL;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400">Schedule:</span>
        {SCHEDULE_MODE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              onChange('scheduleMode', opt.value);
              // Seed the expression with the picker's displayed default (07:00
              // daily) so an untouched Cron picker is actually saveable.
              if (opt.value === 'cron' && !data.cronExpression && !data.cronSchedule) onChange('cronExpression', DEFAULT_CRON);
            }}
            className={`px-2 py-1 text-xs rounded transition-colors ${
              data.scheduleMode === opt.value
                ? 'bg-port-accent/20 text-port-accent'
                : 'bg-port-bg text-gray-500 hover:text-gray-300'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {data.scheduleMode === 'cron' ? (
        <div className="space-y-2">
          <CronSchedulePicker
            value={data.cronSchedule || data.cronExpression || DEFAULT_CRON}
            valueShape="recurrence"
            timezone={timezone}
            onChange={rule => {
              onChange('cronSchedule', rule);
              const cron = buildCronFromRecurrence(rule);
              onChange('cronExpression', cron || null);
            }}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Interval"
            value={data.interval}
            onChange={e => {
              onChange('interval', e.target.value);
              // The on-demand cadence has no recurrence for a time-of-day to
              // align to; the server clears it too, so drop it here rather than
              // saving a value the job will never honor.
              if (e.target.value === ON_DEMAND_INTERVAL) onChange('scheduledTime', null);
              // A weekday and a day of month are not interchangeable: let the server
              // re-default it. Weekly <-> biweekly keeps the day the user picked.
              if (scheduleAnchorKindForInterval(e.target.value) !== scheduleAnchorKindForInterval(data.interval)) onChange('scheduleAnchor', null);
            }}
            className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
          >
            {INTERVAL_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {onDemand ? (
            <span className="text-xs text-gray-500">Runs only when you press Run now.</span>
          ) : (
            <input
              type="time"
              value={data.scheduledTime || ''}
              onChange={e => onChange('scheduledTime', e.target.value || null)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              title="Run at specific time (leave empty for any time)"
              aria-label="Run at a specific time (leave empty for any time)"
            />
          )}
          {/* A weekdaysOnly job fires on a synthesized every-weekday cron, so it
              has no single day to anchor (server/lib/scheduleAnchor.js). */}
          {data.scheduledTime && !onDemand && !data.weekdaysOnly && (
            <ScheduleAnchorSelect interval={data.interval} value={data.scheduleAnchor} onChange={value => onChange('scheduleAnchor', value)} />
          )}
          {!onDemand && (
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={!!data.weekdaysOnly}
                onChange={e => onChange('weekdaysOnly', e.target.checked)}
                className="h-4 w-4 accent-port-accent"
              />
              Weekdays only
            </label>
          )}
        </div>
      )}
    </div>
  );
}
