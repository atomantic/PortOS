import { WEEKDAYS, DEFAULT_TIME, parseSimpleCron, buildWeeklyCron } from '../utils/cronHelpers';

/**
 * Day-of-week + time-of-day picker that reads/writes a cron expression.
 *
 * Toggle the days it should run and set the time — no crontab syntax. No days
 * selected means every day (a daily schedule). `value` is a cron string;
 * `onChange` receives the rebuilt cron string. When `value` is an
 * interval/stepped cron the picker can't represent, the pills show unselected
 * and the first interaction converts it into a simple day+time cron.
 */
export default function WeekdayTimePicker({ value, onChange, className = '' }) {
  const parsed = parseSimpleCron(value);
  const days = parsed?.days ?? [];
  const time = parsed?.time ?? '';

  const apply = (nextDays, nextTime) => {
    const built = buildWeeklyCron(nextDays, nextTime);
    if (built) onChange(built);
  };

  const toggleDay = (day) => {
    const nextDays = days.includes(day) ? days.filter(d => d !== day) : [...days, day];
    apply(nextDays, time || DEFAULT_TIME);
  };

  const handleTimeChange = (nextTime) => apply(days, nextTime);

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <div className="flex items-center gap-0.5" role="group" aria-label="Days of week">
        {WEEKDAYS.map(wd => {
          const active = !!parsed && days.includes(wd.value);
          return (
            <button
              key={wd.value}
              type="button"
              onClick={() => toggleDay(wd.value)}
              aria-pressed={active}
              aria-label={wd.label}
              title={wd.label}
              className={`w-6 h-6 rounded text-xs font-medium ${
                active
                  ? 'bg-port-accent text-white'
                  : 'bg-port-bg border border-port-border text-gray-400 hover:border-port-accent'
              }`}
            >
              {wd.short}
            </button>
          );
        })}
      </div>
      <label className="flex items-center gap-1 text-xs text-gray-400">
        <span className="sr-only">Time of day</span>
        <input
          type="time"
          value={time}
          onChange={e => handleTimeChange(e.target.value)}
          className="px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white focus:border-port-accent focus:outline-hidden"
        />
      </label>
    </div>
  );
}
