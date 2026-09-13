import { useId } from 'react';
import { SERIES_DESIGN_FIELDS, SERIES_DESIGN_TEXT_MAX } from '../../../../../server/lib/storyArcLimits.js';

const HELP = {
  episodeActivity: 'What does the cast repeatedly do in an episode?',
  conflictSource: 'What makes that activity difficult or puts people at odds?',
  audiencePromise: 'What experience should an episode deliver to its audience?',
  continuingTensions: 'Which unresolved pressures can sustain varied stories?',
  endingCondition: 'What outcome would bring this story to its intended close?',
};

export default function SeriesDesignEditor({ value, onChange, readOnly = false }) {
  const id = useId();
  return (
    <fieldset disabled={readOnly} className="space-y-2 rounded border border-port-border p-3">
      <legend className="text-sm text-white">Series design (optional)</legend>
      <p className="text-xs text-gray-400">Your brief guides planning and review. AI keeps these choices as written.</p>
      <label htmlFor={`${id}-mode`} className="block text-xs text-gray-400">Story intent</label>
      <select id={`${id}-mode`} value={value?.mode || ''}
        onChange={(event) => onChange(event.target.value ? { ...value, mode: event.target.value } : null)}
        className="w-full rounded border border-port-border bg-port-bg p-2 text-sm text-white">
        <option value="">No brief</option>
        <option value="finite">Finite — working toward an ending</option>
        <option value="renewable">Renewable — recurring stories</option>
      </select>
      {value?.mode ? <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {Object.entries(SERIES_DESIGN_FIELDS).map(([field, label]) => (
          <div key={field}>
            <label htmlFor={`${id}-${field}`} className="block text-xs text-gray-400">{label}</label>
            <p id={`${id}-${field}-help`} className="text-xs text-gray-500">{HELP[field]}</p>
            <textarea id={`${id}-${field}`} aria-describedby={`${id}-${field}-help`} rows={2}
              value={value[field] || ''} maxLength={SERIES_DESIGN_TEXT_MAX}
              onChange={(event) => onChange({ ...value, [field]: event.target.value })}
              className="w-full rounded border border-port-border bg-port-bg p-2 text-sm text-white" />
          </div>
        ))}
      </div> : null}
    </fieldset>
  );
}
