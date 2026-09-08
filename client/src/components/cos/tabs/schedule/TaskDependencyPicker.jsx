import { useState } from 'react';
import { X } from 'lucide-react';
import { FormField } from '../../../ui/FormField';
import { badge } from './scheduleConstants';

/**
 * Pick a list of OTHER scheduled tasks by name — used for both dependency
 * fields on a task: the enforced `runAfter` gate and the advisory
 * `suggestedAfter` run order.
 *
 * Selected tasks render as removable chips and everything else lives behind one
 * "Add a task…" select. The earlier shape rendered every registered task type
 * as a toggle button, which on this install is a wall of ~60 chips per field —
 * so the two or three that were actually selected were the hardest thing on the
 * panel to find. Chips-plus-select keeps the answer ("these ones") at the top
 * and the roster one click away.
 */
export default function TaskDependencyPicker({ label, hint, taskType, options = [], value = [], disabled, onChange }) {
  const [pending, setPending] = useState('');
  const selected = value.filter(Boolean);
  const available = options
    .filter(option => option !== taskType && !selected.includes(option))
    .sort((a, b) => a.localeCompare(b));

  const commit = (next) => {
    setPending('');
    onChange(next);
  };

  // FormField owns the label/hint and the htmlFor pairing, so the chips sit
  // under the control it labels rather than between the two.
  return (
    <FormField label={label} hint={hint} labelClassName="text-sm text-gray-400 block mb-1">
      <select
        value={pending}
        disabled={disabled || available.length === 0}
        onChange={(event) => {
          const next = event.target.value;
          if (next) commit([...selected, next]);
        }}
        className="max-w-full bg-port-card border border-port-border rounded px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        <option value="">{available.length === 0 ? 'No other tasks available' : 'Add a task…'}</option>
        {available.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {selected.map(dep => (
            <span key={dep} className={`${badge('accent')} inline-flex items-center gap-1 font-mono`}>
              {dep}
              <button
                type="button"
                onClick={() => commit(selected.filter(entry => entry !== dep))}
                disabled={disabled}
                aria-label={`Remove ${dep}`}
                className="text-port-accent/70 hover:text-white disabled:opacity-50"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </FormField>
  );
}
