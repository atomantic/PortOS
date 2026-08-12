import { useId, useState } from 'react';
import { Plus, X, ChevronUp, ChevronDown } from 'lucide-react';
import Pill from '../ui/Pill';
import {
  REVIEWER_OPTIONS,
  REVIEW_STOP_MODES,
  DEFAULT_REVIEW_STOP_MODE,
  MAX_REVIEW_USERNAMES,
  MAX_REVIEWER_MAX_ROUNDS,
  MAX_REVIEWER_MODEL_LENGTH,
  MODEL_SELECTABLE_REVIEWERS,
  cleanReviewUsername,
  normalizeReviewUsernames,
  reviewerEffortLevels,
  reviewerLabel,
  sanitizeReviewerModelInput
} from './constants';

const normalizeReviewerValue = (value) => value === 'gemini' ? 'antigravity' : value;

/**
 * Ordered multi-reviewer picker, rendered as one row per reviewer with the five
 * per-reviewer controls as columns: **Provider | Model | Effort | Optional | Max
 * Iterations** (#3133). Click a reviewer in the Add row to append it (run order =
 * click order), reorder with the arrows, remove with ✕. Maps to slashdo's
 * `--review-with a,b,c` plus the stop-mode / `--reviewer-applies` flags.
 *
 * A second "GitHub reviewers" table collects arbitrary usernames (e.g.
 * `@CodeReviewbot`) requested as PR reviewers to gate the merge — appended to
 * `--review-with` as `@user` tokens after the keyed reviewers. Those rows have no
 * Model cell: a username reviewer is a human or a GitHub App, not a model-taking
 * backend (slashdo rejects `@login[…]` for the same reason).
 *
 * Per-row controls, each mapping to one slashdo per-entry token feature:
 * - **Model** → the `[<model>]` selector (or, for a CLI reviewer the follow-up
 *   agent invokes directly, `<reviewer> --model <id>`). Only rendered for
 *   MODEL_SELECTABLE_REVIEWERS. The option lists are OWNED BY THE CALLER (see
 *   `modelOptions`) so this component does no fetching.
 * - **Effort** → the reviewer's reasoning-effort tier. Unlike the others this
 *   maps to NO slashdo token (its entry grammar has no effort suffix) — it rides
 *   the invocation instead: `claude --effort high` / `codex -c
 *   model_reasoning_effort=high` for a CLI reviewer, `"effort"` in the
 *   `/api/code-review/local` body for a local one. Only rendered for
 *   EFFORT_SELECTABLE_REVIEWERS, and each row offers only the levels its own CLI
 *   accepts (`agy` rejects `--effort max`).
 * - **Optional** → the `~opt` non-blocking marker.
 * - **Max Iterations** → the numeric `~max=<n>` round cap (blank = slashdo's
 *   built-in default, `0` = loop until clean).
 *
 * Controlled: emits the full next shape via onChange so the parent can store
 * `reviewers` / `usernames` / `optionalReviewers` / `reviewerModels` /
 * `reviewerEfforts` / `reviewerMaxRounds` / `reviewStopMode` / `reviewerApplies`
 * however it persists them.
 *
 * `modelOptions` is the resolved model-picker data, shaped like
 * `useReviewerModelOptions()`'s return: `{ optionsByReviewer, freeText,
 * unavailable, loaded }`. Callers keep owning their own
 * `api.getLocalLlmStatus` / `api.getProviders` fetches (that's what the hook is
 * for) — passing nothing degrades every Model cell to a free-text input, which is
 * still fully usable, rather than hiding the column.
 *
 * `showRunFlags={false}` hides the stop-mode select and the "reviewer applies
 * fixes" checkbox for surfaces that can't honor them — the `/do:next` claim
 * flows substitute a reviewer CSV into their prompt and have no slashdo flag
 * string, so rendering those two controls there would be a knob wired to
 * nothing. The reviewer list itself still applies.
 *
 * `installed` is a per-reviewer-slug install probe from the Code Review
 * Defaults endpoint (`GET /api/code-review/defaults`'s `installed` field,
 * #3606) — `{ claude: true, antigravity: false, ... }`. Only an explicit
 * `false` renders a "not installed" badge; `undefined` (not a CLI reviewer,
 * or the caller didn't fetch it) renders nothing. Warn-only: a reviewer stays
 * selectable and selected even when flagged not-installed, since the CLI
 * check is local-machine-only and a federated peer (or a later install) may
 * satisfy it.
 */
