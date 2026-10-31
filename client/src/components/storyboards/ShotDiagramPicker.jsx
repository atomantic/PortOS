import { Check } from 'lucide-react';
import ShotDiagram from './ShotDiagram';

/**
 * One panel shot choice (framing, angle, facing, composition) as tappable concept diagrams, so each
 * option shows what it looks like. Tapping the picked tile again clears it.
 */
export default function ShotDiagramPicker({ options, labels, hints, value, onChange, labelId }) {
  const current = value || null;
  return (
    <div>
      <div role="group" aria-labelledby={labelId} className="grid grid-cols-4 sm:grid-cols-6 gap-1">
        {options.map((type) => {
          const checked = current === type;
          return (
            <button key={type} type="button" aria-pressed={checked}
              onClick={() => onChange(checked ? null : type)}
              className={`relative min-w-0 rounded border p-0.5 text-left transition-colors ${checked
                ? 'border-port-accent bg-port-accent text-white ring-2 ring-port-accent'
                : 'border-port-border text-gray-300 hover:border-port-accent/50'}`}>
              {/* The drawing keeps its own backdrop and ink so it stays readable on the inverted tile. */}
              <span className="block rounded-sm bg-port-bg text-gray-300">
                <ShotDiagram kind={type} className="block w-full h-auto" />
              </span>
              <span className={`mt-0.5 block px-0.5 text-[10px] leading-tight ${checked ? 'font-semibold' : ''}`}>{labels[type] || type}</span>
              {checked && (
                <Check size={14} strokeWidth={3} aria-hidden="true"
                  className="absolute right-1 top-1 rounded-full bg-port-accent p-0.5 text-white" />
              )}
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
