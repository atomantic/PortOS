import { useId, useState } from 'react';
import { Plus, X, ChevronUp, ChevronDown } from 'lucide-react';
import {
  REVIEWER_OPTIONS,
  REVIEW_STOP_MODES,
  DEFAULT_REVIEW_STOP_MODE,
  MAX_REVIEW_USERNAMES,
  MAX_REVIEWER_MAX_ROUNDS,
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
 * Each chip carries two per-entry slashdo suffix controls: the `~opt`
 * non-blocking badge and a numeric `~max=<n>` round cap (blank = slashdo's
 * built-in default, `0` = loop until clean).
 *
 * Controlled: emits the full next shape via onChange so the parent can store
 * `reviewers` / `usernames` / `reviewerMaxRounds` / `reviewStopMode` /
 * `reviewerApplies` however it persists them.
 *
 * `showRunFlags={false}` hides the stop-mode select and the "reviewer applies
 * fixes" checkbox for surfaces that can't honor them — the `/do:next` claim
 * flows substitute a reviewer CSV into their prompt and have no slashdo flag
 * string, so rendering those two controls there would be a knob wired to
 * nothing. The reviewer list itself still applies.
 */
export default function ReviewerPicker({
  reviewers = [],
  usernames = [],
  optionalReviewers = [],
  reviewerMaxRounds = {},
  stopMode = DEFAULT_REVIEW_STOP_MODE,
  reviewerApplies = false,
  onChange,
  disabled = false,
  showRunFlags = true
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
  // Optional (non-blocking) reviewers — emitted with slashdo's `~opt` suffix.
  // Each token mirrors an emitted `--review-with` token: a keyed slug or `@user`,
  // so membership is a plain lookup (server `normalizeOptionalReviewers` owns the
  // authoritative shape; this is the display mirror).
  const optionalTokens = Array.isArray(optionalReviewers) ? [...new Set(optionalReviewers.map(String))] : [];
  const optionalSet = new Set(optionalTokens.map(t => t.toLowerCase()));
  const isOptional = (token) => optionalSet.has(token.toLowerCase());
  const withoutToken = (token) => optionalTokens.filter(t => t.toLowerCase() !== token.toLowerCase());
  // Per-reviewer `~max=<n>` round caps, keyed by the same emitted token. Absent
  // key = no cap requested (slashdo's built-in default stands); `0` = loop until
  // clean. The two must never collapse, so the input renders '' for absent and
  // clearing it DELETES the key rather than writing 0 (server
  // `normalizeReviewerMaxRounds` owns the authoritative shape).
  const maxRoundsMap = (reviewerMaxRounds && typeof reviewerMaxRounds === 'object' && !Array.isArray(reviewerMaxRounds))
    ? reviewerMaxRounds
    : {};
  const maxRoundsFor = (token) => {
    const key = Object.keys(maxRoundsMap).find(k => k.toLowerCase() === token.toLowerCase());
    return key === undefined ? undefined : maxRoundsMap[key];
  };
  const maxRoundsWithout = (token) => Object.fromEntries(
    Object.entries(maxRoundsMap).filter(([k]) => k.toLowerCase() !== token.toLowerCase())
  );

  const emit = (next) => onChange?.({
    reviewers: selected,
    usernames: selectedUsernames,
    optionalReviewers: optionalTokens,
    reviewerMaxRounds: maxRoundsMap,
    stopMode,
    reviewerApplies,
    ...next
  });

  const toggleOptional = (token) => emit({
    optionalReviewers: isOptional(token) ? withoutToken(token) : [...optionalTokens, token]
  });

  // Blank clears the cap entirely (back to slashdo's built-in default); any other
  // value is clamped to 0..MAX_REVIEWER_MAX_ROUNDS so the input can't offer a
  // budget the server would drop.
  const setMaxRounds = (token, raw) => {
    if (raw === '') {
      emit({ reviewerMaxRounds: maxRoundsWithout(token) });
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed)) return;
    const clamped = Math.min(Math.max(parsed, 0), MAX_REVIEWER_MAX_ROUNDS);
    emit({ reviewerMaxRounds: { ...maxRoundsWithout(token), [token]: clamped } });
  };

  // The `~opt` non-blocking toggle rendered on every reviewer/username chip.
  // `subject` is the human name used in the aria-label; `title` is the (chip-
  // kind-specific) hover copy the caller resolves.
  const renderOptToggle = (token, subject, title) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => toggleOptional(token)}
      title={title}
      className={`text-[10px] font-mono leading-none px-1 py-0.5 rounded border ${isOptional(token)
        ? 'text-port-warning border-port-warning/50 bg-port-warning/10'
        : 'text-gray-600 border-transparent hover:text-gray-300 hover:border-port-border'} disabled:opacity-40`}
      aria-pressed={isOptional(token)}
      aria-label={isOptional(token) ? `Make ${subject} blocking` : `Make ${subject} non-blocking`}
    >
      ~opt
    </button>
  );

  // The `~max=<n>` round-cap input rendered on every reviewer/username chip.
  // Blank means "no cap" — the number input's empty string is the sentinel for an
  // absent key, distinct from a typed `0` (loop until clean).
  const renderMaxRounds = (token, subject) => {
    const value = maxRoundsFor(token);
    const inputId = `${id}-max-${token}`;
    return (
      <span className="inline-flex items-center gap-0.5">
        <label htmlFor={inputId} className="text-[10px] font-mono leading-none text-gray-600">~max</label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_REVIEWER_MAX_ROUNDS}
          step={1}
          disabled={disabled}
          value={value === undefined ? '' : value}
          placeholder="–"
          onChange={(e) => setMaxRounds(token, e.target.value)}
          aria-label={`Max review rounds for ${subject}`}
          title={value === undefined
            ? `${subject} uses slashdo's built-in round cap. Enter a number to cap its review → fix → re-review cycles (0 = loop until clean).`
            : value === 0
              ? `${subject} loops until clean (~max=0), bounded by slashdo's safety guardrail. Clear to restore the built-in cap.`
              : `${subject} runs at most ${value} review round${value === 1 ? '' : 's'} (~max=${value}). Clear to restore the built-in cap.`}
          className={`w-8 px-0.5 py-0.5 text-[10px] font-mono leading-none text-center rounded border bg-port-bg disabled:opacity-40 focus:outline-none focus:border-port-accent ${value === undefined
            ? 'text-gray-500 border-transparent hover:border-port-border'
            : 'text-port-accent-2 border-port-accent-2/50'}`}
        />
      </span>
    );
  };

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
  const removeUsername = (value) => emit({
    usernames: selectedUsernames.filter(u => u !== value),
    optionalReviewers: withoutToken(`@${value}`),
    reviewerMaxRounds: maxRoundsWithout(`@${value}`)
  });

  const add = (value) => emit({ reviewers: [...selected, value] });
  const remove = (value) => emit({
    reviewers: selected.filter(r => r !== value),
    optionalReviewers: withoutToken(value),
    reviewerMaxRounds: maxRoundsWithout(value)
  });
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
            {renderOptToggle(value, labelFor(value), isOptional(value)
              ? `${labelFor(value)} is non-blocking (~opt): an inconclusive verdict from it won't block the merge. Click to make it blocking.`
              : `${labelFor(value)} gates the merge. Click to make it non-blocking (~opt) — its inconclusive verdicts won't block the merge (a hard failure still does).`)}
            {renderMaxRounds(value, labelFor(value))}
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

      {(selected.length > 0 || selectedUsernames.length > 0) && (
        <span className="text-[11px] text-gray-600 -mt-1">
          Tip: the <span className="font-mono text-port-warning">~opt</span> badge marks a reviewer <em>non-blocking</em> — it still runs and its findings are still fixed, but an inconclusive verdict (timeout / no result) won't block the merge. A hard failure still does. <span className="font-mono text-port-accent-2">~max</span> caps that reviewer's review → fix → re-review rounds (blank = its built-in cap, <span className="font-mono">0</span> = loop until clean) — a small cap keeps a slow local model affordable.
        </span>
      )}

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
              {renderOptToggle(`@${value}`, `@${value}`, isOptional(`@${value}`)
                ? `@${value} is non-blocking (~opt): if it never submits a review, the merge isn't blocked. Click to make it blocking.`
                : `@${value} gates the merge. Click to make it non-blocking (~opt) — a missing/timed-out review from it won't block the merge.`)}
              {renderMaxRounds(`@${value}`, `@${value}`)}
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

      {showRunFlags && selected.length >= 2 && (
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

      {showRunFlags && hasNonCopilot && (
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
