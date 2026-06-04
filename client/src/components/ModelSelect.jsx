// Active + Legacy optgroup `<select>` shared by media-gen pages (VideoGen,
// CreativeDirector, the Pipeline episode-video stage). Splits `models` into
// active and `m.deprecated === true` groups; the Legacy optgroup only renders
// when at least one deprecated model exists. `getLabel` picks the option
// text — defaults to `m.name`; callers whose model shape may omit `name` pass
// `(m) => m.name || m.id`.
//
// `emptyOption` (optional) prepends a `value=""` option with that label — use
// it for "optional model / fall back to the server default" pickers (mirrors
// ProviderModelSelector's `emptyModelOption`). `ariaLabel` / `title` let an
// inline picker with no visible <label> stay accessible.
const defaultGetLabel = (m) => m.name;
export default function ModelSelect({
  models,
  value,
  onChange,
  getLabel = defaultGetLabel,
  id,
  className = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50',
  disabled = false,
  emptyOption,
  ariaLabel,
  title,
}) {
  const active = models.filter((m) => !m.deprecated);
  const legacy = models.filter((m) => m.deprecated);
  return (
    <select
      id={id}
      value={value}
      onChange={onChange}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className={className}
    >
      {emptyOption != null && <option value="">{emptyOption}</option>}
      {active.map((m) => <option key={m.id} value={m.id}>{getLabel(m)}</option>)}
      {legacy.length > 0 && (
        <optgroup label="Legacy">
          {legacy.map((m) => <option key={m.id} value={m.id}>{getLabel(m)}</option>)}
        </optgroup>
      )}
    </select>
  );
}
