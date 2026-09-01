import { useEffect, useState } from 'react';
import { DEFAULT_CRON } from '../utils/cronHelpers';
import CronSchedulePicker from './CronSchedulePicker';
import InlineConfirmRow from './ui/InlineConfirmRow';

/**
 * Inline cron expression editor with a day-of-week + time-of-day picker.
 *
 * The picker is the easy path: toggle the days it should run and set the time,
 * no crontab syntax required (no days selected = every day). A collapsible
 * "advanced" row keeps the raw expression + presets for interval/stepped crons
 * the picker can't represent. Calls onSave with the validated expression, and
 * confirms before onCancel can discard an edited schedule.
 */
export default function CronInput({ value, onSave, onCancel, className = '' }) {
  const savedExpression = String(value || DEFAULT_CRON);
  const [expr, setExpr] = useState(savedExpression);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  useEffect(() => {
    setExpr(savedExpression);
    setConfirmingCancel(false);
  }, [savedExpression]);

  const trimmed = expr.trim();
  const isDirty = trimmed !== savedExpression.trim();
  const isValid = trimmed.split(/\s+/).length === 5;

  const handleSave = () => {
    if (!isValid) return;
    setConfirmingCancel(false);
    onSave(trimmed);
  };

  const handleCancel = () => {
    if (isDirty) {
      setConfirmingCancel(true);
      return;
    }
    onCancel?.();
  };

  const discardChanges = () => {
    setExpr(savedExpression);
    setConfirmingCancel(false);
    onCancel?.();
  };

  return (
    <div
      className={`flex flex-col gap-2 ${isDirty ? 'rounded-md border border-port-warning/50 bg-port-warning/10 p-2' : ''} ${className}`.trim()}
      data-dirty={isDirty}
    >
      <div className="flex flex-wrap items-start gap-1.5">
        <CronSchedulePicker
          value={expr}
          onChange={setExpr}
          onCronKeyDown={event => {
            if (event.key === 'Enter') handleSave();
            if (event.key === 'Escape') handleCancel();
          }}
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-port-border/60 pt-2">
        <span
          role="status"
          aria-live="polite"
          className={`mr-auto text-xs ${isDirty ? 'font-medium text-port-warning' : 'text-gray-500'}`}
        >
          {isDirty ? (isValid ? 'Unsaved changes — save before closing' : 'Enter a valid 5-field cron expression') : null}
        </span>
        <button
          type="button"
          onClick={handleSave}
          disabled={!isValid}
          title={isValid ? 'Save schedule changes' : 'Enter a valid 5-field cron expression before saving'}
          className={`inline-flex min-h-[40px] items-center justify-center rounded px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${isDirty
            ? 'bg-port-accent text-white shadow-sm ring-2 ring-port-accent/50 hover:bg-port-accent/80'
            : 'bg-port-accent/20 text-port-accent hover:bg-port-accent/30'}`}
        >
          Save schedule
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={handleCancel}
            aria-label={isDirty ? 'Cancel schedule edits' : 'Close schedule editor'}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-port-border/50 hover:text-white"
          >
            Cancel
          </button>
        )}
      </div>

      {confirmingCancel && onCancel && (
        <InlineConfirmRow
          question="Discard your unsaved schedule changes?"
          confirmText="Discard changes"
          cancelText="Keep editing"
          onConfirm={discardChanges}
          onCancel={() => setConfirmingCancel(false)}
          tone="warning"
          autoFocus
          aria-label="Discard unsaved schedule changes"
        />
      )}
    </div>
  );
}
