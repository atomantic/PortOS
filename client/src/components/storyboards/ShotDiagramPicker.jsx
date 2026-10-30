import ShotDiagram from './ShotDiagram';

/**
 * One panel shot choice (framing or angle) as tappable concept diagrams, so each
 * option shows what it looks like. Tapping the picked tile again clears it.
 */
export default function ShotDiagramPicker({ options, labels, hints, value, onChange, labelId }) {
  const current = value || null;
  return (
    <div>
      <div role="group" aria-labelledby={labelId} className="grid grid-cols-3 gap-1.5">
        {options.map((type) => {
          const checked = current === type;
          return (
            <button key={type} type="button" aria-pressed={checked}
              onClick={() => onChange(checked ? null : type)}
              className={`min-w-0 rounded-md border p-1 text-left transition-colors ${checked ? 'border-port-accent ring-1 ring-port-accent text-white' : 'border-port-border text-gray-300 hover:border-port-accent/50'}`}>
              <ShotDiagram kind={type} className="block w-full h-auto" />
              <span className="mt-0.5 block text-[11px] leading-tight">{labels[type] || type}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-gray-400">
        {current ? hints[current] || labels[current] || current : 'Not set. Tap one to pick it, tap it again to clear.'}
      </p>
    </div>
  );
}
