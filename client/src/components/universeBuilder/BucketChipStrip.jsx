import { humanizeCategory } from '../../lib/universeBuilderShared';

// Pill-strip bucket selector for the Universe Builder trunk/other tabs. Renders
// an optional "All" pill, caller-supplied extra chips (e.g. the Canon
// pseudo-bucket), then one pill per real bucket. Extracted from
// UniverseBuilder.jsx (#2374). `setBucket('')` clears the selection.
export default function BucketChipStrip({ buckets, activeBucket, setBucket, showAll = true, extraChips = [] }) {
  if (buckets.length === 0 && extraChips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showAll && (
        <button
          type="button"
          onClick={() => setBucket('')}
          className={`px-2.5 py-1.5 rounded-full text-xs min-h-[32px] transition-colors ${
            !activeBucket
              ? 'bg-port-accent/25 text-port-accent border border-port-accent/40'
              : 'bg-port-bg text-gray-300 border border-port-border hover:border-gray-500'
          }`}
        >
          All
        </button>
      )}
      {extraChips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => setBucket(chip.key)}
          className={`px-2.5 py-1.5 rounded-full text-xs min-h-[32px] transition-colors ${
            activeBucket === chip.key
              ? 'bg-port-accent/25 text-port-accent border border-port-accent/40'
              : 'bg-port-bg text-gray-300 border border-port-border hover:border-gray-500'
          }`}
        >
          {chip.label}
        </button>
      ))}
      {buckets.map((bucket) => {
        const active = activeBucket === bucket;
        return (
          <button
            key={bucket}
            type="button"
            onClick={() => setBucket(active ? '' : bucket)}
            className={`px-2.5 py-1.5 rounded-full text-xs min-h-[32px] transition-colors ${
              active
                ? 'bg-port-accent/25 text-port-accent border border-port-accent/40'
                : 'bg-port-bg text-gray-300 border border-port-border hover:border-gray-500'
            }`}
          >
            {humanizeCategory(bucket)}
          </button>
        );
      })}
    </div>
  );
}
