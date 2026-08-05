/**
 * Subject-family picker, shared by the create form and the workspace so the two
 * cannot drift on labelling or on what an empty taxonomy does. Renders nothing
 * when the taxonomy could not be fetched — an empty select would look broken,
 * and generation is perfectly usable without a family.
 */
export default function SubjectFamilySelect({
  id,
  families,
  value,
  onChange,
  disabled = false,
  optional = false,
  showDescription = false,
  className = '',
}) {
  // Returning null (rather than an empty wrapper) is why the spacing lives on
  // this element: a caller's own margin div would leave a visible gap where the
  // picker isn't.
  if (families.length === 0) return null;
  const description = families.find((option) => option.id === value)?.description;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-xs text-gray-400">
        Subject family {optional && <span className="text-gray-600">(optional)</span>}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none disabled:opacity-50"
      >
        {families.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
      {showDescription && description && (
        <p className="mt-1 text-xs text-gray-500">{description}</p>
      )}
    </div>
  );
}
