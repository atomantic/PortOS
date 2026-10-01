import { FAL_IMAGE_MODEL_OPTIONS, falImageFamily } from '../../lib/imageGenBackends';

// The fal.ai image model picker. A select over the curated catalog rather than
// a text box: every id is a different price, and the server refuses an id the
// catalog does not list — a typo would otherwise only surface as a failed render.
// Either endpoint id of a family (text or /edit) selects that family's row; the
// provider picks the endpoint per render. A saved id outside the catalog (a
// hand edit, or a model a later build dropped) stays visible and selectable so
// the select never paints a pin the server is still reading as blank.
export default function FalModelSelect({
  id, value = '', onChange, defaultLabel = 'Settings default', ariaLabel, className = '', disabled = false,
}) {
  const family = falImageFamily(value);
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
      {orphaned && <option value={selected}>{`${selected} (not in the fal.ai catalog)`}</option>}
      {FAL_IMAGE_MODEL_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}
