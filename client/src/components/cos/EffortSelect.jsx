import { useId } from 'react';
import { effortLevelsForProvider, resolveCliEffort } from '../../utils/providers';
import { FormField } from '../ui/FormField';

/**
 * The single "thinking effort" override picker for effort-capable providers
 * (claude / codex). Renders nothing when the selected provider has no effort
 * tiers, so callers drop it in unconditionally next to a provider/model picker
 * — no `effortLevelsForProvider` guard of their own. `''` is the
 * "Default effort" sentinel, meaning no override is sent.
 *
 * Pass `label` to get the standard `FormField` wrapper (label + optional `hint`,
 * both hidden along with the select when the provider has no tiers). Omit it for
 * a bare `<select>`, e.g. inside a caller-owned flex row.
 *
 * @param {object} props
 * @param {object} [props.provider] - The selected provider record (not its id).
 * @param {string} [props.model] - The selected model. Antigravity's tiers are
 *   per-model (agy rejects `gemini-3.1-pro --effort medium`), so passing this
 *   narrows the options to the ones that model actually offers — and hides the
 *   select entirely for an Antigravity model with no tiers at all. Omit for the
 *   provider-wide ladder.
 * @param {string} props.value - Current effort ('' = provider default).
 * @param {function} props.onChange - Called with the new effort string.
 * @param {function} [props.optionFilter] - Optional `(effort, provider, model) => boolean`
 *   policy applied to the effort options. A selected disallowed value remains
 *   visible as a disabled/stale option so the caller can clear it.
 * @param {string} [props.id] - Id for the <select>, when the caller owns the
 *   `<label htmlFor>`. Defaults to a generated one (used by the FormField mode).
 * @param {string} [props.label] - Field label; enables the FormField wrapper.
 * @param {import('react').ReactNode} [props.hint] - Help text under the select (needs `label`).
 * @param {string} [props.className] - Classes for the <select>.
 * @param {string} [props.fieldClassName] - Classes for the FormField wrapper.
 * @param {string} [props.labelClassName] - Classes for the FormField label.
 * @param {boolean} [props.disabled] - Disable the select (e.g. while saving).
 */
export default function EffortSelect({
  provider,
  model = null,
  value,
  onChange,
  optionFilter,
  id: idProp,
  label,
  hint,
  className = '',
  fieldClassName,
  labelClassName,
  disabled = false
}) {
  const generatedId = useId();
  const id = idProp || generatedId;
  const allLevels = effortLevelsForProvider(provider, model);
  if (!allLevels) return null;
  const levels = allLevels?.filter((level) => !optionFilter || optionFilter(level, provider, model));

  // A stored effort can sit outside this provider's ladder — a task/stage
  // pinned to claude `max` whose provider was later switched to Antigravity
  // (which stops at `high`). The server CLAMPS rather than drops it, so the run
  // still gets an `--effort`. Render an explicit option naming both the stored
  // value and what it resolves to, or the select would hold a value matching no
  // option, render blank (reading as "Default effort"), and hide the fact that
  // the run uses the clamped level. Mirrors the stale-model option the pipeline
  // stage's Model select already renders.
  const outOfLadder = value && !levels.includes(value) ? value : null;
  const outOfLadderAllowed = !outOfLadder || !optionFilter || optionFilter(outOfLadder, provider, model);
  if (!levels.length && !outOfLadder) return null;
  const clamped = outOfLadder ? resolveCliEffort(outOfLadder, provider, model) : null;

  const select = (
    <select
      id={id}
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className={className}
      title="Thinking effort — how hard the model reasons per turn"
      aria-label={label ? undefined : 'Thinking effort'}
    >
      <option value="">Default effort</option>
      {outOfLadder && (
        <option
          value={outOfLadder}
          disabled={!outOfLadderAllowed}
        >
          {clamped ? `${outOfLadder} (runs as ${clamped})` : `${outOfLadder} (not supported — ignored)`}
          {!outOfLadderAllowed ? ' (not permitted here)' : ''}
        </option>
      )}
      {levels.map(level => (
        <option key={level} value={level}>{level}</option>
      ))}
    </select>
  );

  if (!label) return select;
  return (
    <FormField label={label} className={fieldClassName} labelClassName={labelClassName}>
      {select}
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </FormField>
  );
}
