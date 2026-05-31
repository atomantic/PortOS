import { useId } from 'react';
import { Plus, X, ChevronUp, ChevronDown } from 'lucide-react';
import {
  REVIEWER_OPTIONS,
  REVIEW_STOP_MODES,
  DEFAULT_REVIEW_STOP_MODE
} from './constants';

const labelFor = (value) => REVIEWER_OPTIONS.find(o => o.value === value)?.label || value;
const normalizeReviewerValue = (value) => value === 'gemini' ? 'antigravity' : value;

/**
 * Ordered multi-reviewer picker. Click a reviewer to append it (run order =
 * click order), reorder with the arrows, remove with ✕. Maps to slashdo's
 * `--review-with a,b,c` plus the stop-mode / `--reviewer-applies` flags.
 *
 * Controlled: emits the full next shape via onChange so the parent can store
 * `reviewers` / `reviewStopMode` / `reviewerApplies` however it persists them.
 */
export default function ReviewerPicker({
  reviewers = [],
  stopMode = DEFAULT_REVIEW_STOP_MODE,
  reviewerApplies = false,
  onChange,
  disabled = false
}) {
  const id = useId();
  // Render the parent's list (de-duped, order-preserving) so display === stored
  // state for valid input while staying robust to malformed/legacy duplicates —
  // dupes would otherwise collide on the `key={value}` below and corrupt
  // reorder/remove. An empty list shows the "defaults to Copilot" hint and lets
  // the user clear copilot; the server/submit layer resolves [] → ['copilot'].
  const selected = Array.isArray(reviewers) ? [...new Set(reviewers.map(normalizeReviewerValue))] : [];
  const available = REVIEWER_OPTIONS.filter(o => !selected.includes(o.value));
  const hasNonCopilot = selected.some(r => r !== 'copilot');

  const emit = (next) => onChange?.({
    reviewers: selected,
    stopMode,
    reviewerApplies,
    ...next
  });

  const add = (value) => emit({ reviewers: [...selected, value] });
  const remove = (value) => emit({ reviewers: selected.filter(r => r !== value) });
  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= selected.length) return;
    const next = [...selected];
    [next[index], next[target]] = [next[target], next[index]];
    emit({ reviewers: next });
  };

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-gray-500 mr-1">Reviewers (in order):</span>
        {selected.map((value, index) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 bg-port-bg border border-port-border rounded text-xs text-gray-300"
            title={REVIEWER_OPTIONS.find(o => o.value === value)?.description}
          >
            <span className="text-port-accent font-mono">{index + 1}.</span>
            {labelFor(value)}
            <button
              type="button"
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
              className="text-gray-500 hover:text-white disabled:opacity-30 disabled:hover:text-gray-500"
              aria-label={`Move ${labelFor(value)} earlier`}
            >
              <ChevronUp size={12} />
            </button>
            <button
              type="button"
              disabled={disabled || index === selected.length - 1}
              onClick={() => move(index, 1)}
              className="text-gray-500 hover:text-white disabled:opacity-30 disabled:hover:text-gray-500"
              aria-label={`Move ${labelFor(value)} later`}
            >
              <ChevronDown size={12} />
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => remove(value)}
              className="text-gray-500 hover:text-port-error"
              aria-label={`Remove ${labelFor(value)}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {selected.length === 0 && (
          <span className="text-xs text-gray-600 italic">none — defaults to Copilot</span>
        )}
      </div>

      {available.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-600 mr-1">Add:</span>
          {available.map(opt => (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              onClick={() => add(opt.value)}
              title={opt.description}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-transparent border border-port-border rounded text-xs text-gray-400 hover:text-white hover:border-port-accent disabled:opacity-50"
            >
              <Plus size={11} />
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {selected.length >= 2 && (
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-stopmode`} className="text-xs text-gray-500">Stop mode:</label>
          <select
            id={`${id}-stopmode`}
            value={stopMode}
            disabled={disabled}
            onChange={e => emit({ stopMode: e.target.value })}
            className="px-1.5 py-0.5 bg-port-bg border border-port-border rounded text-xs text-gray-300 min-h-[28px]"
          >
            {REVIEW_STOP_MODES.map(m => (
              <option key={m.value} value={m.value} title={m.description}>{m.label}</option>
            ))}
          </select>
        </div>
      )}

      {hasNonCopilot && (
        <label htmlFor={`${id}-applies`} className="flex items-center gap-2 cursor-pointer select-none text-xs text-gray-500">
          <input
            id={`${id}-applies`}
            type="checkbox"
            checked={reviewerApplies}
            disabled={disabled}
            onChange={e => emit({ reviewerApplies: e.target.checked })}
            className="w-3.5 h-3.5 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
          />
          Reviewer applies fixes (CLI edits the working tree; no effect on Copilot)
        </label>
      )}
    </div>
  );
}
