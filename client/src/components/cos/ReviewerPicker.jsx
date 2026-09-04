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
import { normalizeReviewerSlug } from '../../lib/reviewerPins';

const normalizeReviewerValue = (value) => normalizeReviewerSlug(value);

// The Model dropdown's "type an id instead" entry. Carries a `[`/`]` pair on
// purpose: `sanitizeReviewerModelInput` strips both, so this string can never
// arrive from the free-text input and be mistaken for a stored pin — and the
// server drops any id containing them, so it could not have been persisted by an
// older build either.
const CUSTOM_MODEL_OPTION = '[custom]';

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
 * - **Effort** → the reviewer's reasoning-effort tier, emitted as slashdo's
 *   `~effort=<level>` entry suffix and, where PortOS spells the invocation out
 *   itself, as the flag that CLI actually takes: `claude --effort high` /
 *   `codex -c model_reasoning_effort=high`, `"effort"` in the
 *   `/api/code-review/local` body for a local reviewer, and — for `cursor`,
 *   whose CLI has no `--effort` flag at all — folded into the model id as
 *   Cursor's own variant syntax (`--model gpt-5[effort=max]`), which needs the
 *   row's Model cell filled in to have anything to attach to. Only rendered for
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
 * `useReviewerModelOptions()`'s return: `{ optionsByReviewer, defaultModels,
 * freeText, unavailable, providerDisabled, loaded }`. Callers keep owning their
 * own `api.getLocalLlmStatus` / `api.getProviders` fetches (that's what the hook
 * is for) — passing nothing degrades every Model cell to a free-text input, which
 * is still fully usable, rather than hiding the column.
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
 * `false` counts as missing; `undefined` (not a CLI reviewer, or the caller
 * didn't fetch it) says nothing.
 *
 * Together with `modelOptions.providerDisabled`, that decides which reviewers
 * the **Add** row offers up front: one whose CLI is missing here, or whose
 * provider records are all switched off, is folded behind a `+N unavailable`
 * toggle. Warn-only either way — the toggle reveals them with a badge and they
 * stay selectable, and an ALREADY-SELECTED reviewer always renders its row
 * (badged), since both checks are local-machine-only and the reviewer list is
 * federation-wide config a peer may satisfy.
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
  // Reviewers whose Model cell the user switched to free text by picking the
  // "Custom…" entry. Lowercased tokens, matching the case-insensitive keying the
  // pin maps use. Purely presentational — nothing is stored until an id is typed,
  // so this never has to round-trip through `onChange`.
  const [customModelTokens, setCustomModelTokens] = useState(() => new Set());
  // Whether the Add row also lists the reviewers this machine can't run (see
  // `hiddenAddable`). Presentational only — nothing about it is stored.
  const [showUnavailable, setShowUnavailable] = useState(false);
  const isCustomModel = (token) => customModelTokens.has(token.toLowerCase());
  const setCustomModel = (token, on) => setCustomModelTokens((prev) => {
    const next = new Set(prev);
    if (on) next.add(token.toLowerCase()); else next.delete(token.toLowerCase());
    return next;
  });
  // Render the parent's list (de-duped, order-preserving) so display === stored
  // state for valid input while staying robust to malformed/legacy duplicates —
  // dupes would otherwise collide on the `key={value}` below and corrupt
  // reorder/remove. An empty list shows the "follows your default AI provider"
  // hint and lets the user clear the chain entirely; the server resolves [] to
  // the active provider's own reviewer (falling back to copilot when that
  // provider maps to none) — see `codeReviewDefaultsFromProvider`.
  const selected = Array.isArray(reviewers) ? [...new Set(reviewers.map(normalizeReviewerValue))] : [];
  const addable = REVIEWER_OPTIONS.filter(o => !selected.includes(o.value));
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
  // Why this reviewer can't run here, or null when nothing says it can't.
  //
  // Two independent signals, both warn-only and both reported only when the
  // caller actually fetched them — a reviewer stays selectable and selected
  // either way, since the checks are local-machine-only and a federated peer
  // (or a later install / a flip in Settings) may satisfy them:
  //
  // - `installed[token] === false` — the CLI binary isn't on PATH. Only an
  //   explicit `false` counts; `undefined` covers both "not a CLI reviewer"
  //   (copilot/@username) and "caller didn't fetch `installed`".
  // - `providerDisabled[token]` — every provider record fronting that binary is
  //   switched off on this install, so the user has said they don't use it. A
  //   `/api/providers` that failed or hasn't landed reports nothing (see the
  //   hook), so this never fires on a slow page.
  const unavailability = (token) => {
    if (installed?.[token] === false) {
      return {
        label: 'not installed',
        title: `${reviewerLabel(token)}'s CLI binary wasn't found on this machine. It still runs (federation-wide config), but the review loop here will report it unsatisfied until it's installed.`
      };
    }
    if (modelOptions?.providerDisabled?.[token]) {
      return {
        label: 'disabled',
        title: `${reviewerLabel(token)}'s provider records are all switched off in Settings → AI Providers, so this machine isn't set up to use it. Adding it still works — the review loop spawns its CLI directly, and a federated peer may have it enabled.`
      };
    }
    return null;
  };
  const renderUnavailableBadge = (token) => {
    const reason = unavailability(token);
    return reason && (
      <Pill tone="warning" size="xs" className="shrink-0" title={reason.title}>
        {reason.label}
      </Pill>
    );
  };
  // The Add row lists what this machine can actually run, so a reviewer whose
  // CLI is missing or whose providers are all switched off is folded behind a
  // count instead of padding the row with things the review loop would report
  // unsatisfied. HIDDEN, not dropped: the checks are local-machine-only and the
  // reviewer list is federation-wide config, so the toggle reveals them (badged)
  // rather than making a peer's reviewer unconfigurable from here.
  const hiddenAddable = addable.filter(opt => unavailability(opt.value));
  const addOptions = showUnavailable
    ? addable
    : addable.filter(opt => !hiddenAddable.includes(opt));

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
  //
  // `trailingOption` appends one non-model entry after the list (the Model
  // column's "Custom…" escape). It is a UI action, not a pin — the caller's
  // `onChange` recognizes its sentinel value and never stores it.
  const renderPinSelect = ({ selectId, value, options, onChange, ariaLabel, title, staleSuffix, setClass, maxWidthClass, trailingOption = null }) => (
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
      {trailingOption && <option value={trailingOption.value}>{trailingOption.label}</option>}
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
    // Cursor's level is a PARAMETER OF ITS MODEL ID (`gpt-5[effort=max]`) — its
    // CLI has no `--effort` flag — so a level with no Model pin has nothing to
    // attach to and is dropped when the invocation is built. Say so here rather
    // than let the row display a tier the review will not run at.
    const cursorNeedsModel = normalizeReviewerValue(token) === 'cursor' && !models.get(token);
    return renderPinSelect({
      selectId: `${id}-effort-${token}`,
      value: stored,
      options: levels,
      onChange: (level) => setEffort(token, level),
      ariaLabel: `Reasoning effort for ${subject}`,
      title: cursorNeedsModel
        ? `${subject} carries its reasoning effort inside the model id, so pin a Model too — a tier with no model is not passed to the CLI.`
        : stored
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
  // Every reviewer with a resolved catalog renders a `<select>`: the ids are
  // known, and a dropdown is how the rest of this table's pins are set. What
  // differs between the two reviewer kinds is the ESCAPE HATCH, not the control:
  //
  // - A probed local backend's installed-model list is authoritative (the server
  //   asked the running daemon), so its select is closed — an id it doesn't list
  //   isn't installed.
  // - A CLI reviewer's catalog is a stored snapshot, and an Ollama-backed
  //   `claude` or a Bedrock-form id can be anything the environment provides, so
  //   its select carries a trailing "Custom…" entry that swaps the cell for a
  //   free-text input (with the same ids offered as a `<datalist>`). Clearing
  //   that input returns the cell to the dropdown. A CLI reviewer whose catalog
  //   resolved EMPTY (grok/kimi/opencode ship only a configured-default sentinel)
  //   starts in the free-text form directly — a select of nothing is a dead
  //   control — and so does a row already pinned to an id outside the catalog, so
  //   that pin stays editable rather than reading as an unpickable oddity.
  //
  // `loaded` gates the "nothing installed" messaging so a pre-fetch render
  // doesn't accuse a healthy backend of being empty.
  const renderModelCell = (token) => {
    if (!MODEL_SELECTABLE_REVIEWERS.includes(token)) return renderNoPinCell(`${reviewerLabel(token)} takes no model`);
    const subject = reviewerLabel(token);
    const pinnedValue = models.get(token);
    const value = pinnedValue ?? '';
    const defaultModel = modelOptions?.defaultModels?.[token] || '';
    const options = modelOptions?.optionsByReviewer?.[token] || [];
    const inputId = `${id}-model-${token}`;
    const listId = `${id}-modellist-${token}`;
    // Whether this reviewer may carry an id its catalog doesn't list at all.
    const acceptsTypedId = modelOptions?.freeText?.[token] !== false;
    // Why a local backend has no options, so the empty state says the useful
    // thing instead of a bare "default" placeholder. Only meaningful once the
    // probe settled — before that, an empty list is "not fetched yet", not a fact.
    const emptyHint = (options.length === 0 && modelOptions?.loaded)
      ? (modelOptions?.unavailable?.[token]
          ? `${subject} isn't reachable — start it from Models → LLMs to list its models. You can still type an id.`
          : `No ${subject} models listed — add one in Models → LLMs, or type an id.`)
      : null;
    // A closed select over nothing would be a dead control, so a reviewer with no
    // resolved options falls back to free text whichever kind it is: better a
    // typed id than no way to set one at all.
    const freeText = acceptsTypedId
      ? (options.length === 0 || isCustomModel(token) || (Boolean(value) && !options.includes(value)))
      : options.length === 0;

    if (!freeText) {
      return renderPinSelect({
        selectId: inputId,
        value: value || (defaultModel && options.includes(defaultModel) ? defaultModel : ''),
        options,
        onChange: (model) => {
          // The escape hatch is a UI mode, not an id — never store the sentinel.
          if (model === CUSTOM_MODEL_OPTION) { setCustomModel(token, true); return; }
          setModel(token, model);
        },
        ariaLabel: `Model for ${subject}`,
        title: value
          ? `${subject} reviews with ${value}. Choose "default" to let it pick.`
          : defaultModel
            ? `${subject} uses ${defaultModel} by default. Choose another model to pin it for this run.`
          : `${subject} uses the model configured for its backend. Pick one to pin it for this run.`,
        staleSuffix: '(not installed)',
        setClass: 'text-port-accent border-port-accent/50',
        maxWidthClass: 'max-w-[190px]',
        // Only a reviewer that can run an id outside its catalog gets the escape.
        trailingOption: acceptsTypedId ? { value: CUSTOM_MODEL_OPTION, label: 'Custom…' } : null
      });
    }

    // "Custom…" was picked with nothing pinned yet — start empty so the field
    // reads as the blank the user is about to fill, not as an id already in play.
    const inputValue = value || (isCustomModel(token) ? '' : defaultModel);
    return (
      <>
        <input
          id={inputId}
          type="text"
          list={options.length ? listId : undefined}
          value={inputValue}
          disabled={disabled}
          maxLength={MAX_REVIEWER_MODEL_LENGTH}
          placeholder={defaultModel ? `${defaultModel} (default)` : 'default'}
          onChange={(e) => setModel(token, e.target.value)}
          // Leaving the field with nothing pinned is how the user backs out of
          // Custom…: with no id to keep, the catalog dropdown is the more useful
          // control. Deliberately on blur rather than on an empty onChange —
          // clearing the field to retype an id would otherwise swap the control
          // out from under the cursor mid-edit.
          onBlur={() => { if (!value && options.length) setCustomModel(token, false); }}
          aria-label={`Model for ${subject}`}
          title={value
            ? `${subject} reviews with ${value}. Clear to let it use its own default.`
            : (options.length
              ? `Type an id ${subject} accepts. Leave it empty to go back to its listed models.`
              : (defaultModel
                ? `${subject} uses ${defaultModel} by default. Type an id to pin one.`
                : (emptyHint || `${subject} uses its own default model. Type an id to pin one.`)))}
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

  // Shared row grid. Desktop keeps minimum tracks for order, provider, model,
  // effort, optional, max, and remove; under `sm` it collapses to a stacked
  // 2-column label/value block so a narrow screen never needs horizontal
  // scrolling. The header row is desktop-only — on mobile each cell carries
  // its own inline label, since a header far above a stacked row doesn't
  // associate.
  const ROW_CLASS = 'grid grid-cols-[auto_1fr] sm:grid-cols-[2.5rem_minmax(5rem,1fr)_minmax(8rem,2fr)_minmax(7rem,1fr)_auto_3.25rem_auto] items-center gap-x-2 gap-y-1 px-1.5 py-1.5 rounded border border-port-border bg-port-bg sm:border-transparent sm:bg-transparent sm:py-0.5 sm:rounded-none';
  const CELL_LABEL_CLASS = 'sm:hidden text-[10px] uppercase tracking-wide text-gray-600';
  const HEADER_CLASS = 'hidden sm:grid sm:grid-cols-[2.5rem_minmax(5rem,1fr)_minmax(8rem,2fr)_minmax(7rem,1fr)_auto_3.25rem_auto] items-center gap-x-2 px-1.5 text-[10px] uppercase tracking-wide text-gray-600';

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
                    {renderUnavailableBadge(value)}
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
          <span className="text-xs text-gray-600 italic">none — follows your default AI provider</span>
        )}
      </div>

      {(selected.length > 0 || selectedUsernames.length > 0) && (
        <details className="text-[11px] text-gray-600">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300">Tip: reviewer controls</summary>
          <p className="mt-1">
            <span className="font-mono text-port-accent">Model</span> pins the model that reviewer runs (the shown default is used when no override is saved), and <span className="font-mono text-port-accent-2">Effort</span> pins how hard it reasons — higher is slower and pricier, and each reviewer only offers the tiers its own CLI accepts. The <span className="font-mono text-port-warning">~opt</span> badge marks a reviewer <em>non-blocking</em> — it still runs and its findings are still fixed, but an inconclusive verdict (timeout / no result) won't block the merge. A hard failure still does. <span className="font-mono text-port-accent-2">Max</span> caps that reviewer's review → fix → re-review rounds (blank = its built-in cap, <span className="font-mono">0</span> = loop until clean) — a small cap keeps a slow local model affordable.
          </p>
        </details>
      )}

      {addable.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-600 mr-1">Add:</span>
          {addOptions.map(opt => (
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
              {renderUnavailableBadge(opt.value)}
            </button>
          ))}
          {hiddenAddable.length > 0 && (
            <button
              type="button"
              onClick={() => setShowUnavailable(!showUnavailable)}
              className="px-1.5 py-0.5 text-xs text-gray-600 hover:text-gray-300 underline decoration-dotted"
              title={showUnavailable
                ? 'Hide the reviewers whose CLI is missing or whose providers are switched off on this machine'
                : `Show ${hiddenAddable.length} reviewer${hiddenAddable.length === 1 ? '' : 's'} whose CLI isn't installed here or whose providers are all switched off — still addable for a federated peer that has them`}
            >
              {showUnavailable
                ? 'hide unavailable'
                : `+${hiddenAddable.length} unavailable`}
            </button>
          )}
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
            aria-label="Add reviewer username"
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
