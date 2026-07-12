import { useId, useState } from 'react';
import { Plus, X, ChevronUp, ChevronDown } from 'lucide-react';
import {
  REVIEWER_OPTIONS,
  REVIEW_STOP_MODES,
  DEFAULT_REVIEW_STOP_MODE,
  MAX_REVIEW_USERNAMES,
  cleanReviewUsername,
  normalizeReviewUsernames
} from './constants';

const labelFor = (value) => REVIEWER_OPTIONS.find(o => o.value === value)?.label || value;
const normalizeReviewerValue = (value) => value === 'gemini' ? 'antigravity' : value;

/**
 * Ordered multi-reviewer picker. Click a reviewer to append it (run order =
 * click order), reorder with the arrows, remove with ✕. Maps to slashdo's
 * `--review-with a,b,c` plus the stop-mode / `--reviewer-applies` flags.
 *
 * A second "GitHub reviewers" row collects arbitrary usernames (e.g.
 * `@CodeReviewbot`) requested as PR reviewers to gate the merge — appended to
 * `--review-with` as `@user` tokens after the keyed reviewers.
 *
 * Controlled: emits the full next shape via onChange so the parent can store
 * `reviewers` / `usernames` / `reviewStopMode` / `reviewerApplies` however it
 * persists them.
 */
export default function ReviewerPicker({
  reviewers = [],
  usernames = [],
  stopMode = DEFAULT_REVIEW_STOP_MODE,
  reviewerApplies = false,
  onChange,
  disabled = false
}) {
  const id = useId();
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameError, setUsernameError] = useState('');
  // Render the parent's list (de-duped, order-preserving) so display === stored
  // state for valid input while staying robust to malformed/legacy duplicates —
  // dupes would otherwise collide on the `key={value}` below and corrupt
  // reorder/remove. An empty list shows the "defaults to Copilot" hint and lets
  // the user clear copilot; the server/submit layer resolves [] → ['copilot'].
  const selected = Array.isArray(reviewers) ? [...new Set(reviewers.map(normalizeReviewerValue))] : [];
  const available = REVIEWER_OPTIONS.filter(o => !selected.includes(o.value));
  const hasNonCopilot = selected.some(r => r !== 'copilot');
  const selectedUsernames = normalizeReviewUsernames(usernames);
  const atMaxUsernames = selectedUsernames.length >= MAX_REVIEW_USERNAMES;

  const emit = (next) => onChange?.({
    reviewers: selected,
    usernames: selectedUsernames,
    stopMode,
    reviewerApplies,
    ...next
  });

  const addUsername = () => {
    const clean = cleanReviewUsername(usernameInput);
    if (!clean) {
      setUsernameError('Enter a valid GitHub username (letters, numbers, hyphens; optional org/team).');
      return;
    }
    if (selectedUsernames.some(u => u.toLowerCase() === clean.toLowerCase())) {
      setUsernameInput('');
      setUsernameError('Already added.');
      return;
    }
    if (atMaxUsernames) {
      setUsernameError(`At most ${MAX_REVIEW_USERNAMES} reviewer usernames.`);
      return;
    }
    emit({ usernames: [...selectedUsernames, clean] });
    setUsernameInput('');
    setUsernameError('');
  };
  const removeUsername = (value) => emit({ usernames: selectedUsernames.filter(u => u !== value) });

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

      {/* GitHub reviewer usernames — arbitrary PR reviewers (bots/humans) that
          gate the merge. Appended to `--review-with` as `@user` tokens. */}
      <div className="flex flex-col gap-1.5 pt-1 border-t border-port-border/50">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-500 mr-1">GitHub reviewers (gate merge):</span>
          {selectedUsernames.map((value) => (
            <span
              key={value}
              className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 bg-port-bg border border-port-accent/40 rounded text-xs text-gray-300"
              title="GitHub username requested as a PR reviewer to gate the merge"
            >
              <span className="text-port-accent font-mono">@</span>
              {value}
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeUsername(value)}
                className="text-gray-500 hover:text-port-error"
                aria-label={`Remove @${value}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {selectedUsernames.length === 0 && (
            <span className="text-xs text-gray-600 italic">none</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-600 font-mono">@</span>
          <input
            id={`${id}-username`}
            type="text"
            value={usernameInput}
            disabled={disabled || atMaxUsernames}
            placeholder="CodeReviewbot"
            aria-label="Add a GitHub reviewer username"
            onChange={(e) => { setUsernameInput(e.target.value); if (usernameError) setUsernameError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addUsername(); } }}
            className="flex-1 min-w-0 max-w-[200px] px-2 py-0.5 bg-port-bg border border-port-border rounded text-xs text-gray-300 min-h-[28px] focus:border-port-accent focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            disabled={disabled || !usernameInput.trim() || atMaxUsernames}
            onClick={addUsername}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-transparent border border-port-border rounded text-xs text-gray-400 hover:text-white hover:border-port-accent disabled:opacity-50"
          >
            <Plus size={11} />
            Add
          </button>
        </div>
        {usernameError && <span className="text-xs text-port-error">{usernameError}</span>}
      </div>

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
