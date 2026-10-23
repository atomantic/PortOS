import { useRunwayCatalog } from '../../hooks/useRunwayCatalog.js';

export default function RunwayModelSelect({ value, onChange, ariaLabel = 'Runway model', ...props }) {
  const { imageModels } = useRunwayCatalog();
  return (
    <select aria-label={ariaLabel} {...props} value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Runway default (Settings)</option>
      {value && !imageModels.some((m) => m.id === value) && <option value={value}>{value} (unavailable)</option>}
      {imageModels.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}{model.minReferences ? ' (requires reference)' : ''}
        </option>
      ))}
    </select>
  );
}
