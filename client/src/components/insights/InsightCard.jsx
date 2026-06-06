import ProvenanceChip from '../ui/ProvenanceChip';

// Generic card for an AI-generated or rule-derived insight. The header carries an
// optional confidence `badge` (how strong) and an optional `provenance` chip (how
// it was derived + what would change it) — the two answer different questions, so
// a card can show both. `provenance` is the shared source-chip affordance from the
// health views, surfaced here so every insight surface can declare "why am I seeing
// this?" without re-implementing the popover.
//
//   provenance: { level, label?, explainer?, whatWouldChange? }
//
// `level` is a provenance taxonomy id (data-backed | inferred | experimental |
// speculative); `explainer` / `whatWouldChange` override the per-level defaults for
// surface-specific copy (e.g. taste themes vs. health markers).
export default function InsightCard({ title, subtitle, badge, provenance, children, sources, className = '' }) {
  return (
    <div className={`bg-port-card border border-port-border rounded-lg p-4 ${className}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white truncate">{title}</h3>
          {subtitle && (
            <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
          )}
        </div>
        {(badge || provenance) && (
          <div className="shrink-0 flex items-center gap-1.5">
            {provenance && (
              <ProvenanceChip
                level={provenance.level}
                label={provenance.label}
                explainer={provenance.explainer}
                whatWouldChange={provenance.whatWouldChange}
              />
            )}
            {badge}
          </div>
        )}
      </div>

      {sources && sources.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2 mb-3">
          {sources.map((src, i) => (
            <span
              key={i}
              className="px-1.5 py-0.5 bg-gray-800 text-gray-400 rounded text-[10px] font-medium"
            >
              {src}
            </span>
          ))}
        </div>
      )}

      {children}
    </div>
  );
}
