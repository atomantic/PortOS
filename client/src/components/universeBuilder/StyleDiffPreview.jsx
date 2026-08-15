/**
 * Style-guide diff preview — renders the `{ diff, rationale }` shape the
 * server's `buildStyleReferenceDiff` produces (style-reference analysis and
 * mood-board style synthesis both return it), so every "review before adopt"
 * flow shows the same before/after. Extracted from UniverseStyleReferences
 * (#4188 Phase 4).
 */

function TokenDiff({ label, diff, tone }) {
  if (!diff?.changed) return null;
  const addedClass = tone === 'positive' ? 'text-port-success' : 'text-port-error';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {diff.removed.map((token) => (
          <span key={`removed-${token}`} className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-500 line-through">
            {token}
          </span>
        ))}
        {diff.added.map((token) => (
          <span key={`added-${token}`} className={`rounded bg-white/5 px-1.5 py-0.5 text-[11px] ${addedClass}`}>
            + {token}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function StyleDiffPreview({ analysis, description = 'Review this diff before deciding whether the reference should update the universe.' }) {
  const diff = analysis?.diff;
  if (!diff) return null;
  return (
    <section className="rounded-lg border border-port-border bg-port-bg/60 p-3 space-y-3">
      <div>
        <h3 className="text-sm font-medium text-white">Style guide preview</h3>
        <p className="text-xs text-gray-500">{description}</p>
      </div>
      {!diff.hasChanges ? (
        <p className="text-xs text-gray-400">The current guidance already matches this reference.</p>
      ) : null}
      {diff.styleNotes?.changed ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Current style notes</div>
            <p className="rounded border border-port-border p-2 text-xs text-gray-400 whitespace-pre-wrap">
              {diff.styleNotes.before || 'None'}
            </p>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-port-accent mb-1">Proposed style notes</div>
            <p className="rounded border border-port-accent/30 p-2 text-xs text-gray-200 whitespace-pre-wrap">
              {diff.styleNotes.after || 'Clear style notes'}
            </p>
          </div>
        </div>
      ) : null}
      <TokenDiff label="Positive guidance changes" diff={diff.influences?.embrace} tone="positive" />
      <TokenDiff label="Negative guidance changes" diff={diff.influences?.avoid} tone="negative" />
      {analysis.rationale ? <p className="text-xs text-gray-400">{analysis.rationale}</p> : null}
    </section>
  );
}
