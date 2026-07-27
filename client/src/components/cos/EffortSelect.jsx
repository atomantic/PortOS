import { useId } from 'react';
import { effortLevelsForProvider } from '../../utils/providers';
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
 * @param {string} props.value - Current effort ('' = provider default).
 * @param {function} props.onChange - Called with the new effort string.
 * @param {string} [props.label] - Field label; enables the FormField wrapper.
 * @param {import('react').ReactNode} [props.hint] - Help text under the select (needs `label`).
 * @param {string} [props.className] - Classes for the <select>.
 * @param {string} [props.fieldClassName] - Classes for the FormField wrapper.
 * @param {string} [props.labelClassName] - Classes for the FormField label.
 * @param {boolean} [props.disabled] - Disable the select (e.g. while saving).
 */
export default function EffortSelect({
  provider,
  value,
  onChange,
  label,
  hint,
  className = '',
  fieldClassName,
  labelClassName,
  disabled = false
}) {
  const id = useId();
  const levels = effortLevelsForProvider(provider);
  if (!levels) return null;

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
