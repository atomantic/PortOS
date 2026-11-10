// A select over a curated provider model catalog (fal.ai, Higgsfield) rather
// than a text box: every id is a different price and the server refuses an id
// the catalog does not list. Either endpoint id of a family selects its row; a
// saved id outside the catalog stays visible so the select never paints a pin
// the server is still reading as blank.
export default function CatalogModelSelect({
  id, value = '', onChange, options, familyOf, providerLabel, defaultLabel = 'Settings default', ariaLabel, className = '', disabled = false,
}) {
  const family = familyOf(value);
  const selected = family ? family.textEndpoint : (value || '');
  const orphaned = selected && !family;
  return (
    <select
      id={id}
      value={selected}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={ariaLabel}
      disabled={disabled}
      className={className}
    >
      <option value="">{defaultLabel}</option>
      {orphaned && <option value={selected}>{`${selected} (not in the ${providerLabel} catalog)`}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}
