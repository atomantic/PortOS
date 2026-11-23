import { falImageModelChoices, falImageModelGroups } from '../../lib/imageGenBackends';
import { useFalImageCatalog } from '../../hooks/useFalImageCatalog.js';

function ModelOptions({ models }) {
  return models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>);
}

// Both endpoints of a curated family stay selectable. A render that carries
// references still uses that family's edit endpoint when the text endpoint is
// pinned. A saved id the live list does not know stays visible. `editing`
// leads with the featured edit endpoints for an edit or refine.
export default function FalModelSelect({
  id, value = '', onChange, defaultLabel = 'Settings default', ariaLabel, className = '', disabled = false,
  editing = false,
}) {
  const catalog = useFalImageCatalog();
  const choices = falImageModelChoices(catalog.models);
  const selected = value || '';
  const orphaned = selected && !choices.some((model) => model.id === selected);
  const groups = falImageModelGroups(choices, { editing });
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
      {orphaned && <option value={selected}>{`${selected} (not in the fal.ai list)`}</option>}
      {groups.map((group) => (group.label
        ? <optgroup key={group.label} label={group.label}><ModelOptions models={group.models} /></optgroup>
        : <ModelOptions key="models" models={group.models} />))}
    </select>
  );
}
