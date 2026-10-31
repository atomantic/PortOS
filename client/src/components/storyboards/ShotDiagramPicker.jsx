import { Check } from 'lucide-react';
import ShotDiagram from './ShotDiagram';

/**
 * One panel shot choice (framing, angle, facing, composition) as tappable concept diagrams, so each
 * option shows what it looks like. Tapping the picked tile again clears it. The heading carries the
 * picked option's hint on the same line, and tiles fill the width at a fixed size from `sm` up, so a
 * wide side panel shows more of them per row instead of bigger ones.
 */
export default function ShotDiagramPicker({ label, options, labels, hints, value, onChange, labelId }) {
  const current = value || null;
  const hint = current ? hints[current] || labels[current] || current : 'Not set';
  return (
    <div>
      <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] sm:flex-nowrap">
        <span id={labelId} className="shrink-0 text-gray-500">{label}</span>
        <span className={`min-w-0 sm:truncate ${current ? 'text-gray-300' : 'text-gray-500'}`} title={hint}>{hint}</span>
      </div>
      <div role="group" aria-labelledby={labelId} className="grid grid-cols-4 sm:grid-cols-[repeat(auto-fill,minmax(4rem,1fr))] gap-1">
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
                <Check size={12} strokeWidth={3} aria-hidden="true"
                  className="absolute right-0.5 top-0.5 rounded-full bg-port-accent p-0.5 text-white" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
