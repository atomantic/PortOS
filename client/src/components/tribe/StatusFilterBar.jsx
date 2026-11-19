import { STATUS_FILTER_IDS, STATUS_FILTER_LABELS } from '../../lib/tribe.js';

// Care-state filter shared by the Care Queue and the Circle roster — the same
// buckets the summary tiles route into, so a tile click and this bar stay in sync.
export default function StatusFilterBar({ statusFilter, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Care filter">
      {STATUS_FILTER_IDS.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-pressed={statusFilter === id}
          className={`rounded-full border px-3 py-1 text-xs transition-colors ${
            statusFilter === id
              ? 'border-port-accent/70 bg-port-accent/10 text-port-accent'
              : 'border-port-border text-gray-400 hover:text-white'
          }`}
        >
          {STATUS_FILTER_LABELS[id]}
        </button>
      ))}
    </div>
  );
}