export default function ReviewerPicker({
  reviewers = [],
  usernames = [],
  optionalReviewers = [],
  reviewerMaxRounds = {},
  reviewerModels = {},
  reviewerEfforts = {},
  modelOptions = null,
  installed = null,
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
  // Shared shape for the three token-keyed maps below (`~max=<n>` caps, model
  // pins, effort pins). All key on the same emitted `--review-with` token and all
  // need the same case-insensitive read / key-preserving delete, so the lookup
  // helpers are generated once rather than written three times.
  const asMap = (value) => (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  const keyedLookup = (map) => ({
    get: (token) => {
      const key = Object.keys(map).find(k => k.toLowerCase() === token.toLowerCase());
      return key === undefined ? undefined : map[key];
    },
    without: (token) => Object.fromEntries(
      Object.entries(map).filter(([k]) => k.toLowerCase() !== token.toLowerCase())
    )
  });
  // Per-reviewer `~max=<n>` round caps, keyed by the same emitted token. Absent
  // key = no cap requested (slashdo's built-in default stands); `0` = loop until
  // clean. The two must never collapse, so the input renders '' for absent and
  // clearing it DELETES the key rather than writing 0 (server
  // `normalizeReviewerMaxRounds` owns the authoritative shape).
  const maxRoundsMap = asMap(reviewerMaxRounds);
  const maxRounds = keyedLookup(maxRoundsMap);
  // Per-reviewer model pins, same token keying. Absent key = "let that reviewer
  // pick its own default", which is NOT an empty string — so clearing the field
  // DELETES the key rather than persisting `''` (a `--model ` with no id).
  const modelsMap = asMap(reviewerModels);
  const models = keyedLookup(modelsMap);
  // Per-reviewer reasoning-effort pins, same token keying and same absent-vs-empty
  // contract as the model pins: no key = "let that reviewer think however it
  // normally does", so clearing the select DELETES the key rather than writing `''`.
  const effortsMap = asMap(reviewerEfforts);
  const efforts = keyedLookup(effortsMap);
  // Only an explicit `false` counts — `undefined` covers both "not a CLI
  // reviewer" (copilot/lmstudio/ollama/@username) and "caller didn't fetch
  // `installed`", neither of which should render a warning badge.
  const notInstalled = (token) => installed?.[token] === false;
  const renderInstalledBadge = (token) => notInstalled(token) && (
    <Pill
      tone="warning"
      size="xs"
      className="shrink-0"
      title={`${reviewerLabel(token)}'s CLI binary wasn't found on this machine. It still runs (federation-wide config), but the review loop here will report it unsatisfied until it's installed.`}
    >
      not installed
    </Pill>
  );

  const emit = (next) => onChange?.({
    reviewers: selected,
    usernames: selectedUsernames,
    optionalReviewers: optionalTokens,
    reviewerMaxRounds: maxRoundsMap,
    reviewerModels: modelsMap,
    reviewerEfforts: effortsMap,
    stopMode,
    reviewerApplies,
    ...next
  });

  const toggleOptional = (token) => emit({
    optionalReviewers: isOptional(token) ? withoutToken(token) : [...optionalTokens, token]
  });

  // Blank clears the cap entirely (back to slashdo's built-in default). The two
  // out-of-range directions are deliberately NOT symmetric, because only one of
  // them can change what the value MEANS:
  //  - A negative or non-integer entry is REJECTED (the emit is skipped, so the
  //    controlled input snaps back). Coercing it would land on `0`, which is
  //    slashdo's "loop until clean" — turning a typo into an unlimited loop, the
  //    exact absent-vs-0 collapse the server's normalizer refuses.
  //  - A value above the ceiling clamps DOWN to it. That can only ever shrink a
  //    budget, never make it unlimited, and it matches the input's `max`.
  const setMaxRounds = (token, raw) => {
    if (raw === '') {
      emit({ reviewerMaxRounds: maxRounds.without(token) });
      return;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    const capped = Math.min(parsed, MAX_REVIEWER_MAX_ROUNDS);
    emit({ reviewerMaxRounds: { ...maxRounds.without(token), [token]: capped } });
  };

  // Blank (or whitespace-only) clears the pin so the reviewer falls back to its
  // own default — the DELETE, not an empty-string write, because `''` is not a
  // model id the reviewer could run. Mirrors the server normalizer, which drops a
  // blank value rather than persisting it.
  //
  // Structural characters (`[`, `]`, `,`, line breaks) are stripped first: they'd
  // corrupt the emitted `[<model>]` selector and the server drops any id carrying
  // one, so accepting them here would show the user a pin that never persists.
  const setModel = (token, raw) => {
    const model = sanitizeReviewerModelInput(raw).trim();
    if (!model) {
      emit({ reviewerModels: models.without(token) });
      return;
    }
    emit({ reviewerModels: { ...models.without(token), [token]: model } });
  };

  // Blank clears the pin so the reviewer reasons at its own default — the DELETE,
  // not an empty-string write, same absent-vs-empty contract as setModel.
  //
  // No sanitizing pass (unlike setModel, whose input is free text): the value can
  // only be one of the exact levels renderEffortCell rendered, and the one
  // out-of-ladder option it renders is already the selected value, so picking it
  // fires no change.
  const setEffort = (token, level) => emit({
    reviewerEfforts: level ? { ...efforts.without(token), [token]: level } : efforts.without(token)
  });

  // The "this reviewer has no such control" cell, shared by the Model and Effort
  // columns so both read identically when the pin doesn't apply.
  const renderNoPinCell = (title) => (
    <span className="text-[11px] text-gray-700" title={title}>—</span>
  );

  // The closed-list pin `<select>` behind both the Effort column and the Model
  // column's local-backend variant. They share one non-obvious contract: a stored
  // value that is no longer in `options` (pinned on another machine, or before a
  // CLI dropped a tier / a model was uninstalled) STILL gets an `<option>` — a
  // select whose value isn't in its list renders blank and reads as "unset" while
  // the value is in fact stored. `staleSuffix` names why it's absent; `setClass`
  // differs only so the two columns stay visually distinguishable — passed as a
  // COMPLETE class string, never interpolated, or Tailwind's scanner won't emit it.
  const renderPinSelect = ({ selectId, value, options, onChange, ariaLabel, title, staleSuffix, setClass, maxWidthClass }) => (
    <select
      id={selectId}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      title={title}
      className={`w-full min-w-0 ${maxWidthClass} px-1.5 py-0.5 text-[11px] font-mono rounded border bg-port-bg min-h-[28px] disabled:opacity-40 focus:outline-none focus:border-port-accent ${value
        ? setClass
        : 'text-gray-500 border-port-border/60'}`}
    >
      <option value="">— default —</option>
      {value && !options.includes(value) && <option value={value}>{value} {staleSuffix}</option>}
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );

  // The Effort cell. Only EFFORT_SELECTABLE_REVIEWERS get one, and each offers
  // only its own CLI's ladder — copilot has no CLI, grok's takes no effort flag,
  // and a `@username` reviewer is a person.
  //
  // The ladder is narrowed by the row's PINNED MODEL where the CLI validates the
  // pair: `agy` rejects `gemini-3.1-pro --effort medium`, so offering `medium`
  // there would store and emit an invocation it refuses (#3733). The narrowing
  // needs the provider catalog, which the caller already fetched — falling back to
  // the static ladder when it didn't, so a caller that passes no `modelOptions`
  // keeps a working (just unnarrowed) select rather than losing the cell.
  const renderEffortCell = (token) => {
    const subject = reviewerLabel(token);
    const stored = efforts.get(token) ?? '';
    const ladder = reviewerEffortLevels(token);
    if (!ladder?.length) return renderNoPinCell(`${subject} has no reasoning-effort control`);
    const levels = modelOptions?.modelEffortLevels?.(token, models.get(token)) ?? ladder;
    // A pinned model whose catalog lists NO tiers still renders the select when
    // something is stored, so a pin made before the model changed (or on another
    // machine) stays visible and clearable rather than vanishing behind the dash.
    if (!levels.length && !stored) return renderNoPinCell(`${subject}'s pinned model offers no reasoning-effort tiers`);
    return renderPinSelect({
      selectId: `${id}-effort-${token}`,
      value: stored,
      options: levels,
      onChange: (level) => setEffort(token, level),
      ariaLabel: `Reasoning effort for ${subject}`,
      title: stored
        ? `${subject} reviews at ${stored} reasoning effort. Choose "default" to let it decide.`
        : `${subject} reasons at its own default. Pick a tier to make it think harder (slower, pricier) or lighter.`,
      staleSuffix: '(unsupported)',
      setClass: 'text-port-accent-2 border-port-accent-2/50',
      maxWidthClass: 'max-w-[8rem]'
    });
  };

  // The `~opt` non-blocking toggle rendered on every reviewer/username row.
  // `subject` is the human name used in the aria-label; `title` is the (row-
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

  // The `~max=<n>` round-cap input rendered on every reviewer/username row.
  // Blank means "no cap" — the number input's empty string is the sentinel for an
  // absent key, distinct from a typed `0` (loop until clean).
  const renderMaxRounds = (token, subject) => {
    const value = maxRounds.get(token);
    const inputId = `${id}-max-${token}`;
    return (
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
        className={`w-12 px-1 py-0.5 text-[11px] font-mono leading-none text-center rounded border bg-port-bg min-h-[28px] disabled:opacity-40 focus:outline-none focus:border-port-accent ${value === undefined
          ? 'text-gray-500 border-port-border/60 hover:border-port-border'
          : 'text-port-accent-2 border-port-accent-2/50'}`}
      />
    );
  };

  // The Model cell. Only MODEL_SELECTABLE_REVIEWERS get one — copilot has no CLI
  // and a `@username` reviewer is a person/bot, so neither takes a model.
  //
  // A local backend's installed-model list is authoritative (the server probed
  // it), so those render a closed `<select>`. A CLI reviewer renders a text input
  // + `<datalist>` instead: its catalog is a stored snapshot, and an Ollama-backed
  // `claude` or a Bedrock-form id can be anything the environment provides — a
  // closed list would lock out valid ids. `loaded` gates the "nothing installed"
  // messaging so a pre-fetch render doesn't accuse a healthy backend of being
  // empty.
  const renderModelCell = (token) => {
    if (!MODEL_SELECTABLE_REVIEWERS.includes(token)) return renderNoPinCell(`${reviewerLabel(token)} takes no model`);
    const subject = reviewerLabel(token);
    const value = models.get(token) ?? '';
    const options = modelOptions?.optionsByReviewer?.[token] || [];
    const inputId = `${id}-model-${token}`;
    const listId = `${id}-modellist-${token}`;
    // No resolved options AND a closed picker would be a dead control, so fall
    // back to free-text: better a typed id than no way to set one at all.
    const freeText = modelOptions?.freeText?.[token] !== false || options.length === 0;
    // Why a local backend has no options, so the empty state says the useful
    // thing instead of a bare "default" placeholder. Only meaningful once the
    // probe settled — before that, an empty list is "not fetched yet", not a fact.
    const emptyHint = (options.length === 0 && modelOptions?.loaded)
      ? (modelOptions?.unavailable?.[token]
          ? `${subject} isn't reachable — start it from Settings → Local LLMs to list its models. You can still type an id.`
          : `No ${subject} models listed — add one in Settings → Local LLMs, or type an id.`)
      : null;

    if (!freeText) {
      return renderPinSelect({
        selectId: inputId,
        value,
        options,
        onChange: (model) => setModel(token, model),
        ariaLabel: `Model for ${subject}`,
        title: value
          ? `${subject} reviews with ${value}. Choose "default" to let it pick.`
          : `${subject} uses the model configured for its backend. Pick one to pin it for this run.`,
        staleSuffix: '(not installed)',
        setClass: 'text-port-accent border-port-accent/50',
        maxWidthClass: 'max-w-[190px]'
      });
    }

    return (
      <>
        <input
          id={inputId}
          type="text"
          list={options.length ? listId : undefined}
          value={value}
          disabled={disabled}
          maxLength={MAX_REVIEWER_MODEL_LENGTH}
          placeholder="default"
          onChange={(e) => setModel(token, e.target.value)}
          aria-label={`Model for ${subject}`}
          title={value
            ? `${subject} reviews with ${value}. Clear to let it use its own default.`
            : (emptyHint || `${subject} uses its own default model. Type or pick an id to pin one.`)}
          className={`w-full min-w-0 max-w-[190px] px-1.5 py-0.5 text-[11px] font-mono rounded border bg-port-bg min-h-[28px] disabled:opacity-40 focus:outline-none focus:border-port-accent ${value
            ? 'text-port-accent border-port-accent/50'
            : 'text-gray-500 border-port-border/60'}`}
        />
        {options.length > 0 && (
          <datalist id={listId}>
            {options.map((m) => <option key={m} value={m}>{m}</option>)}
          </datalist>
        )}
      </>
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
    reviewerMaxRounds: maxRounds.without(`@${value}`),
    // A username row has no Model cell, but prune anyway: a hand-edited settings
    // file (or a future reviewer that gains one) must not leave an orphan pin.
    reviewerModels: models.without(`@${value}`),
    reviewerEfforts: efforts.without(`@${value}`)
  });

  const add = (value) => emit({ reviewers: [...selected, value] });
  const remove = (value) => emit({
    reviewers: selected.filter(r => r !== value),
    optionalReviewers: withoutToken(value),
    reviewerMaxRounds: maxRounds.without(value),
    reviewerModels: models.without(value),
    reviewerEfforts: efforts.without(value)
  });
  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= selected.length) return;
    const next = [...selected];
    [next[index], next[target]] = [next[target], next[index]];
    emit({ reviewers: next });
  };

  // Shared row grid. Desktop is a 5-column table (order · provider · model ·
  // optional · max · remove); under `sm` it collapses to a stacked 2-column
  // label/value block so a narrow screen never needs horizontal scrolling. The
  // header row is desktop-only — on mobile each cell carries its own inline
  // label, since a header far above a stacked row doesn't associate.
  const ROW_CLASS = 'grid grid-cols-[auto_1fr] sm:grid-cols-[2.5rem_minmax(5rem,1fr)_minmax(0,2fr)_minmax(0,7rem)_auto_3.25rem_auto] items-center gap-x-2 gap-y-1 px-1.5 py-1.5 rounded border border-port-border bg-port-bg sm:border-transparent sm:bg-transparent sm:py-0.5 sm:rounded-none';
  const CELL_LABEL_CLASS = 'sm:hidden text-[10px] uppercase tracking-wide text-gray-600';
  const HEADER_CLASS = 'hidden sm:grid sm:grid-cols-[2.5rem_minmax(5rem,1fr)_minmax(0,2fr)_minmax(0,7rem)_auto_3.25rem_auto] items-center gap-x-2 px-1.5 text-[10px] uppercase tracking-wide text-gray-600';

  return (
    <div className="flex flex-col gap-2 w-full">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Reviewers (in order):</span>
        {selected.length > 0 && (
          <>
            <div className={HEADER_CLASS} aria-hidden="true">
              <span>#</span>
              <span>Provider</span>
              <span>Model</span>
              <span>Effort</span>
              <span>Optional</span>
              <span className="text-center">Max</span>
              <span className="sr-only">Remove</span>
            </div>
            <div className="flex flex-col gap-1.5 sm:gap-0.5">
              {selected.map((value, index) => (
                <div
                  key={value}
                  className={ROW_CLASS}
                  title={REVIEWER_OPTIONS.find(o => o.value === value)?.description}
                >
                  <div className="flex items-center gap-0.5 col-span-2 sm:col-span-1">
                    <span className="text-port-accent font-mono text-xs">{index + 1}.</span>
                    <button
                      type="button"
                      disabled={disabled || index === 0}
                      onClick={() => move(index, -1)}
                      className="text-gray-500 hover:text-white disabled:opacity-30 disabled:hover:text-gray-500"
                      aria-label={`Move ${reviewerLabel(value)} earlier`}
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      disabled={disabled || index === selected.length - 1}
                      onClick={() => move(index, 1)}
                      className="text-gray-500 hover:text-white disabled:opacity-30 disabled:hover:text-gray-500"
                      aria-label={`Move ${reviewerLabel(value)} later`}
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>
                  <span className="flex items-center gap-1 min-w-0 col-span-2 sm:col-span-1">
                    <span className="text-xs text-gray-300 truncate">{reviewerLabel(value)}</span>
                    {renderInstalledBadge(value)}
                  </span>
                  <span className={CELL_LABEL_CLASS}>Model</span>
                  <div className="min-w-0">{renderModelCell(value)}</div>
                  <span className={CELL_LABEL_CLASS}>Effort</span>
                  <div className="min-w-0">{renderEffortCell(value)}</div>
                  <span className={CELL_LABEL_CLASS}>Optional</span>
                  <div>
                    {renderOptToggle(value, reviewerLabel(value), isOptional(value)
                      ? `${reviewerLabel(value)} is non-blocking (~opt): an inconclusive verdict from it won't block the merge. Click to make it blocking.`
                      : `${reviewerLabel(value)} gates the merge. Click to make it non-blocking (~opt) — its inconclusive verdicts won't block the merge (a hard failure still does).`)}
                  </div>
                  <span className={CELL_LABEL_CLASS}>Max iterations</span>
                  <div>{renderMaxRounds(value, reviewerLabel(value))}</div>
                  <div className="col-span-2 sm:col-span-1 justify-self-end">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => remove(value)}
                      className="text-gray-500 hover:text-port-error"
                      aria-label={`Remove ${reviewerLabel(value)}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {selected.length === 0 && (
          <span className="text-xs text-gray-600 italic">none — defaults to Copilot</span>
        )}
      </div>

      {(selected.length > 0 || selectedUsernames.length > 0) && (
        <span className="text-[11px] text-gray-600">
          Tip: <span className="font-mono text-port-accent">Model</span> pins the model that reviewer runs (blank = its own default), and <span className="font-mono text-port-accent-2">Effort</span> pins how hard it reasons — higher is slower and pricier, and each reviewer only offers the tiers its own CLI accepts. The <span className="font-mono text-port-warning">~opt</span> badge marks a reviewer <em>non-blocking</em> — it still runs and its findings are still fixed, but an inconclusive verdict (timeout / no result) won't block the merge. A hard failure still does. <span className="font-mono text-port-accent-2">Max</span> caps that reviewer's review → fix → re-review rounds (blank = its built-in cap, <span className="font-mono">0</span> = loop until clean) — a small cap keeps a slow local model affordable.
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
              {renderInstalledBadge(opt.value)}
            </button>
          ))}
        </div>
      )}

      {/* GitHub reviewer usernames — arbitrary PR reviewers (bots/humans) that
          gate the merge. Appended to `--review-with` as `@user` tokens. Same row
          grid as the keyed reviewers so the columns line up, minus reorder (their
          order is fixed after the keyed list) and minus a Model cell. */}
      <div className="flex flex-col gap-1.5 pt-1 border-t border-port-border/50">
        <span className="text-xs text-gray-500">GitHub reviewers (gate merge):</span>
        {selectedUsernames.length > 0 ? (
          <div className="flex flex-col gap-1.5 sm:gap-0.5">
            {selectedUsernames.map((value) => (
              <div
                key={value}
                className={ROW_CLASS}
                title="GitHub username requested as a PR reviewer to gate the merge"
              >
                <span className="text-port-accent font-mono text-xs col-span-2 sm:col-span-1">@</span>
                <span className="text-xs text-gray-300 col-span-2 sm:col-span-1 truncate">{value}</span>
                <span className={CELL_LABEL_CLASS}>Model</span>
                <div className="min-w-0">{renderModelCell(`@${value}`)}</div>
                <span className={CELL_LABEL_CLASS}>Effort</span>
                <div className="min-w-0">{renderEffortCell(`@${value}`)}</div>
                <span className={CELL_LABEL_CLASS}>Optional</span>
                <div>
                  {renderOptToggle(`@${value}`, `@${value}`, isOptional(`@${value}`)
                    ? `@${value} is non-blocking (~opt): if it never submits a review, the merge isn't blocked. Click to make it blocking.`
                    : `@${value} gates the merge. Click to make it non-blocking (~opt) — a missing/timed-out review from it won't block the merge.`)}
                </div>
                <span className={CELL_LABEL_CLASS}>Max iterations</span>
                <div>{renderMaxRounds(`@${value}`, `@${value}`)}</div>
                <div className="col-span-2 sm:col-span-1 justify-self-end">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => removeUsername(value)}
                    className="text-gray-500 hover:text-port-error"
                    aria-label={`Remove @${value}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-xs text-gray-600 italic">none</span>
        )}
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
