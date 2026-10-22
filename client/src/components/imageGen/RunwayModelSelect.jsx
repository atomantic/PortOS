import { RUNWAY_IMAGE_MODELS } from '../../lib/imageGenBackends';

export default function RunwayModelSelect({ value, onChange, ...props }) {
  return (
    <select {...props} value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Runway default (Settings)</option>
      {RUNWAY_IMAGE_MODELS.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}{model.minReferences ? ' (requires reference)' : ''}
        </option>
      ))}
    </select>
  );
}
