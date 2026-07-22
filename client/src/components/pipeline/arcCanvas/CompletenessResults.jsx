import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { X, FileSearch, FileText } from 'lucide-react';
import { SEVERITY_COLORS } from './shared.js';

// Human-readable labels for the manuscript-completeness categories.
const COMPLETENESS_CATEGORY_LABELS = {
  'missing-content': 'Missing content',
  'arc-gap': 'Arc gaps',
  'character-gap': 'Character development',
  pacing: 'Pacing',
  continuity: 'Continuity',
  other: 'Other',
};
const COMPLETENESS_CATEGORY_ORDER = ['missing-content', 'arc-gap', 'character-gap', 'pacing', 'continuity', 'other'];

// Advisory findings panel for "finish the draft" — grouped by category, no
// resolve buttons (the suggestions guide manual authoring, not an LLM rewrite).
export default function CompletenessResults({ issues, onDismiss, seriesId }) {
  const grouped = useMemo(() => {
    const byCat = new Map();
    for (const iss of issues) {
      const cat = COMPLETENESS_CATEGORY_LABELS[iss.category] ? iss.category : 'other';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(iss);
    }
    return COMPLETENESS_CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => [c, byCat.get(c)]);
  }, [issues]);

  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white flex items-center gap-1.5">
          <FileSearch size={14} className="text-port-accent" />
          Finish the draft — {issues.length} suggestion{issues.length === 1 ? '' : 's'}
        </h3>
        <div className="flex items-center gap-3">
          {issues.length > 0 && seriesId ? (
            <Link
              to={`/pipeline/series/${seriesId}/manuscript`}
              className="text-xs text-port-accent hover:underline inline-flex items-center gap-1"
              title="Open the manuscript editor to act on these comments inline"
            >
              <FileText size={12} /> Open editor
            </Link>
          ) : null}
          <button type="button" onClick={onDismiss} aria-label="Close" className="text-gray-500 hover:text-white"><X size={16} /></button>
        </div>
      </div>
      {issues.length === 0 ? (
        <p className="text-xs text-gray-400">The manuscript reads as complete — no gaps found.</p>
      ) : (
        grouped.map(([cat, list]) => (
          <div key={cat} className="space-y-1">
            <span className="text-[11px] uppercase tracking-wider text-gray-500">{COMPLETENESS_CATEGORY_LABELS[cat]} ({list.length})</span>
            <ul className="space-y-1">
              {list.map((iss, i) => (
                <li key={i} className={`text-xs p-2 rounded border ${SEVERITY_COLORS[iss.severity] || SEVERITY_COLORS.medium}`}>
                  {iss.location ? <span className="font-medium">{iss.location}: </span> : null}
                  <span>{iss.problem}</span>
                  {iss.suggestion ? <p className="mt-1 text-gray-300"><span className="opacity-70">Suggestion: </span>{iss.suggestion}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
