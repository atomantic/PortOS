import { useState } from 'react';
import { CRON_PRESETS, DEFAULT_CRON, describeCron, parseSimpleCron } from '../utils/cronHelpers';
import WeekdayTimePicker from './WeekdayTimePicker';

/**
 * Inline cron expression editor with a day-of-week + time-of-day picker.
 *
 * The picker is the easy path: toggle the days it should run and set the time,
 * no crontab syntax required (no days selected = every day). A collapsible
 * "advanced" row keeps the raw expression + presets for interval/stepped crons
 * the picker can't represent. Calls onSave with the validated expression,
 * onCancel to dismiss.
 */
export default function CronInput({ value, onSave, onCancel, className = '' }) {
  const [expr, setExpr] = useState(value || DEFAULT_CRON);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const parsed = parseSimpleCron(expr);
  const isDaily = parsed && parsed.days.length === 0;

  const handleSave = () => {
    const trimmed = expr.trim();
    if (trimmed.split(/\s+/).length !== 5) return;
    onSave(trimmed);
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <WeekdayTimePicker value={expr} onChange={setExpr} />
        <button
          type="button"
          onClick={handleSave}
          className="px-1.5 py-1 bg-port-accent/20 text-port-accent rounded text-xs hover:bg-port-accent/30"
        >
          OK
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel custom cron expression"
            className="px-1.5 py-1 text-gray-500 hover:text-gray-300 rounded text-xs"
          >
            X
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">
          {isDaily ? 'Every day ' : ''}{expr && describeCron(expr)}
        </span>
        <button
          type="button"
          onClick={() => setShowAdvanced(v => !v)}
          className="text-xs text-gray-500 hover:text-gray-300 underline decoration-dotted"
        >
          {showAdvanced ? 'Hide advanced' : 'Advanced'}
        </button>
      </div>

      {showAdvanced && (
        <div className="flex flex-wrap items-center gap-1">
          <input
            type="text"
            value={expr}
            onChange={e => setExpr(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') onCancel?.();
            }}
            className="w-28 sm:w-32 px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white font-mono focus:border-port-accent focus:outline-hidden"
            placeholder="0 7 * * *"
          />
          <select
            value=""
            onChange={e => { if (e.target.value) setExpr(e.target.value); }}
            className="px-1 py-1 bg-port-bg border border-port-border rounded text-gray-400 text-xs"
            aria-label="Cron presets"
          >
            <option value="">Presets</option>
            {CRON_PRESETS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
