import { isProviderReviewer } from '../../lib/reviewerPins';
import { MAX_REVIEWER_MODEL_LENGTH, MODEL_SELECTABLE_REVIEWERS } from './constants';

// The Model dropdown's "type an id instead" entry. Carries a `[`/`]` pair on
// purpose: `sanitizeReviewerModelInput` strips both, so this string can never
// arrive from the free-text input and be mistaken for a stored pin — and the
// server drops any id containing them, so it could not have been persisted by an
// older build either.
const CUSTOM_MODEL_OPTION = '[custom]';

// The "this reviewer has no such control" cell, shared by the Model and Effort
// columns so both read identically when the pin doesn't apply.
export const renderNoPinCell = (title) => (
  <span className="text-[11px] text-gray-400" title={title}>—</span>
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
export const renderPinSelect = ({ disabled, selectId, value, options, onChange, ariaLabel, title, staleSuffix, setClass, maxWidthClass, trailingOption = null }) => (
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
export default function ReviewerModelCell({
  id, token, subject, pinnedValue, modelOptions, backendPage, disabled, customModel, onCustomModel, onModel,
}) {
  if (!MODEL_SELECTABLE_REVIEWERS.includes(token) && !isProviderReviewer(token)) return renderNoPinCell(`${subject} takes no model`);
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
        ? `${subject} isn't reachable${backendPage ? ` — start it from ${backendPage}` : ''} to list its models. You can still type an id.`
        : `No ${subject} models listed${backendPage ? ` — add one in ${backendPage}` : ''}, or type an id.`)
    : null;
  // A closed select over nothing would be a dead control, so a reviewer with no
  // resolved options falls back to free text whichever kind it is: better a
  // typed id than no way to set one at all.
  const freeText = acceptsTypedId
    ? (options.length === 0 || customModel || (Boolean(value) && !options.includes(value)))
    : options.length === 0;

  if (!freeText) {
    return renderPinSelect({
      disabled, selectId: inputId,
      value: value || (defaultModel && options.includes(defaultModel) ? defaultModel : ''),
      options,
      onChange: (model) => {
        // The escape hatch is a UI mode, not an id — never store the sentinel.
        if (model === CUSTOM_MODEL_OPTION) { onCustomModel(true); return; }
        onModel(model);
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
  const inputValue = value || (customModel ? '' : defaultModel);
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
        onChange={(e) => onModel(e.target.value)}
        // Leaving the field with nothing pinned is how the user backs out of
        // Custom…: with no id to keep, the catalog dropdown is the more useful
        // control. Deliberately on blur rather than on an empty onChange —
        // clearing the field to retype an id would otherwise swap the control
        // out from under the cursor mid-edit.
        onBlur={() => { if (!value && options.length) onCustomModel(false); }}
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
}
