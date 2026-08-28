import { useId, useState } from 'react';
import {
  CRON_PRESETS,
  DEFAULT_CRON,
  DEFAULT_TIME,
  WEEKDAYS,
  RECURRENCE_FREQUENCIES,
  RECURRENCE_ORDINALS,
  buildCronFromRecurrence,
  describeRecurrence,
  parseCronToRecurrence,
} from '../utils/cronHelpers';
import { shiftDayKey, todayKeyInTimezone } from '../utils/timezone.js';

const WEEKDAY_SET = WEEKDAYS.filter(day => day.value >= 1 && day.value <= 5).map(day => day.value);

function dayOfWeekInTimezone(date, timezone) {
  try {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || undefined,
      weekday: 'short',
    }).format(date);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  } catch {
    return date.getDay();
  }
}

function nextWeekdayDate(days, timezone) {
  const selected = Array.isArray(days) && days.length ? days : [1];
  const today = dayOfWeekInTimezone(new Date(), timezone);
  const delta = Math.min(...selected.map(day => (day - today + 7) % 7));
  return shiftDayKey(todayKeyInTimezone(timezone), delta);
}

function withAnchor(rule, timezone) {
  if (rule.frequency === 'weekly' && Number(rule.interval) > 1 && !rule.anchorDate) {
    return { ...rule, anchorDate: nextWeekdayDate(rule.weekdays, timezone) };
  }
  if (rule.frequency.startsWith('monthly') && Number(rule.interval) > 1 && !rule.anchorDate) {
    return { ...rule, anchorDate: todayKeyInTimezone(timezone) };
  }
  if (rule.frequency === 'daily' && Number(rule.interval) > 1 && !rule.anchorDate) {
    return { ...rule, anchorDate: todayKeyInTimezone(timezone) };
  }
  return rule;
}

function normalizeRule(value) {
  const parsed = typeof value === 'string' ? parseCronToRecurrence(value) : value;
  if (parsed?.frequency) {
    return {
      interval: 1,
      time: DEFAULT_TIME,
      ...parsed,
      weekdays: Array.isArray(parsed.weekdays) ? parsed.weekdays : [],
    };
  }
  return { frequency: 'daily', interval: 1, weekdays: [], time: DEFAULT_TIME };
}

function commissionToRule(schedule) {
  if (!schedule) return normalizeRule(null);
  if (schedule.kind === 'RECURRENCE') return normalizeRule(schedule.recurrence);
  if (schedule.kind === 'CUSTOM') return { frequency: 'custom', cron: schedule.cron || '' };
  if (schedule.kind === 'WEEKLY') {
    return {
      frequency: 'weekly', interval: 1, weekdays: Number.isInteger(schedule.weekday) ? [schedule.weekday] : [1],
      time: schedule.atLocalTime || DEFAULT_TIME,
    };
  }
  return {
    frequency: 'daily', interval: 1,
    weekdays: schedule.weekdaysOnly ? WEEKDAY_SET : [],
    time: schedule.atLocalTime || DEFAULT_TIME,
  };
}

function ruleToCommission(rule, previous, timezone) {
  const preserved = previous?.timezone ? { timezone: previous.timezone } : {};
  if (rule.frequency === 'custom') return { ...preserved, kind: 'CUSTOM', cron: String(rule.cron || '').trim() };

  const days = [...new Set(rule.weekdays || [])].sort((a, b) => a - b);
  if (rule.frequency === 'daily' && Number(rule.interval) === 1 && (days.length === 0 || days.join(',') === WEEKDAY_SET.join(','))) {
    return { ...preserved, kind: 'DAILY', atLocalTime: rule.time || DEFAULT_TIME, weekdaysOnly: days.length > 0 };
  }
  if (rule.frequency === 'weekly' && Number(rule.interval) === 1 && days.length === 1) {
    return { ...preserved, kind: 'WEEKLY', weekday: days[0], atLocalTime: rule.time || DEFAULT_TIME };
  }
  if (rule.frequency === 'weekly' && days.length === 1) {
    return { ...preserved, kind: 'RECURRENCE', recurrence: withAnchor({ ...rule, weekdays: days }, timezone) };
  }
  return {
    ...preserved,
    kind: 'RECURRENCE',
    recurrence: withAnchor({ ...rule, weekdays: days }, timezone),
  };
}

function DayButtons({ days, onChange }) {
  const selected = new Set(days || []);
  const toggle = (day) => {
    const next = selected.has(day) ? [...selected].filter(value => value !== day) : [...selected, day];
    onChange(next.sort((a, b) => a - b));
  };
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Days of week">
      {WEEKDAYS.map(day => (
        <button
          key={day.value}
          type="button"
          onClick={() => toggle(day.value)}
          aria-pressed={selected.has(day.value)}
          aria-label={day.label}
          title={day.label}
          className={`min-h-9 min-w-9 rounded text-xs font-medium transition-colors ${
            selected.has(day.value)
              ? 'bg-port-accent text-white'
              : 'border border-port-border bg-port-bg text-gray-400 hover:border-port-accent'
          }`}
        >
          {day.short}
        </button>
      ))}
    </div>
  );
}

