import { RUNWAY_IMAGE_MODELS } from '../../lib/imageGenBackends';

export default function RunwayModelSelect({ value, onChange, ariaLabel = 'Runway model', ...props }) {
  return (
    <select aria-label={ariaLabel} {...props} value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Runway default (Settings)</option>
      {RUNWAY_IMAGE_MODELS.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}{model.minReferences ? ' (requires reference)' : ''}
        </option>
      ))}
    </select>
  );
}
