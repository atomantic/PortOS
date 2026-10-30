import { SHOT_TYPES, SHOT_TYPE_HINTS, SHOT_TYPE_LABELS } from '../../lib/shotGrammar';
import FramingDiagram from './FramingDiagram';

const OPTIONS = [null, ...SHOT_TYPES];

/** Framing choice as tappable concept diagrams, so each option shows what it looks like. */
export default function FramingPicker({ value, onChange, labelId }) {
  const current = value || null;
  return (
    <div>
      <div role="group" aria-labelledby={labelId} className="grid grid-cols-3 gap-1.5">
        {OPTIONS.map((type) => {
          const checked = current === type;
          const label = type ? SHOT_TYPE_LABELS[type] || type : 'Not set';
          return (
            <button key={type || 'none'} type="button" aria-pressed={checked}
              onClick={() => { if (!checked) onChange(type); }}
              className={`min-w-0 rounded-md border p-1 text-left transition-colors ${checked ? 'border-port-accent ring-1 ring-port-accent text-white' : 'border-port-border text-gray-300 hover:border-port-accent/50'}`}>
              <FramingDiagram framing={type} className="block w-full h-auto" />
              <span className="mt-0.5 block text-[11px] leading-tight">{label}</span>
            </button>
          );
        })}
      </div>
      {current && SHOT_TYPE_HINTS[current] ? (
        <p className="mt-1 text-xs text-gray-400">{SHOT_TYPE_HINTS[current]}</p>
      ) : null}
    </div>
  );
}