function TimeInput({ value, onChange, label = 'Time of day' }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-xs text-gray-400">
      <span>{label}</span>
      <input
        id={id}
        type="time"
        value={value || ''}
        onChange={event => onChange(event.target.value)}
        className="rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs text-white focus:border-port-accent focus:outline-hidden"
      />
    </label>
  );
}

function CronExpressionPicker({ value, onChange, className, showAdvanced, showSummary, cronAriaLabel, onCronKeyDown }) {
  const advancedContainerId = useId();
  const expr = typeof value === 'string' ? value : '';
  const parsed = parseCronToRecurrence(expr);
  const simple = parsed?.frequency === 'daily' || parsed?.frequency === 'weekly';
  const days = simple && parsed.frequency === 'weekly' ? parsed.weekdays : [];
  const time = simple ? parsed.time : '';
  const [advanced, setAdvanced] = useState(showAdvanced);

  const apply = (nextDays, nextTime) => {
    const built = buildCronFromRecurrence({
      frequency: nextDays.length ? 'weekly' : 'daily', interval: 1, weekdays: nextDays, time: nextTime,
    });
    if (built) onChange(built);
  };

  return (
    <div className={`space-y-2 ${className || ''}`}>
      <div className="flex flex-wrap items-center gap-3">
        <DayButtons
          days={days}
          onChange={nextDays => apply(nextDays, time || DEFAULT_TIME)}
        />
        <TimeInput value={time} onChange={nextTime => apply(days, nextTime)} />
      </div>
      {showSummary && expr && <p className="text-xs text-gray-500">{parsed?.frequency === 'custom' ? expr : describeRecurrence(parsed)}</p>}
      {showAdvanced && (
        <>
          <button
            type="button"
            onClick={() => setAdvanced(current => !current)}
            aria-expanded={advanced}
            aria-controls={advancedContainerId}
            className="text-xs text-gray-500 underline decoration-dotted hover:text-gray-300"
          >
            {advanced ? 'Hide advanced' : 'Advanced cron'}
          </button>
          <div id={advancedContainerId} hidden={!advanced}>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={expr}
                onChange={event => onChange(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') event.currentTarget.blur();
                  onCronKeyDown?.(event);
                }}
                className="min-w-[12rem] flex-1 rounded border border-port-border bg-port-bg px-3 py-2 font-mono text-sm text-white"
                placeholder="0 7 * * *"
                aria-label={cronAriaLabel}
              />
              <select
                value=""
                onChange={event => { if (event.target.value) onChange(event.target.value); }}
                className="rounded border border-port-border bg-port-bg px-2 py-2 text-xs text-gray-400"
                aria-label="Cron presets"
              >
                <option value="">Presets</option>
                {CRON_PRESETS.map(preset => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
              </select>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RecurrenceRulePicker({ value, onChange, className, showAdvanced = true, timezone }) {
  const [advanced, setAdvanced] = useState(showAdvanced);
  const customCronId = useId();
  const anchorDateId = useId();
  const rule = normalizeRule(value);
  const update = (patch) => onChange(withAnchor({ ...rule, ...patch }, timezone));
  const setFrequency = (frequency) => {
    const defaults = {
      daily: { frequency, interval: 1, weekdays: [], time: rule.time || DEFAULT_TIME },
      weekly: { frequency, interval: 1, weekdays: rule.weekdays?.length ? rule.weekdays : [1], time: rule.time || DEFAULT_TIME },
      'monthly-date': { frequency, interval: 1, dayOfMonth: 1, time: rule.time || DEFAULT_TIME },
      'monthly-weekday': { frequency, interval: 1, ordinal: 'first', weekday: 1, time: rule.time || DEFAULT_TIME },
      custom: { frequency, cron: buildCronFromRecurrence(rule) || DEFAULT_CRON },
    };
    onChange(withAnchor(defaults[frequency], timezone));
  };

  return (
    <div className={`space-y-3 ${className || ''}`}>
      <label className="block text-xs text-gray-400">
        Recurrence pattern
        <select
          value={rule.frequency}
          onChange={event => setFrequency(event.target.value)}
          className="mt-1.5 w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white"
          aria-label="Recurrence pattern"
        >
          {RECURRENCE_FREQUENCIES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>

      {rule.frequency === 'custom' ? (
        <>
          <label className="block text-xs text-gray-400" htmlFor={customCronId}>
            Cron expression
            <input
              id={customCronId}
              value={rule.cron || ''}
              onChange={event => update({ cron: event.target.value })}
              className="mt-1.5 w-full rounded border border-port-border bg-port-bg px-3 py-2 font-mono text-sm text-white"
              placeholder="0 7 * * *"
            />
          </label>
          <select
            value=""
            onChange={event => { if (event.target.value) update({ cron: event.target.value }); }}
            className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-xs text-gray-400"
            aria-label="Cron presets"
          >
            <option value="">Presets</option>
            {CRON_PRESETS.map(preset => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
          </select>
        </>
      ) : (
        <>
          {rule.frequency === 'daily' && (
            <>
              <label className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                Every
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={rule.interval || 1}
                  onChange={event => update({ interval: Number(event.target.value) || 1 })}
                  className="w-20 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white"
                  aria-label="Repeat every number of days"
                />
                day(s)
              </label>
              <div className="space-y-1">
                <span className="block text-xs text-gray-500">Optional weekday restriction (leave empty for every day)</span>
                <DayButtons days={rule.weekdays} onChange={weekdays => update({ weekdays })} />
              </div>
            </>
          )}
          {rule.frequency === 'weekly' && (
            <>
              <label className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                Every
                <input
                  type="number"
                  min="1"
                  max="52"
                  value={rule.interval || 1}
                  onChange={event => update({ interval: Number(event.target.value) || 1 })}
                  className="w-20 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white"
                  aria-label="Repeat every number of weeks"
                />
                week(s) on
              </label>
              <DayButtons
                days={rule.weekdays}
                onChange={weekdays => update({ weekdays: weekdays.length ? weekdays : [1] })}
              />
            </>
          )}
          {rule.frequency === 'monthly-date' && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block text-xs text-gray-400">
                Day of month
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={rule.dayOfMonth || 1}
                  onChange={event => update({ dayOfMonth: Number(event.target.value) || 1 })}
                  className="mt-1.5 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white"
                />
              </label>
              <label className="block text-xs text-gray-400">
                Every N months
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={rule.interval || 1}
                  onChange={event => update({ interval: Number(event.target.value) || 1 })}
                  className="mt-1.5 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white"
                />
              </label>
            </div>
          )}
          {rule.frequency === 'monthly-weekday' && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="block text-xs text-gray-400">
                Which
                <select value={rule.ordinal || 'first'} onChange={event => update({ ordinal: event.target.value })} className="mt-1.5 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white">
                  {RECURRENCE_ORDINALS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="block text-xs text-gray-400">
                Weekday
                <select value={rule.weekday ?? 1} onChange={event => update({ weekday: Number(event.target.value) })} className="mt-1.5 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white">
                  {WEEKDAYS.map(day => <option key={day.value} value={day.value}>{day.label}</option>)}
                </select>
              </label>
              <label className="block text-xs text-gray-400">
                Every N months
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={rule.interval || 1}
                  onChange={event => update({ interval: Number(event.target.value) || 1 })}
                  className="mt-1.5 w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white"
                />
              </label>
            </div>
          )}
          <TimeInput value={rule.time} onChange={time => update({ time })} label="Time" />
          {Number(rule.interval) > 1 && (
            <label className="block text-xs text-gray-400" htmlFor={anchorDateId}>
              Starting date
              <input
                id={anchorDateId}
                type="date"
                value={rule.anchorDate || ''}
                onChange={event => update({ anchorDate: event.target.value })}
                className="mt-1.5 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-white"
              />
            </label>
          )}
        </>
      )}

      <p className="text-xs text-gray-500">{describeRecurrence(rule)}</p>
      {showAdvanced && rule.frequency !== 'custom' && (
        <>
          <button type="button" onClick={() => setAdvanced(current => !current)} className="text-xs text-gray-500 underline decoration-dotted hover:text-gray-300">
            {advanced ? 'Hide cron preview' : 'Show cron preview'}
          </button>
          {advanced && (
            <>
              <p className="text-[11px] text-gray-600">Compatibility preview; anchored intervals run from the calendar rule.</p>
              <p className="rounded border border-port-border/60 bg-port-bg/60 px-2 py-1.5 font-mono text-xs text-gray-500">{buildCronFromRecurrence(rule) || 'No equivalent cron preview'}</p>
            </>
          )}
        </>
      )}
    </div>
  );
}

function CommissionSchedulePicker({ value, onChange, className, timezone }) {
  const rule = commissionToRule(value);
  return (
    <RecurrenceRulePicker
      value={rule}
      onChange={nextRule => onChange(ruleToCommission(nextRule, value, timezone))}
      className={className}
      timezone={timezone}
      showAdvanced
    />
  );
}

/**
 * Shared friendly cron/recurrence editor.
 *
 * `valueShape="cron"` reads/writes a legacy five-field string. `recurrence`
 * reads/writes the richer calendar rule used by scheduled jobs. `commission`
 * adapts that same editor to the commission's backwards-compatible schedule
 * descriptor, including DAILY/WEEKLY/CUSTOM records.
 */
export default function CronSchedulePicker({ value, onChange, className = '', valueShape = 'cron', showAdvanced = true, showSummary = true, cronAriaLabel = 'Cron expression', onCronKeyDown, timezone }) {
  if (valueShape === 'commission') return <CommissionSchedulePicker value={value} onChange={onChange} className={className} timezone={timezone} />;
  if (valueShape === 'recurrence') return <RecurrenceRulePicker value={value} onChange={onChange} className={className} showAdvanced={showAdvanced} timezone={timezone} />;
  return <CronExpressionPicker value={value} onChange={onChange} className={className} showAdvanced={showAdvanced} showSummary={showSummary} cronAriaLabel={cronAriaLabel} onCronKeyDown={onCronKeyDown} />;
}
